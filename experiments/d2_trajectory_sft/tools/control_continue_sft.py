"""Run in Windows memory. Only shared-ledger I/O locally; all model compute/artifacts remote."""
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from decimal import Decimal
import json,os,sys,time,secrets,threading,subprocess,shlex
CORE=Path('E:/code/COG-CLAW-Autogenesis');sys.path.insert(0,str(CORE/'src'))
from cogclaw.model.cost import CostLedger,ModelPricing
SSH='C:/Windows/System32/OpenSSH/ssh.exe';HOST='A100x2';W='/opt/data/private/researchagent/researchagent-trajectory-sft-d2-20261011'
ALIAS='researchagent-d2-qwen7b';MODEL='self-hosted/Qwen2.5-Coder-7B-Instruct';PRICE=ModelPricing(Decimal('0'),Decimal('0'),Decimal('0'))
ledger=CostLedger(CORE/'.cogclaw/model-cost.json');token=secrets.token_urlsafe(32);pending={};lock=threading.Lock()
def snapshot():
 s=ledger.snapshot();return {k:getattr(s,k) for k in ['window_date','cap_usd','daily_cost_usd','daily_reserved_cost_usd','remaining_usd']}
class Meter(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   if self.headers.get('Authorization')!='Bearer '+token:raise ValueError('Ledger bridge authentication failed')
   obj=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));assert obj['model']==ALIAS
   with lock:
    if self.path=='/reserve':
     ledger.authorize(model_id=MODEL);rid,_=ledger.reserve(model_id=MODEL,prompt_tokens=int(obj['promptTokens']),max_completion_tokens=int(obj['maxOutputTokens']),cached_tokens=0,pricing=PRICE);pending[rid]=obj;result={'reservationId':rid,'apiCostUsd':0,'costBasis':'Self-hosted GPU, no token-billed API; GPU-hours reported separately'}
    elif self.path=='/settle':
     rid=obj['reservationId'];assert rid in pending
     ledger.settle(rid,model_id=MODEL,prompt_tokens=int(obj['promptTokens']),completion_tokens=int(obj['completionTokens']),cached_tokens=0,pricing=PRICE,route_id=obj['route']);pending.pop(rid);result={'settled':True,'apiCostUsd':0,'ledger':snapshot()}
    elif self.path=='/release':
     rid=obj['reservationId'];assert rid in pending
     ledger.release(rid,model_id=MODEL,route_id=obj['route'],error=obj['error'],uncertain=bool(obj['uncertain']));pending.pop(rid);result={'released':True,'ledger':snapshot()}
    else:raise ValueError('Unknown ledger operation')
   code=200
  except Exception as e:result={'error':type(e).__name__+': '+str(e)};code=403
  b=json.dumps(result).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)

ledger.authorize(model_id=MODEL);meter=ThreadingHTTPServer(('127.0.0.1',0),Meter);thread=threading.Thread(target=meter.serve_forever,daemon=True);thread.start()
probe="import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"
# shlex quoting applies to the REMOTE Linux shell only; no Windows shell filesystem operations.
port=int(subprocess.run([SSH,'-T','-o','BatchMode=yes',HOST,'python3 -c '+shlex.quote(probe)],capture_output=True,check=True).stdout.strip())
command='source /opt/data/private/.tools/activate.sh; set -o pipefail; W='+shlex.quote(W)+'; cd "$W"; "$W/.venv-train/bin/python" -u "$W/tools/continue_sft_after_raw.py" 2>&1 | tee -a "$W/logs/gpu-controller.log"'
print('D2_LOCAL_LEDGER_BRIDGE_STARTED',json.dumps({'localPid':os.getpid(),'ledger':snapshot(),'allModelComputeRemote':True,'localModelOperations':0}),flush=True)
proc=subprocess.Popen([SSH,'-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R',f'127.0.0.1:{port}:127.0.0.1:{meter.server_port}',HOST,command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace')
try:
 proc.stdin.write(json.dumps({'ledgerUrl':f'http://127.0.0.1:{port}','ledgerToken':token})+'\n');proc.stdin.flush()
 for line in proc.stdout:
  if line.startswith(('D2_GPU_STAGE','D2_STUDENT_TASK_RESULT')):print(line.rstrip(),flush=True)
  elif 'Traceback' in line or 'Error:' in line:print(line.rstrip(),flush=True)
 rc=proc.wait();print('D2_LOCAL_CONTROLLER_EXIT',json.dumps({'exitCode':rc,'ledger':snapshot(),'unsettledLocalReservations':len(pending),'modelComputeLocal':False}),flush=True)
finally:meter.shutdown();meter.server_close()
if rc:raise SystemExit(rc)
