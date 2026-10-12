"""Launch the unchanged native public CLI in a fresh study task workspace."""
from pathlib import Path
from datetime import datetime,timezone
import json,os,sys,time,signal,subprocess,shutil
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'experiments'))
import d2_science as e
ident=sys.argv[1];cfg=json.loads(sys.stdin.readline());protocol=json.loads((W/'artifacts/protocol.json').read_text());e.baseline_check()
assert all(e.sha(W/k)==h for k,h in protocol['sourceHashes'].items()) and e.sha(W/'artifacts/tasks.json')==protocol['taskHash'];assert all(e.sha(W/k)==v for k,v in protocol['inputHashes'].items())
t=next(t for t in json.loads((W/'artifacts/tasks.json').read_text()) if t['id']==ident);r=W/'runs'/ident;r.mkdir(exist_ok=False);shutil.copytree(Path(t['folder'])/'inputs',r/'inputs');(r/'TASK.md').write_text(t['goal'])
for d in ['home','tmp','cache']:(r/d).mkdir()
env={k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ['API_KEY','APIKEY','TOKEN','SECRET','PASSWORD','OPENAI_BASE','LLM_BASE','CLAW_MODEL','LITELLM']) and k not in ['GH_CONFIG_DIR','GIT_CONFIG_GLOBAL']}
env.update(HOME=str(r/'home'),TMPDIR=str(r/'tmp'),TMP=str(r/'tmp'),TEMP=str(r/'tmp'),XDG_CACHE_HOME=str(r/'cache'),MPLCONFIGDIR=str(r/'cache/matplotlib'),PATH=str(W/'.venv-train/bin')+':'+str(W/'node/bin')+':/usr/bin:/bin',PYTHONPATH=str(W/'vendor'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',CLAW_MODEL_CHANNELS='key2',CLAW_MODEL_KEY2_BASE_URL=cfg['relayUrl'],CLAW_MODEL_KEY2_API_KEY=cfg['relayToken'],CLAW_MODEL_KEY2_LABEL='D1 metered route')
cmd=[str(W/'node/bin/node'),str(W/'snapshot/node_modules/tsx/dist/cli.mjs'),str(W/'snapshot/src/cli.ts'),'--root',str(r),'--model','key2:deepseek-flash','--mode','auto','--once',t['goal']]
e.dump(W/'artifacts/task-starts'/f'{ident}.json',{'atUtc':e.now(),'command':cmd[:-1]+['<registered task goal>'],'cwd':str(r),'nativeSourceUnchanged':True,'realProviderCredentialsOnServer':False,'budget':protocol['budget']})
start=time.monotonic();first=None;timed=False
with (W/'logs'/f'{ident}-native.stdout.log').open('w') as out,(W/'logs'/f'{ident}-native.stderr.log').open('w') as err:
 p=subprocess.Popen(cmd,cwd=r,env=env,stdout=out,stderr=err,start_new_session=True)
 print('D1_AGENT_STARTED',json.dumps({'task':ident,'pid':p.pid,'workspace':str(r)}),flush=True)
 while p.poll() is None:
  if first is None and any(r.rglob('*.py')):first=time.monotonic()-start
  if time.monotonic()-start>900:
   timed=True;assert os.getpgid(p.pid)==p.pid;os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=20)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   break
  time.sleep(1)
result={'task':ident,'nativeExitCode':p.returncode,'timedOut':timed,'wallSeconds':time.monotonic()-start,'timeToFirstSourceSecondsApprox':first,'modelCallsHandledByExistingSharedLedgerRelay':True,'sourceFiles':[str(x.relative_to(r)) for x in r.rglob('*.py')],'nativeStdout':str(W/'logs'/f'{ident}-native.stdout.log'),'nativeStderr':str(W/'logs'/f'{ident}-native.stderr.log')}
e.dump(W/'artifacts/task-runs'/f'{ident}.json',result);e.baseline_check();print('D1_AGENT_FINISHED',json.dumps(result),flush=True)
