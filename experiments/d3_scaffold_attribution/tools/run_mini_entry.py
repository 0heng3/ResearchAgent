"""Call the unmodified official DefaultAgent and LocalEnvironment; recording is external to its policy."""
from pathlib import Path
import json,os,sys,time,re
W=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(W/'vendor-mini'),str(W/'vendor-mini-deps'),str(W/'tools')]
import yaml
from minisweagent.agents.default import DefaultAgent
from minisweagent.environments.local import LocalEnvironment
from mini_http_model import HttpTextModel
ident=sys.argv[1];cfg=json.loads(sys.stdin.readline());r=W/'evaluation/mini/runs'/ident
stock=yaml.safe_load((W/'vendor-mini/minisweagent/config/default.yaml').read_text());task=json.loads((W/'artifacts/tasks.json').read_text());goal=next(t['goal'] for t in task if t['id']==ident)
class AuditedLocalEnvironment(LocalEnvironment):
 def execute(self,action,cwd='',**kwargs):
  command=action.get('command','');record={'at':time.time(),'command':command,'cwd':str(r)}
  for m in re.finditer(r'(?:^|[;&|\n])\s*cd\s+([^;&|\n]+)',command):
   raw=m.group(1).strip().strip('"\'');p=(Path(os.path.expanduser(raw)) if raw.startswith(('/','~')) else r/raw).resolve()
   if not p.is_relative_to(r.resolve()):
    (r/'artifacts/protocol-escape.json').write_text(json.dumps({'reason':'explicit cd outside task root','command':command}));raise RuntimeError('WORKSPACE_ESCAPE')
  if re.search(r'(?:^|[;&|\n])\s*(?:find|ls|grep\s+-R)\s+/(?:opt|root|home|etc|proc)(?:/|\s|$)',command):
   (r/'artifacts/protocol-escape.json').write_text(json.dumps({'reason':'explicit outside task scan','command':command}));raise RuntimeError('WORKSPACE_ESCAPE')
  with (r/'artifacts/commands.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
  return super().execute(action,cwd,**kwargs)
model=HttpTextModel(cfg['modelUrl'],stock.get('model',{}));env=AuditedLocalEnvironment(cwd=str(r),env={'HOME':str(r/'home'),'TMPDIR':str(r/'tmp'),'TMP':str(r/'tmp'),'TEMP':str(r/'tmp'),'CUDA_VISIBLE_DEVICES':''},timeout=120)
args=dict(stock['agent']);args.update(step_limit=16,cost_limit=5.,wall_time_limit_seconds=1200,output_path=r/'artifacts/mini-trajectory.json')
agent=DefaultAgent(model,env,**args);start=time.monotonic();result=agent.run(goal)
(r/'artifacts/mini-result.json').write_text(json.dumps({'result':result,'modelCalls':agent.n_calls,'costUsd':agent.cost,'wallSeconds':time.monotonic()-start,'miniVersion':'2.4.6','controlPolicyAndPromptsUnmodified':True,'environmentNotFullFilesystemSandbox':True},indent=2));print('MINI_FINISHED',json.dumps({'task':ident,'calls':agent.n_calls,'exit':result.get('exit_status')}),flush=True)
