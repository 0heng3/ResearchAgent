"""Fixed raw/SFT HF model provider for the unchanged native Agent. No grammar or argument repair."""
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from datetime import datetime,timezone
import json,os,sys,time,threading,uuid,urllib.request,traceback
W=Path(__file__).resolve().parents[1]
ALIAS='researchagent-scaffold-qwen7b'

def parse_completion(text):
 content=[];calls=[];pos=0;decoder=json.JSONDecoder()
 while '<tool_call>' in text[pos:]:
  start=text.index('<tool_call>',pos);content.append(text[pos:start]);tail=text[start+len('<tool_call>'):];body=tail.lstrip();spaces=len(tail)-len(body)
  try:obj,end=decoder.raw_decode(body)
  except ValueError:return text,[],False
  close=start+len('<tool_call>')+spaces+end
  gap=text[close:];skip=len(gap)-len(gap.lstrip());close+=skip
  if not text[close:].startswith('</tool_call>') or not isinstance(obj,dict) or not isinstance(obj.get('name'),str) or not isinstance(obj.get('arguments'),dict):return text,[],False
  calls.append({'id':'call_'+uuid.uuid4().hex,'type':'function','function':{'name':obj['name'],'arguments':json.dumps(obj['arguments'],ensure_ascii=False,separators=(',',':'))}})
  pos=close+len('</tool_call>')
 content.append(text[pos:])
 if '</tool_call>' in ''.join(content):return text,[],False
 return ''.join(content).strip(),calls,True

def render_messages(messages):
 # Only decode the OpenAI wire representation for the OFFICIAL template; never alias argument keys.
 result=json.loads(json.dumps(messages))
 for msg in result:
  if msg.get('content') is None:msg['content']=''
  if not isinstance(msg['content'],str):raise ValueError('Only the frozen text-only Agent interface is admitted')
  for call in msg.get('tool_calls',[]) or []:
   args=call['function'].get('arguments',{})
   if isinstance(args,str):call['function']['arguments']=json.loads(args)
 return result

def append(path,value):
 with path.open('a') as f:f.write(json.dumps(value,ensure_ascii=False)+'\n')

class Runtime:
 def __init__(self,cfg):
  import torch
  from transformers import AutoTokenizer,AutoModelForCausalLM
  self.cfg=cfg;self.torch=torch;self.arm=cfg['arm'];self.lock=threading.Lock();self.task=None;self.calls=0;self.started=None
  self.tokenizer=AutoTokenizer.from_pretrained(str(W/'model-metadata'),local_files_only=True)
  self.model=AutoModelForCausalLM.from_pretrained(str(W/'models/Qwen2.5-Coder-7B-Instruct'),torch_dtype=torch.bfloat16,device_map={'':0},attn_implementation='sdpa',low_cpu_mem_usage=True,local_files_only=True)
  self.model.eval();self.ready=True
 def bill(self,op,data):
  req=urllib.request.Request(self.cfg['ledgerUrl']+'/'+op,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+self.cfg['ledgerToken']})
  with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
 def begin(self,task,scaffold,workspace):
  if task not in ['SC000','SC001'] or scaffold not in ['native','mini']:raise ValueError('Unregistered run')
  expected=W/'evaluation'/scaffold/'runs'/task
  if Path(workspace).resolve()!=expected.resolve() or not expected.exists():raise ValueError('Unregistered workspace')
  self.arm=scaffold;self.workspace=expected;self.task=task;self.calls=0;self.started=time.monotonic()
 def generate(self,body,cancel,results):
  from transformers import StoppingCriteria,StoppingCriteriaList
  torch=self.torch;row=None;reservation=None;start=time.monotonic()
  try:
   if self.task is None or self.calls>=16 or time.monotonic()-self.started>=1200:raise RuntimeError('Registered student budget exhausted')
   if body.get('model')!=ALIAS:raise RuntimeError('Model alias differs from the frozen experiment')
   msgs=render_messages(body['messages']);tools=body.get('tools')
   text=self.tokenizer.apply_chat_template(msgs,tools=tools,tokenize=False,add_generation_prompt=True)
   inputs=self.tokenizer(text,add_special_tokens=False,return_tensors='pt').to('cuda:0');n=inputs.input_ids.shape[1]
   if n+4096>32768:raise RuntimeError('Student context capacity exceeded')
   self.calls+=1;attempt=self.calls;seed=2026102200+int(self.task[-3:])*100+attempt-1
   reservation=self.bill('reserve',{'model':ALIAS,'promptTokens':n,'maxOutputTokens':4096,'arm':self.arm,'task':self.task,'attempt':attempt})['reservationId']
   row={'atUtc':datetime.now(timezone.utc).isoformat(),'arm':self.arm,'task':self.task,'physicalCall':attempt,'seed':seed,'messages':body['messages'],'tools':tools,'promptTokens':n,'temperature':0.4,'topP':1,'maxOutputTokens':4096,'reservationId':reservation}
   class Stop(StoppingCriteria):
    def __call__(_,input_ids,scores,**kwargs):return torch.tensor([cancel.is_set() or time.monotonic()-self.started>=1200],device=input_ids.device)
   torch.manual_seed(seed);torch.cuda.manual_seed_all(seed)
   with torch.inference_mode():out=self.model.generate(**inputs,max_new_tokens=4096,do_sample=True,temperature=0.4,top_p=1.0,top_k=0,repetition_penalty=1.0,use_cache=True,pad_token_id=self.tokenizer.eos_token_id,stopping_criteria=StoppingCriteriaList([Stop()]))
   ids=out[0,n:];raw=self.tokenizer.decode(ids,skip_special_tokens=True);content,calls,parsed=parse_completion(raw) if tools else (raw,[],True);count=len(ids)
   usage={'prompt_tokens':n,'completion_tokens':count,'total_tokens':n+count}
   row.update(rawCompletion=raw,toolFormatParsed=parsed,completionTokens=count,usage=usage,wallSeconds=time.monotonic()-start,gpuAllocatedPeakBytes=torch.cuda.max_memory_allocated(),apiCostUsd=0,cancelled=cancel.is_set())
   self.bill('settle',{'reservationId':reservation,'model':ALIAS,'promptTokens':n,'completionTokens':count,'route':'A100x2.local.'+self.arm})
   append(W/'artifacts'/('model-'+self.arm+'-requests.jsonl'),row)
   delta={'content':content}
   if calls:delta['tool_calls']=[dict(c,index=i) for i,c in enumerate(calls)]
   results.update(delta=delta,usage=usage,finishReason='tool_calls' if calls else ('length' if count>=4096 else 'stop'))
  except Exception as e:
   if reservation:
    try:self.bill('release',{'reservationId':reservation,'model':ALIAS,'route':'A100x2.local.'+self.arm,'error':type(e).__name__,'uncertain':True})
    except Exception:pass
   error={'arm':self.arm,'task':self.task,'error':type(e).__name__+': '+str(e),'atUtc':datetime.now(timezone.utc).isoformat(),'wallSeconds':time.monotonic()-start}
   if row:row.update(error=error);append(W/'artifacts'/('model-'+self.arm+'-requests.jsonl'),row)
   else:append(W/'artifacts'/('model-'+self.arm+'-rejections.jsonl'),error)
   results['error']=error['error']
  finally:
   if 'inputs' in locals():del inputs
   if 'out' in locals():del out
   torch.cuda.empty_cache();results['done']=True

class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,code,obj):
  b=json.dumps(obj).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  if self.path in ['/models','/v1/models']:return self.reply(200,{'object':'list','data':[{'id':ALIAS,'object':'model','owned_by':'self-hosted'}]})
  if self.path=='/health':return self.reply(200,{'ready':self.server.runtime.ready,'model':ALIAS,'arm':self.server.runtime.arm})
  self.reply(404,{'error':'Unknown endpoint'})
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  rt=self.server.runtime
  if self.path=='/activate':
   if rt.lock.locked():return self.reply(409,{'error':'Previous generation still active'})
   rt.begin(body['task'],body['scaffold'],body['workspace']);return self.reply(200,{'task':rt.task})
  if self.path not in ['/v1/chat/completions','/chat/completions']:return self.reply(404,{'error':'Unknown endpoint'})
  if not rt.lock.acquire(blocking=False):return self.reply(409,{'error':'Sequential experiment only'})
  cancel=threading.Event();results={};worker=threading.Thread(target=rt.generate,args=(body,cancel,results));worker.start()
  try:
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-cache');self.end_headers()
   while not results.get('done'):
    self.wfile.write(b': waiting for fixed local model\n\n');self.wfile.flush();worker.join(timeout=10)
   if 'error' in results:self.wfile.write(('data: '+json.dumps({'error':results['error']})+'\n\n').encode())
   else:
    chunk={'id':'chatcmpl_'+uuid.uuid4().hex,'object':'chat.completion.chunk','model':ALIAS,'choices':[{'index':0,'delta':results['delta'],'finish_reason':None}]}
    self.wfile.write(('data: '+json.dumps(chunk,ensure_ascii=False)+'\n\n').encode())
    final={'model':ALIAS,'choices':[{'index':0,'delta':{},'finish_reason':results['finishReason']}],'usage':results['usage']}
    self.wfile.write(('data: '+json.dumps(final)+'\n\ndata: [DONE]\n\n').encode())
   self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):cancel.set()
  finally:worker.join();rt.lock.release()

if __name__=='__main__':
 cfg=json.loads(sys.stdin.readline());runtime=Runtime(cfg);server=ThreadingHTTPServer(('127.0.0.1',cfg['port']),Handler);server.runtime=runtime
 print('MODEL_SERVICE_READY',json.dumps({'arm':runtime.arm,'pid':os.getpid(),'port':cfg['port']}),flush=True);server.serve_forever()
