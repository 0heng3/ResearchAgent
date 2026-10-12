"""Run D1 on A100x2 with an existing metered streaming transport.
Control host only keeps the shared USD ledger; all new artifacts stay remote.
"""
from pathlib import Path
from types import SimpleNamespace
import json,sys,os,secrets,subprocess,shlex,time,threading
CORE=Path('E:/code/COG-CLAW-Autogenesis');sys.path.insert(0,str(CORE/'src'))
from cogclaw.model.cost import CostLedger,pricing_for_model,environment_pricing
from cogclaw.runtime.config import apply_local_env_file,resolve_model_route
apply_local_env_file(CORE);route=resolve_model_route('key2:deepseek-flash');assert route
price=pricing_for_model('deepseek-flash',environment_pricing());assert price.as_dict()=={'inputPerMillion':.3,'outputPerMillion':1.2,'cachedPerMillion':.006}
SSH='C:/Windows/System32/OpenSSH/ssh.exe';HOST='A100x2';W='/opt/data/private/researchagent/researchagent-trajectory-sft-d2-20261011'
mod=subprocess.run([SSH,'-T','-o','BatchMode=yes',HOST,'cat '+W+'/tools/metered_stream_transport.py'],capture_output=True,check=True).stdout.decode();ns={};exec(compile(mod,'metered_stream_transport.py','exec'),ns);Relay=ns['Relay']
ledger=CostLedger(CORE/'.cogclaw/model-cost.json');snapshot=lambda s:{k:getattr(s,k) for k in ['window_date','cap_usd','daily_cost_usd','daily_reserved_cost_usd','remaining_usd']}
initial=snapshot(ledger.authorize(model_id=route['modelId']));relay_token=secrets.token_urlsafe(32)
relay=Relay(SimpleNamespace(model=route['modelId'],route_id=route['route'],base_url=route['channel']['baseUrl'],api_key=route['channel']['apiKey']),ledger,price,relay_token,max_calls=24,max_tokens=2500000,output_tokens=8192,batch_cap=5.,read_timeout_seconds=120,drain_seconds=145)
def save(path,value,append=False):
 code='from pathlib import Path;import sys;p=Path('+repr(W+'/'+path)+');p.parent.mkdir(parents=True,exist_ok=True);'+("f=p.open('ab');f.write(sys.stdin.buffer.read()+bytes([10]));f.close()" if append else 'p.write_bytes(sys.stdin.buffer.read())')
 p=subprocess.run([SSH,'-T','-o','BatchMode=yes',HOST,'PYTHONDONTWRITEBYTECODE=1 python -c '+shlex.quote(code)],input=json.dumps(value,ensure_ascii=False).encode(),capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError('Remote result write failed')
class RemoteRecords(list):
 def append(self,item):
  super().append(item);save('artifacts/physical-model-requests.jsonl',item,True)
  print('D1_PHYSICAL_CALL',json.dumps({k:item.get(k) for k in ['taskId','physicalAttempt','upstreamStatus','usage','referenceCostUsd','error']}),flush=True)
relay.records=RemoteRecords();save('artifacts/ledger-at-start.json',initial);print('D1_SHARED_LEDGER_START',json.dumps(initial),flush=True);start=time.monotonic();taskstats=[]
try:
 for ident in ['TR000','TR001','TR002','TR003','TR004','TR005','TR006','TR007']:
  if relay.stop_reason:break
  remote_port_probe="import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"
  port=int(subprocess.run([SSH,'-T','-o','BatchMode=yes',HOST,'python -c '+shlex.quote(remote_port_probe)],capture_output=True,check=True).stdout.strip())
  relay.activate(ident)
  command='source /opt/data/private/.tools/activate.sh; W='+shlex.quote(W)+'; export PYTHONDONTWRITEBYTECODE=1; "$W/.venv-train/bin/python" -u "$W/tools/run_one.py" '+ident
  proc=subprocess.Popen([SSH,'-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R',f'127.0.0.1:{port}:127.0.0.1:{relay.server.server_port}',HOST,command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace')
  proc.stdin.write(json.dumps({'relayUrl':f'http://127.0.0.1:{port}','relayToken':relay_token})+'\n');proc.stdin.flush()
  for line in proc.stdout:print(line.rstrip(),flush=True)
  exitcode=proc.wait();stat=relay.finish();stat['sshExitCode']=exitcode;taskstats.append(stat);save('artifacts/task-billing/'+ident+'.json',stat)
  if exitcode:print('D1_TASK_TRANSPORT_EXIT',ident,exitcode,flush=True);continue
  verify='source /opt/data/private/.tools/activate.sh; W='+shlex.quote(W)+'; export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONPATH="$W/vendor" HOME="$W/home" TMPDIR="$W/tmp" MPLCONFIGDIR="$W/cache/matplotlib" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1; "$W/.venv-train/bin/python" "$W/experiments/d2_science.py" verify '+ident
  p=subprocess.run([SSH,'-T','-o','BatchMode=yes',HOST,verify],capture_output=True,text=True,encoding='utf-8');print(p.stdout,flush=True);print(p.stderr,flush=True)
  if p.returncode:raise RuntimeError('Independent verification process failed')
finally:
 relay.finish();relay.close();result={'finishedAtUtc':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'wallSeconds':time.monotonic()-start,'taskBilling':taskstats,'physicalModelCalls':len(relay.records),'referenceCostUsd':relay.batch_cost,'stopReason':relay.stop_reason,'initialSharedLedger':initial,'finalSharedLedger':snapshot(ledger.snapshot()),'localModelOperations':0,'nativeSourceOrControllerChanged':False,'root':W};save('artifacts/controller-execution.json',result);print('D1_CONTROLLER_FINISHED',json.dumps(result),flush=True)
