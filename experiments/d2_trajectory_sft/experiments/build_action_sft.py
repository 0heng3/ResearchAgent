"""Build verified assistant-action SFT records from real native Agent trajectories.
No model weights loaded, no CUDA, no synthetic repaired code, no held-out use.
"""
from pathlib import Path
from collections import Counter
import json,hashlib,re,sys
ROOT=Path(__file__).resolve().parents[1]
def dump(p,j):p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(j,indent=2,ensure_ascii=False))
def normal_messages(messages):
 result=[]
 for raw in messages:
  m=dict(raw);m['content']=m.get('content') or ''
  if m.get('role')=='system':m['content']=m['content'].replace('key2:deepseek-flash','student:scientific-student').replace('deepseek-flash','scientific-student')
  if m.get('tool_calls'):
   calls=[]
   for c in m['tool_calls']:
    c=dict(c);f=dict(c['function']);a=f.get('arguments',{})
    if isinstance(a,str):a=json.loads(a)
    f['arguments']=a;c['function']=f;calls.append(c)
   m['tool_calls']=calls
  result.append(m)
 return result

def response(record):
 groups={};content=''
 for event in record.get('providerEvents',[]):
  for choice in event.get('choices',[]):
   d=choice.get('delta',choice.get('message',{}));content+=d.get('content') or ''
   for c in d.get('tool_calls',[]) or []:
    g=groups.setdefault(c.get('index',0),{'id':'','name':'','arguments':''});g['id']+=c.get('id','');g['name']+=c.get('function',{}).get('name','');g['arguments']+=c.get('function',{}).get('arguments','')
 calls=[{'id':g['id'],'type':'function','function':{'name':g['name'],'arguments':json.loads(g['arguments'])}} for g in groups.values()]
 return {'role':'assistant','content':content,'tool_calls':calls},calls

def build():
 from transformers import AutoTokenizer
 tok=AutoTokenizer.from_pretrained(ROOT/'model-metadata',local_files_only=True)
 protocol=json.loads((ROOT/'artifacts/protocol.json').read_text());records=[json.loads(x) for x in (ROOT/'artifacts/physical-model-requests.jsonl').read_text().splitlines()];examples=[];reviews=[]
 for ident in protocol['trainTaskIds']:
  verdict_path=ROOT/'artifacts/verification'/f'{ident}.json'
  if not verdict_path.exists():reviews.append({'task':ident,'accepted':False,'reason':'teacher_not_completed'});continue
  verdict=json.loads(verdict_path.read_text());task_records=[r for r in records if r['taskId']==ident]
  if not verdict['verifiedSuccess']:reviews.append({'task':ident,'accepted':False,'reason':'scientific_or_delivery_verification_failed'});continue
  decoded=[]
  for record in task_records:
   try:assistant,calls=response(record)
   except (ValueError,KeyError) as e:reviews.append({'task':ident,'physicalCall':record['physicalAttempt'],'accepted':False,'reason':'raw_teacher_protocol_not_parseable'});continue
   decoded.append((record,assistant,calls))
  phases={}
  for item in decoded:
   record,assistant,calls=item
   if 'inspection' not in phases and any(c['function']['name'] in ['cog_read','cog_bash'] for c in calls):phases['inspection']=item
   if 'planning' not in phases and any(c['function']['name']=='cog_todo_write' for c in calls):phases['planning']=item
   for c in calls:
    f=c['function'];a=f['arguments'];p=a.get('path','')
    if f['name'] in ['cog_write','cog_edit'] and str(p).endswith('.py'):
     actual=ROOT/'runs'/ident/p
     if Path(p).is_absolute():actual=Path(p)
     if not actual.resolve().is_relative_to((ROOT/'runs'/ident).resolve()):continue
     # Failed early full-file writes are NOT positive labels: match final bytes.
     if f['name']=='cog_write' and (not actual.is_file() or actual.read_text()!=a.get('content')):continue
     if actual.is_file():phases['code']=item
   if any(c['function']['name']=='cog_experiment_run' for c in calls):phases['execution']=item
  if 'code' not in phases or 'execution' not in phases:reviews.append({'task':ident,'accepted':False,'reason':'no_verified_source_action_or_experiment_action'});continue
  if phases['execution'][0]['physicalAttempt']<phases['code'][0]['physicalAttempt']:reviews.append({'task':ident,'accepted':False,'reason':'last_source_not_followed_by_actual_experiment'});continue
  accepted=0
  for phase in ['inspection','planning','code','execution']:
   if phase not in phases:continue
   record,assistant,calls=phases[phase];messages=normal_messages(record['requestBody']['messages']);gold=normal_messages([assistant])[0];tools=record['requestBody'].get('tools',[])
   prefix=tok.apply_chat_template(messages,tools=tools,tokenize=True,add_generation_prompt=True)
   full=tok.apply_chat_template(messages+[gold],tools=tools,tokenize=True,add_generation_prompt=False)
   if full[:len(prefix)]!=prefix:raise RuntimeError('Chat template prefix mismatch; do not guess a loss boundary')
   if len(full)>24576:reviews.append({'task':ident,'phase':phase,'accepted':False,'reason':'preregistered_sequence_limit','tokens':len(full)});continue
   label_count=len(full)-len(prefix);assert label_count>0
   examples.append({'task':ident,'phase':phase,'physicalCall':record['physicalAttempt'],'messages':messages+[gold],'tools':tools,'promptTokens':len(prefix),'supervisedAssistantTokens':label_count,'totalTokens':len(full),'teacherTaskNumericallyVerified':True,'heldoutDataUsed':False,'lossBoundary':len(prefix)});accepted+=1
  reviews.append({'task':ident,'accepted':True,'selectedAssistantStates':accepted,'scientificVerificationSha256':hashlib.sha256(verdict_path.read_bytes()).hexdigest()})
 path=ROOT/'artifacts/training/verified-action-sft.jsonl';path.parent.mkdir(parents=True,exist_ok=True)
 with path.open('w') as f:
  for e in examples:f.write(json.dumps(e,ensure_ascii=False)+'\n')
 summary={'stage':'VERIFIED_DATA_PREPARED_NOT_MODEL_TRAINED','teacherTasks':len(protocol['trainTaskIds']),'verifiedTeacherTrajectories':sum(r.get('accepted',False) and 'selectedAssistantStates' in r for r in reviews),'assistantActionExamples':len(examples),'phaseCounts':dict(Counter(e['phase'] for e in examples)),'totalInputAndTargetTokens':sum(e['totalTokens'] for e in examples),'totalSupervisedAssistantTokens':sum(e['supervisedAssistantTokens'] for e in examples),'minSequenceTokens':min([e['totalTokens'] for e in examples],default=0),'maxSequenceTokens':max([e['totalTokens'] for e in examples],default=0),'loss':'L=-sum over supervised assistant-action tokens log p(token | actual prior messages, tools and observations). Prefix / tool-observation labels are -100.','chatTemplatePrefixChecksPassed':len(examples),'studentModelRevision':protocol['student']['revision'],'datasetSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'failedEarlySourceTargetsExcluded':True,'heldoutTasksInDataset':0,'studentInferenceCalls':0,'studentWeightsLoaded':False,'gradientUpdates':0,'algorithmGainEstablished':False,'reviews':reviews}
 dump(ROOT/'artifacts/training/DATASET_RESULTS.json',summary);print('D2_DATASET_RESULTS',json.dumps({k:v for k,v in summary.items() if k!='reviews'}),flush=True)
if __name__=='__main__':build()
