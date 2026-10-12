"""Transport-only completer for the exact official local-file SimpleJudge.
Uses the same priced proxy as the Agent; grading prompts/weights remain official.
"""
from __future__ import annotations
import sys,os,types,json,asyncio
from pathlib import Path
import httpx
from pydantic import BaseModel
BENCH=Path(__file__).resolve().parent
PROJECT=BENCH/'official/project'
sys.path[:0]=[str(PROJECT/'paperbench'),str(PROJECT/'common/preparedness_turn_completer')]
os.environ['PAPERBENCH_DATA_DIR']=str(PROJECT/'paperbench/data')
# Optional remote-computer type imports pull Unix-only resource machinery.
# None of these types is instantiated in local-file Code-Dev scoring.
shim=types.ModuleType('nanoeval.solvers.computer_tasks.code_execution_interface')
class UnavailableRemoteComputer:
    def __init__(self,*a,**k):raise RuntimeError('This benchmark uses local-file scoring, not remote ComputerInterface')
shim.ComputerInterface=UnavailableRemoteComputer;shim.ExecutionResult=UnavailableRemoteComputer
sys.modules[shim.__name__]=shim
from preparedness_turn_completer.turn_completer import TurnCompleter
from openai.types.chat import ChatCompletionMessage
from paperbench.judge.simple import SimpleJudge,ParsedJudgeResponseInt,ParsedJudgeResponseFloat
from paperbench.rubric.tasks import TaskNode
from paperbench.paper_registry import paper_registry


def connection():
    values={}
    for line in (BENCH/'.env').read_text(encoding='utf8').splitlines():
        if '=' in line:k,v=line.split('=',1);values[k]=v
    return values['BENCH_BASE_URL'],values['BENCH_PROXY_API_KEY']


class MeteredCompleter(TurnCompleter):
    encoding_name='o200k_base' # surrogate only for prompt packing; billing uses provider usage
    n_ctx=100000
    class Config(TurnCompleter.Config):
        schema_kind:str|None=None
        def build(self):return MeteredCompleter(self.schema_kind)
    def __init__(self,schema_kind=None):self.schema_kind=schema_kind;self.model='deepseek-flash'
    def payload(self,conversation):
        messages=[dict(x) for x in conversation]
        body={'model':self.model,'messages':messages,'stream':False,'max_tokens':8192,'temperature':0}
        if self.schema_kind:
            cls=ParsedJudgeResponseInt if self.schema_kind=='int' else ParsedJudgeResponseFloat
            # This only specifies the JSON response shape. The original parser
            # prompt and score/range validation are left unchanged.
            messages.append({'role':'system','content':'Return a JSON object conforming to this schema: '+json.dumps(cls.model_json_schema())})
            body['response_format']={'type':'json_object'}
        return body
    def finish(self,data,conversation):
        content=data['choices'][0]['message'].get('content')
        return TurnCompleter.Completion(input_conversation=conversation,output_messages=[ChatCompletionMessage(role='assistant',content=content)])
    def completion(self,conversation,**params):
        base,key=connection()
        with httpx.Client(timeout=330) as client:
            r=client.post(base+'/v1/chat/completions',headers={'Authorization':'Bearer '+key},json=self.payload(conversation));r.raise_for_status()
        return self.finish(r.json(),conversation)
    async def async_completion(self,conversation,**params):
        base,key=connection()
        async with httpx.AsyncClient(timeout=330) as client:
            r=await client.post(base+'/v1/chat/completions',headers={'Authorization':'Bearer '+key},json=self.payload(conversation));r.raise_for_status()
        return self.finish(r.json(),conversation)


def leaves(task):return [task] if task.is_leaf() else [z for t in task.sub_tasks for z in leaves(t)]


async def judge(paper_id,submission,out):
    Path(out).mkdir(parents=True,exist_ok=True)
    paper=paper_registry.get_paper(paper_id)
    rubric=TaskNode.from_dict(json.loads(paper.rubric.read_text()))
    rubric=rubric.code_only() or rubric.set_task_category('Code Development').set_sub_tasks([])
    cls=SimpleJudge(paper_path=paper.paper_pdf,rubric=rubric,addendum=paper.addendum.read_text() if paper.addendum.exists() else None,judge_addendum=paper.judge_addendum.read_text() if paper.judge_addendum.exists() else None,submission_dir=Path(submission),paper_md=paper.paper_md,completer_config=MeteredCompleter.Config(),int_completer_config=MeteredCompleter.Config(schema_kind='int'),float_completer_config=MeteredCompleter.Config(schema_kind='float'),log_path=Path(out),max_depth=999,code_only=True,computer=None)
    cls.leaf_semaphore=asyncio.Semaphore(2)
    tree=await cls.judge()
    all_leaves=leaves(tree);invalid=[x for x in all_leaves if not x.valid_score]
    result={'paperId':paper_id,'score':tree.score,'scorePercent':tree.score*100,'codeOnly':True,'leafCount':len(all_leaves),'invalidLeafCount':len(invalid),'allLeafScoresValid':not invalid,'judgeModel':'deepseek-flash','officialJudgeModel':False,'gradedTaskTree':tree.to_dict(),'adaptations':['Exact official SimpleJudge and official code_only weights','Local-file scoring; optional remote-computer type imports shimmed; never instantiated','OpenAI-compatible DeepSeek transport and JSON-object schema formatting; surrogate o200k tokenizer/context100000 for packing','No official judge-token accounting claim; all physical usage/cost comes from shared proxy records']}
    out=Path(out);out.mkdir(parents=True,exist_ok=True);(out/'code-dev-grade.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print('CODE_DEV_GRADE '+json.dumps({k:v for k,v in result.items() if k!='gradedTaskTree'}),flush=True)


if __name__=='__main__':asyncio.run(judge(sys.argv[1],sys.argv[2],sys.argv[3]))
