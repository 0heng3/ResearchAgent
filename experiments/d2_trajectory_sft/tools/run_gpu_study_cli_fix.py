"""One frozen GPU study: download -> raw complete Agent -> conditional final-only SFT -> same Agent."""
from pathlib import Path
from datetime import datetime,timezone
import json,os,sys,time,signal,subprocess,socket,urllib.request,hashlib
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'experiments'));import d2_science as e
PY=str(W/'.venv-train/bin/python');server=None;GPU_UUID=None
BASE_ENV=dict(os.environ,HOME=str(W/'home'),TMPDIR=str(W/'tmp'),TMP=str(W/'tmp'),TEMP=str(W/'tmp'),XDG_CACHE_HOME=str(W/'cache'),HF_HOME=str(W/'cache/huggingface'),HF_HUB_CACHE=str(W/'cache/huggingface/hub'),HF_DATASETS_CACHE=str(W/'cache/datasets'),TRANSFORMERS_CACHE=str(W/'cache/transformers'),TORCH_HOME=str(W/'cache/torch'),TORCH_EXTENSIONS_DIR=str(W/'cache/torch_extensions'),TORCHINDUCTOR_CACHE_DIR=str(W/'cache/inductor'),TRITON_CACHE_DIR=str(W/'cache/triton'),CUDA_CACHE_PATH=str(W/'cache/cuda'),MPLCONFIGDIR=str(W/'cache/matplotlib'),PYTHONPATH=str(W/'vendor'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',TOKENIZERS_PARALLELISM='false')
def stamp():return datetime.now(timezone.utc).isoformat()
def progress(status,**fields):
 obj={'status':status,'atUtc':stamp(),'pid':os.getpid(),'workspace':str(W),'studentModel':'Qwen/Qwen2.5-Coder-7B-Instruct','researchGoalAchieved':False,**fields};e.dump(W/'artifacts/gpu-stage-progress.json',obj);print('D2_GPU_STAGE',json.dumps(obj),flush=True)
def freeze_check():
 f=json.loads((W/'artifacts/gpu-stage-source-freeze.json').read_text());p=json.loads((W/'artifacts/protocol.json').read_text());assert e.sha(W/'artifacts/protocol.json')==f['protocolSha256'];assert e.sha(W/'artifacts/training/verified-action-sft.jsonl')==f['datasetSha256']
 assert all(e.sha(W/k)==h for k,h in f['sources'].items());assert all(e.sha(W/k)==h for k,h in p['sourceHashes'].items());assert all(e.sha(W/k)==h for k,h in p['inputHashes'].items());assert e.sha(W/'artifacts/tasks.json')==p['taskHash'];e.baseline_check()
 amended=json.loads((W/'artifacts/gpu-cli-fix-source-freeze-20261012.json').read_text());assert all(e.sha(W/k)==h for k,h in amended['additionalSources'].items())
 assert e.sha(W/'artifacts/gpu-stage-source-freeze.json')==amended['originalFreezeSha256']
def free_gpu():
 lines=subprocess.check_output(['nvidia-smi','--query-gpu=index,uuid,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True).splitlines();row=[x.strip() for x in lines[0].split(',')];apps=subprocess.check_output(['nvidia-smi','--query-compute-apps=gpu_uuid,pid','--format=csv,noheader'],text=True)
 if row[0]!='0' or int(row[2])>100 or int(row[3])!=0 or row[1] in apps:raise RuntimeError('GPU0 is no longer safely unoccupied; no takeover/sharing')
 e.dump(W/'artifacts'/('gpu0-allocation-'+str(int(time.time()))+'.json'),{'utc':stamp(),'gpu':row,'computeApps':apps});return row[1]
def request(port,path,payload=None):
 req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
def stop_server():
 global server
 if server and server.poll() is None:
  assert os.getpgid(server.pid)==server.pid;os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=30)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 server=None

def start_server(arm,cfg):
 global server,GPU_UUID
 GPU_UUID=free_gpu();sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
 out=(W/'logs'/('student-'+arm+'-model-server.log')).open('a')
 server=subprocess.Popen([PY,'-u',str(W/'tools/student_model_server.py')],cwd=W,env=dict(BASE_ENV,CUDA_VISIBLE_DEVICES=GPU_UUID),stdin=subprocess.PIPE,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True)
 server.stdin.write(json.dumps(dict(cfg,arm=arm,port=port))+'\n');server.stdin.close();deadline=time.monotonic()+900
 while time.monotonic()<deadline:
  if server.poll() is not None:raise RuntimeError('Student model service exited during loading')
  try:
   if request(port,'/health')['ready']:return port
  except (OSError,ValueError):pass
  time.sleep(3)
 raise RuntimeError('Student model service did not become ready')
def arm_setup(arm):
 a=W/'evaluation-cli-fix'/arm;a.mkdir(parents=True,exist_ok=False)
 for d in ['runs','logs','artifacts/task-starts','artifacts/task-runs','artifacts/verification']:(a/d).mkdir(parents=True)
 for name in ['vendor','.venv-train','snapshot','reference']:(a/name).symlink_to(W/name,target_is_directory=True)
 for name in ['tasks.json','baseline-source.json']:(a/'artifacts'/name).symlink_to(W/'artifacts'/name)
 return a

def run_arm(arm,cfg):
 freeze_check();a=arm_setup(arm);armStart=time.monotonic();progress('LOADING_'+arm.upper());port=start_server(arm,cfg);rows=[]
 try:
  for ident in ['EV000','EV001','EV002','EV003']:
   freeze_check();request(port,'/activate',{'task':ident});progress(arm.upper()+'_AGENT_RUNNING',task=ident,completed=len(rows),modelServerPid=server.pid,gpuUuid=GPU_UUID)
   log=(W/'logs'/('student-'+arm+'-'+ident+'-launcher.log')).open('a')
   runner=subprocess.Popen([PY,'-u',str(W/'tools/run_student_one_cli_fix.py'),ident,arm],cwd=W,env=dict(BASE_ENV,CUDA_VISIBLE_DEVICES=''),stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,text=True,start_new_session=True)
   runner.stdin.write(json.dumps({'relayUrl':f'http://127.0.0.1:{port}','relayToken':'local-self-hosted-no-api-key'})+'\n');runner.stdin.close()
   try:exitcode=runner.wait(timeout=1280)
   except subprocess.TimeoutExpired:
    assert os.getpgid(runner.pid)==runner.pid;os.killpg(runner.pid,signal.SIGTERM);runner.wait(timeout=20);raise RuntimeError('Student runner exceeded outer protocol watchdog')
   if exitcode:raise RuntimeError('Student launcher failed; preserve task instead of rerunning')
   stats=json.loads((a/'artifacts/task-runs'/f'{ident}.json').read_text())
   e.ROOT=a
   try:v=e.verify(ident)
   finally:e.ROOT=W
   requests=W/'artifacts'/('student-'+arm+'-requests.jsonl');records=[json.loads(x) for x in requests.read_text().splitlines() if json.loads(x).get('task')==ident] if requests.exists() else []
   errors=[x for x in records if x.get('error')];reject=W/'artifacts'/('student-'+arm+'-rejections.jsonl');rejects=[json.loads(x) for x in reject.read_text().splitlines() if json.loads(x).get('task')==ident] if reject.exists() else []
   infrastruct=[x for x in errors+rejects if not any(s in str(x.get('error')) for s in ['Registered student budget exhausted','Student context capacity exceeded'])]
   valid=not infrastruct and (stats['nativeExitCode']==0 or stats['timedOut'])
   row={'task':ident,'protocolValid':valid,'verifiedSuccess':bool(v['verifiedSuccess']) and valid,'scientificSuccess':bool(v['agentProducedOutputCheck']['success']),'sourceReplayCorrect':bool(v['independentReplay'] and v['independentReplay'].get('success')),'wallSeconds':stats['wallSeconds'],'timeToFirstSourceSeconds':stats['timeToFirstSourceSecondsApprox'],'physicalCalls':len(records),'promptTokens':sum(x.get('promptTokens',0) for x in records),'completionTokens':sum(x.get('completionTokens',0) for x in records),'infrastructureErrors':len(infrastruct),'modelFormatFailures':sum(x.get('toolFormatParsed') is False for x in records),'sourceFiles':stats['sourceFiles'],'timedOut':stats['timedOut'],'apiCostUsd':0,'verificationPath':str(a/'artifacts/verification'/f'{ident}.json')};rows.append(row)
   e.dump(W/'artifacts'/('student-'+arm+'-results.json'),{'arm':arm,'completed':len(rows),'rows':rows,'verifiedSuccessCount':sum(r['verifiedSuccess'] for r in rows),'protocolValidCount':sum(r['protocolValid'] for r in rows),'atUtc':stamp()})
   print('D2_STUDENT_TASK_RESULT',json.dumps(row),flush=True)
   if not valid:raise RuntimeError('Baseline/evaluation infrastructure invalid; no automatic replacement or training')
 finally:
  stop_server();occupied=time.monotonic()-armStart
  e.dump(W/'artifacts'/('student-'+arm+'-resources.json'),{'arm':arm,'modelServiceAllocationWallSeconds':occupied,'modelServiceAllocationGpuHours':occupied/3600,'includesLoadAgentExecutionAndVerifierWhileModelAllocated':True,'completedTasks':len(rows),'apiCostUsd':0,'gpuMonetaryCostUnknown':True})
 freeze_check();return rows

def main():
 global GPU_UUID
 cfg=json.loads(sys.stdin.readline());freeze_check();progress('WAITING_FOR_PINNED_WEIGHTS',studentCalls=0,gradientUpdates=0);start=time.monotonic()
 while not (W/'artifacts/download-result.json').exists():
  if time.monotonic()-start>7200:raise RuntimeError('Pinned weight download not complete within preparation window')
  time.sleep(10)
 dl=json.loads((W/'artifacts/download-result.json').read_text());assert dl['status']=='WEIGHTS_VERIFIED',dl['status'];assert dl['revision']==json.loads((W/'artifacts/protocol.json').read_text())['student']['revision']
 raw=run_arm('raw',cfg);count=sum(x['verifiedSuccess'] for x in raw)
 if count==4:
  result={'status':'STOP_RAW_CEILING','rawSuccess':4,'rawTotal':4,'sftNotRunReason':'preregistered ceiling stop','rawResults':raw,'algorithmGainEstablished':False,'researchGoalAchieved':False,'atUtc':stamp()};e.dump(W/'artifacts/FINAL_GPU_RESULTS.json',result);progress('STOP_RAW_CEILING',rawSuccess=4,rawTotal=4);return
 GPU_UUID=free_gpu();freeze_check();progress('LORA_SFT_TRAINING',rawSuccess=count,rawTotal=4,epochs=2);log=(W/'logs/student-lora-training.log').open('a')
 trainer=subprocess.Popen([PY,'-u',str(W/'experiments/train_action_lora.py')],cwd=W,env=dict(BASE_ENV,CUDA_VISIBLE_DEVICES=GPU_UUID),stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:rc=trainer.wait(timeout=7200)
 except subprocess.TimeoutExpired:
  assert os.getpgid(trainer.pid)==trainer.pid;os.killpg(trainer.pid,signal.SIGTERM);trainer.wait(timeout=30);raise RuntimeError('Fixed training resource window expired; no hyperparameter retries')
 if rc:raise RuntimeError('Fixed LoRA training failed; no adaptive recipe changes')
 trained=json.loads((W/'artifacts/training/TRAINING_RESULTS.json').read_text());assert trained['gradientUpdates']==54
 after=run_arm('sft',cfg);new=sum(x['verifiedSuccess'] for x in after);gain=new-count
 result={'status':'COMPARISON_COMPLETE','atUtc':stamp(),'rawSuccess':count,'sftSuccess':new,'tasksPerArm':4,'completionGainPercentagePoints':25*gain,'rawResults':raw,'sftResults':after,'training':trained,'algorithmGainEstablished':gain>=1,'researchGoalAchieved':gain>=1,'claim':'Exploratory paired 4-task student-model result; not production gain, not statistical significance, not a filtering ablation','model':'Qwen/Qwen2.5-Coder-7B-Instruct','revision':dl['revision'],'nativeRuntimeModified':False,'teacherTrainPoolChanged':False,'apiCostUsd':0,'gpuCostNotMonetized':True,'wallSecondsFromControllerStart':time.monotonic()-start};result['gpuResources']={arm:json.loads((W/'artifacts'/('student-'+arm+'-resources.json')).read_text()) for arm in ['raw','sft']};result['totalAllocatedGpuHours']=trained['gpuHours']+sum(v['modelServiceAllocationGpuHours'] for v in result['gpuResources'].values());e.dump(W/'artifacts/FINAL_GPU_RESULTS.json',result);progress('COMPARISON_COMPLETE',rawSuccess=count,sftSuccess=new,completionGainPercentagePoints=25*gain,researchGoalAchieved=gain>=1)
if __name__=='__main__':
 try:main()
 except Exception as ex:
  stop_server();error={'status':'GPU_STAGE_BLOCKED_OR_FAILED','atUtc':stamp(),'error':type(ex).__name__+': '+str(ex),'noAutomaticRerun':True,'researchGoalAchieved':False};e.dump(W/'artifacts/GPU_STAGE_ERROR.json',error);progress('GPU_STAGE_BLOCKED_OR_FAILED',error=error['error']);raise
