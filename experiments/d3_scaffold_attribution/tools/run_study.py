"""D3 two-task, fixed-model, balanced-order complete-Agent scaffold attribution."""
from pathlib import Path
from datetime import datetime,timezone
import json,os,sys,time,signal,subprocess,socket,urllib.request
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'experiments'));import science as e
PY=str(W/'.venv-train/bin/python');server=None
ENV=dict(os.environ,HOME=str(W/'home'),TMPDIR=str(W/'tmp'),TMP=str(W/'tmp'),TEMP=str(W/'tmp'),XDG_CACHE_HOME=str(W/'cache'),HF_HOME=str(W/'cache/huggingface'),TORCH_HOME=str(W/'cache/torch'),TORCH_EXTENSIONS_DIR=str(W/'cache/torch_extensions'),TORCHINDUCTOR_CACHE_DIR=str(W/'cache/inductor'),TRITON_CACHE_DIR=str(W/'cache/triton'),CUDA_CACHE_PATH=str(W/'cache/cuda'),MPLCONFIGDIR=str(W/'cache/matplotlib'),PYTHONPATH=str(W/'vendor'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',TOKENIZERS_PARALLELISM='false')
def now():return datetime.now(timezone.utc).isoformat()
def progress(stage,**kw):
 x={'status':stage,'atUtc':now(),'pid':os.getpid(),'root':str(W),'productionResearchGoalAchieved':False,**kw};e.dump(W/'artifacts/progress.json',x);print('D3_PROGRESS',json.dumps(x),flush=True)
def freeze_check():
 p=json.loads((W/'artifacts/protocol.json').read_text());assert all(e.sha(W/k)==v for k,v in p['sources'].items());assert all(e.sha(W/k)==v for k,v in p['inputHashes'].items());assert e.sha(W/'artifacts/tasks.json')==p['tasksSha256'];e.baseline_check()
def gpu_eligible():
 row=subprocess.check_output(['nvidia-smi','--query-gpu=index,uuid,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True).splitlines()[0].split(',');row=[x.strip() for x in row];apps=subprocess.check_output(['nvidia-smi','--query-compute-apps=gpu_uuid,pid','--format=csv,noheader'],text=True)
 if row[0]!='0' or int(row[2])>100 or row[1] in apps:raise RuntimeError('GPU0 has non-project allocation; no sharing/takeover')
 e.dump(W/'artifacts/gpu-at-start.json',{'atUtc':now(),'snapshot':row,'computeApps':apps,'note':'eligibility depends on allocation/processes; recent util sampling alone is not ownership'});return row[1]
def http(port,path,obj=None):
 q=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(obj).encode() if obj is not None else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(q,timeout=20) as r:return json.load(r)
def setup(scaffold):
 a=W/'evaluation'/scaffold;a.mkdir(parents=True,exist_ok=False)
 for n in ['runs','logs','artifacts/task-starts','artifacts/task-runs','artifacts/verification']:(a/n).mkdir(parents=True)
 for n in ['vendor','.venv-train','snapshot','reference']:(a/n).symlink_to(W/n,target_is_directory=True)
 for n in ['tasks.json','baseline-source.json']:(a/'artifacts'/n).symlink_to(W/'artifacts'/n)
 return a
def records(scaffold,task):
 p=W/'artifacts'/('model-'+scaffold+'-requests.jsonl');return [x for x in map(json.loads,p.read_text().splitlines()) if x['task']==task] if p.exists() else []
def stop_server():
 global server
 if server and server.poll() is None:
  assert os.getpgid(server.pid)==server.pid;os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=30)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 server=None
def main():
 global server
 cfg=json.loads(sys.stdin.readline());freeze_check();gpu=gpu_eligible();a={x:setup(x) for x in ['native','mini']};s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();allocated=time.monotonic();progress('LOADING_SHARED_RAW_MODEL')
 out=(W/'logs/shared-model-server.log').open('w');server=subprocess.Popen([PY,'-u',str(W/'tools/shared_model_server.py')],cwd=W,env=dict(ENV,CUDA_VISIBLE_DEVICES=gpu),stdin=subprocess.PIPE,stdout=out,stderr=subprocess.STDOUT,text=True,start_new_session=True);server.stdin.write(json.dumps(dict(cfg,port=port,arm='shared'))+'\n');server.stdin.close()
 for _ in range(300):
  if server.poll() is not None:raise RuntimeError('Shared model service failed')
  try:
   if http(port,'/health')['ready']:break
  except (OSError,ValueError):pass
  time.sleep(3)
 else:raise RuntimeError('Shared model load timeout')
 rows=[];order=[('SC000','native'),('SC000','mini'),('SC001','mini'),('SC001','native')]
 try:
  for task,scaffold in order:
   freeze_check();r=a[scaffold]/'runs'/task;r.mkdir();http(port,'/activate',{'task':task,'scaffold':scaffold,'workspace':str(r)});progress('AGENT_RUNNING',task=task,scaffold=scaffold,completed=len(rows),modelPid=server.pid)
   log=(W/'logs'/f'{scaffold}-{task}-launcher.log').open('w');p=subprocess.Popen([PY,'-u',str(W/'tools/run_one.py'),task,scaffold],cwd=W,env=dict(ENV,CUDA_VISIBLE_DEVICES=''),stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,text=True,start_new_session=True);p.stdin.write(json.dumps({'modelUrl':f'http://127.0.0.1:{port}'})+'\n');p.stdin.close()
   try:rc=p.wait(timeout=1280)
   except subprocess.TimeoutExpired:
    assert os.getpgid(p.pid)==p.pid;os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=20);raise RuntimeError('Outer agent launcher hung')
   if rc:raise RuntimeError('Agent launcher infrastructure failure; do not repeat task')
   stats=json.loads((a[scaffold]/'artifacts/task-runs'/f'{task}.json').read_text());e.ROOT=a[scaffold]
   try:v=e.verify(task)
   finally:e.ROOT=W
   rr=records(scaffold,task);errors=[x for x in rr if x.get('error')];rejections=W/'artifacts'/('model-'+scaffold+'-rejections.jsonl');rejects=[x for x in map(json.loads,rejections.read_text().splitlines()) if x.get('task')==task] if rejections.exists() else []
   infrastructure=[x for x in errors+rejects if not any(z in str(x.get('error')) for z in ['Registered student budget exhausted','Student context capacity exceeded'])]
   escape=(r/'artifacts/protocol-escape.json').exists();valid=not infrastructure and not escape and (stats['exitCode']==0 or stats['timedOut'])
   row={'task':task,'scaffold':scaffold,'protocolValid':valid,'verifiedSuccess':bool(v['verifiedSuccess']) and valid,'scientificSuccess':v['agentProducedOutputCheck']['success'],'sourceReplayCorrect':bool(v['independentReplay'] and v['independentReplay'].get('success')),'sourceFiles':stats['sourceFiles'],'timeToFirstSourceSeconds':stats['timeToFirstSourceSeconds'],'wallSeconds':stats['wallSeconds'],'physicalCalls':len(rr),'promptTokens':sum(x.get('promptTokens',0) for x in rr),'completionTokens':sum(x.get('completionTokens',0) for x in rr),'timedOut':stats['timedOut'],'escape':escape,'infrastructureErrors':len(infrastructure),'apiCostUsd':0,'verificationPath':str(a[scaffold]/'artifacts/verification'/f'{task}.json')};rows.append(row);e.dump(W/'artifacts/results.json',{'rows':rows,'completed':len(rows),'atUtc':now()});print('D3_TASK_RESULT',json.dumps(row),flush=True)
   if not valid:raise RuntimeError('Protocol invalid; preserve this run, no replacement')
 finally:stop_server()
 freeze_check();summary={x:{'validRuns':sum(r['scaffold']==x and r['protocolValid'] for r in rows),'verifiedSuccess':sum(r['scaffold']==x and r['verifiedSuccess'] for r in rows),'totalTasks':2,'sourceProducingTasks':sum(r['scaffold']==x and bool(r['sourceFiles']) for r in rows),'physicalCalls':sum(r['physicalCalls'] for r in rows if r['scaffold']==x),'totalTokens':sum(r['promptTokens']+r['completionTokens'] for r in rows if r['scaffold']==x),'wallSeconds':sum(r['wallSeconds'] for r in rows if r['scaffold']==x)} for x in ['native','mini']}
 result={'status':'COMPARISON_COMPLETE','atUtc':now(),'rows':rows,'summary':summary,'researchQuestion':'Fixed raw7B complete scientific tasks: native full system vs official mini2.4.6 default system','claimScope':'Exploratory2 paired tasks; whole-system attribution only, not isolated prompt/module causal claim or production-model improvement','gpuAllocationWallSeconds':time.monotonic()-allocated,'gpuHours':(time.monotonic()-allocated)/3600,'apiCostUsd':0,'gpuMonetaryCostUnknown':True,'trainingUpdates':0,'productionAgentModified':False,'productionResearchGoalAchieved':False};e.dump(W/'artifacts/FINAL_RESULTS.json',result);progress('COMPARISON_COMPLETE',summary=summary)
if __name__=='__main__':
 try:main()
 except Exception as ex:stop_server();e.dump(W/'artifacts/ERROR.json',{'atUtc':now(),'error':type(ex).__name__+': '+str(ex),'noAutomaticRerun':True});progress('BLOCKED_OR_FAILED',error=type(ex).__name__+': '+str(ex));raise
