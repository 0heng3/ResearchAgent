"""Launch native frozen CLI or stock mini in the same fresh scientific input workspace."""
from pathlib import Path
import json,os,sys,time,signal,subprocess,shutil
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'experiments'));import science as e
ident,scaffold=sys.argv[1:3];cfg=json.loads(sys.stdin.readline());t=next(t for t in json.loads((W/'artifacts/tasks.json').read_text()) if t['id']==ident);a=W/'evaluation'/scaffold;r=a/'runs'/ident
assert r.is_dir() and not (r/'inputs').exists();shutil.copytree(Path(t['folder'])/'inputs',r/'inputs');(r/'TASK.md').write_text(t['goal'])
for d in ['home','tmp','cache','artifacts']:(r/d).mkdir()
short=W.parent/'tmp'/('d3-'+scaffold[0]+ident[-3:]);short.parent.mkdir(exist_ok=True);assert not short.exists() and not short.is_symlink();short.symlink_to(r/'tmp',target_is_directory=True);assert short.resolve()==(r/'tmp').resolve()
env={k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ['API_KEY','APIKEY','TOKEN','SECRET','PASSWORD','OPENAI_BASE','LLM_BASE','CLAW_MODEL','LITELLM']) and k not in ['GH_CONFIG_DIR','GIT_CONFIG_GLOBAL']}
env.update(HOME=str(r/'home'),USERPROFILE=str(r/'home'),TMPDIR=str(short),TMP=str(short),TEMP=str(short),XDG_CACHE_HOME=str(r/'cache'),MPLCONFIGDIR=str(r/'cache/matplotlib'),PATH=str(W/'.venv-train/bin')+':'+str(W/'node/bin')+':/usr/bin:/bin',PYTHONPATH=str(W/'vendor'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',MSWEA_GLOBAL_CONFIG_DIR=str(r/'home/mini-config'),MSWEA_SILENT_STARTUP='1')
if scaffold=='native':
 env.update(CLAW_MODEL_CHANNELS='key2',CLAW_MODEL_KEY2_BASE_URL=cfg['modelUrl'],CLAW_MODEL_KEY2_API_KEY='local-self-hosted',CLAW_MODEL_KEY2_LABEL='D3 fixed raw model')
 cmd=[str(W/'node/bin/node'),str(W/'snapshot/node_modules/tsx/dist/cli.mjs'),str(W/'snapshot/src/cli.ts'),'--root',str(r),'--model','key2:researchagent-scaffold-qwen7b','--mode','auto','--once',t['goal']]
else:cmd=[str(W/'.venv-train/bin/python'),'-u',str(W/'tools/run_mini_entry.py'),ident]
e.dump(a/'artifacts/task-starts'/f'{ident}.json',{'atUtc':e.now(),'scaffold':scaffold,'command':cmd[:-1]+['<registered goal>'] if scaffold=='native' else cmd,'cwd':str(r),'nativeSourceUnchanged':True,'realCredentialsOnServer':False,'sameInputTaskSha256':e.sha(Path(t['folder'])/'TASK.md')})
start=time.monotonic();first=None;timeout=False
with (a/'logs'/f'{ident}-agent.stdout.log').open('w') as out,(a/'logs'/f'{ident}-agent.stderr.log').open('w') as err:
 p=subprocess.Popen(cmd,cwd=r,env=env,stdin=subprocess.PIPE if scaffold=='mini' else subprocess.DEVNULL,stdout=out,stderr=err,text=True,start_new_session=True)
 if scaffold=='mini':p.stdin.write(json.dumps(cfg)+'\n');p.stdin.close()
 while p.poll() is None:
  if first is None and any(r.rglob('*.py')):first=time.monotonic()-start
  if time.monotonic()-start>1200:
   timeout=True;assert os.getpgid(p.pid)==p.pid;os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=20)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   break
  time.sleep(1)
result={'task':ident,'scaffold':scaffold,'exitCode':p.returncode,'timedOut':timeout,'wallSeconds':time.monotonic()-start,'timeToFirstSourceSeconds':first,'sourceFiles':[str(x.relative_to(r)) for x in r.rglob('*.py')],'stdout':str(a/'logs'/f'{ident}-agent.stdout.log'),'stderr':str(a/'logs'/f'{ident}-agent.stderr.log')};e.dump(a/'artifacts/task-runs'/f'{ident}.json',result);print('AGENT_TASK_FINISHED',json.dumps(result),flush=True)
