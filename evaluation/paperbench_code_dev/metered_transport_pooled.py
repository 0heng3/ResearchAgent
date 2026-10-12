"""Loopback transport/accounting adapter; it contains no Agent or tool loop."""
from __future__ import annotations
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
from contextlib import nullcontext
from cogclaw.model.cost import usage_cost
from cogclaw.security.sensitive import redact_secret_values


class Relay:
    def __init__(self, config, ledger, pricing, token, max_calls=12, max_tokens=140000, output_tokens=6144, batch_cap=2.0, read_timeout_seconds=300, drain_seconds=330):
        self.config, self.ledger, self.pricing, self.token = config, ledger, pricing, token
        self.read_timeout_seconds, self.drain_seconds = read_timeout_seconds, drain_seconds
        self.max_calls, self.max_tokens, self.output_tokens, self.batch_cap = max_calls, max_tokens, output_tokens, batch_cap
        self.rate_lock=threading.Lock();self.last_dispatch=0.0
        self.upstream=httpx.Client(timeout=httpx.Timeout(read_timeout_seconds,connect=20.0),limits=httpx.Limits(max_connections=2,max_keepalive_connections=2,keepalive_expiry=60))
        self.lock = threading.RLock(); self.active = None; self.rows = []; self.records = []; self.batch_cost = 0.; self.batch_reserved = 0.; self.stop_reason = None
        parent = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *_args): pass
            def send_json(self, status, data):
                body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):
                if self.path.endswith('/models'):
                    self.send_json(200,{'object':'list','data':[{'id':parent.config.model,'object':'model','owned_by':'configured-budgeted-route'}]})
                else:self.send_json(200,{'status':'ready','noAgentLoop':True})
            def do_POST(self):
                if self.path not in ['/v1/chat/completions','/chat/completions']:
                    return self.send_json(404,{'error':{'message':'unsupported transport endpoint'}})
                if self.headers.get('Authorization')!='Bearer '+parent.token:
                    return self.send_json(401,{'error':{'message':'local relay authorization required'}})
                request=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
                if request.get('model')!=parent.config.model:
                    return self.send_json(400,{'error':{'message':'unpriced or unregistered model blocked'}})
                request['max_tokens']=parent.output_tokens
                streaming=bool(request.get('stream'))
                if streaming:request['stream_options']={'include_usage':True}
                estimate=len(json.dumps(request,ensure_ascii=False).encode())+1024
                with parent.lock:
                    task=parent.active
                    if task is None or parent.stop_reason or task['calls']>=parent.max_calls or task['tokens']>=parent.max_tokens:
                        return self.send_json(402,{'error':{'message':'cost-budget-exhausted: registered evaluation allowance reached'}})
                    expected=usage_cost(prompt_tokens=estimate,completion_tokens=parent.output_tokens,cached_tokens=0,pricing=parent.pricing)[3]
                    if task['tokens']+estimate+parent.output_tokens>parent.max_tokens:
                        return self.send_json(402,{'error':{'message':'cost-budget-exhausted: conservative per-task token allowance reached'}})
                    if parent.batch_cost+parent.batch_reserved+expected>parent.batch_cap:
                        parent.stop_reason='registered-batch-cost-exhausted'
                        return self.send_json(402,{'error':{'message':'cost-budget-exhausted'}})
                    try:
                        rid,_=parent.ledger.reserve(model_id=parent.config.model,prompt_tokens=estimate,max_completion_tokens=parent.output_tokens,cached_tokens=0,pricing=parent.pricing)
                    except Exception as error:
                        parent.stop_reason=str(error)
                        return self.send_json(402,{'error':{'message':'cost-budget-exhausted: '+str(error)}})
                    task['calls']+=1;task['active']+=1;ordinal=task['calls'];parent.batch_reserved+=expected
                usage=None;dispatched=False;failure=None;status=None;consumer_open=True;captured=[]
                base=parent.config.base_url.rstrip('/');url=base+'/chat/completions' if base.endswith('/v1') else base+'/v1/chat/completions'
                try:
                    with parent.rate_lock:
                        wait=4.0-(time.monotonic()-parent.last_dispatch)
                        if wait>0:time.sleep(wait)
                        parent.last_dispatch=time.monotonic()
                    dispatched=True
                    with nullcontext(parent.upstream) as client:
                        with client.stream('POST',url,headers={'Authorization':'Bearer '+parent.config.api_key,'Content-Type':'application/json'},json=request) as response:
                            status=response.status_code
                            if status!=200:
                                body=response.read();failure='upstream-http-'+str(status)
                                try:self.send_json(status,{'error':{'message':failure,'detail':redact_secret_values(__import__('re').sub(r'(api_key:\s*)[A-Za-z0-9_-]{32,}',r'\1[REDACTED_PROVIDER_KEY_IDENTIFIER]',body.decode(errors='replace'))[:600])}})
                                except (BrokenPipeError,ConnectionResetError):pass
                            elif streaming:
                                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                                for line in response.iter_lines():
                                    if line.startswith('data:') and line[5:].strip()!='[DONE]':
                                        try:
                                            event=json.loads(line[5:].strip());captured.append(event)
                                            if event.get('usage'):usage=event['usage']
                                        except json.JSONDecodeError:pass
                                    if consumer_open:
                                        try:self.wfile.write((line+'\n').encode());self.wfile.flush()
                                        except (BrokenPipeError,ConnectionResetError):consumer_open=False
                            else:
                                raw=response.read();event=json.loads(raw);captured.append(event);usage=event.get('usage');self.send_json(200,event)
                except Exception as error:
                    failure=type(error).__name__+': '+str(error)
                    try:self.send_json(502,{'error':{'message':'metered upstream failure'}})
                    except Exception:pass
                finally:
                    with parent.lock:
                        record={'taskId':task['id'],'physicalAttempt':ordinal,'route':parent.config.route_id,'model':parent.config.model,'upstreamStatus':status,'usage':usage,'error':failure,'consumerClosed':not consumer_open}
                        if usage and 'prompt_tokens' in usage and 'completion_tokens' in usage:
                            cached=int(usage.get('prompt_cache_hit_tokens') or (usage.get('prompt_tokens_details') or {}).get('cached_tokens') or 0)
                            p=int(usage['prompt_tokens']);c=int(usage['completion_tokens'])
                            *_,cost,_snap=parent.ledger.settle(rid,model_id=parent.config.model,prompt_tokens=p,completion_tokens=c,cached_tokens=cached,pricing=parent.pricing,route_id=parent.config.route_id)
                            task['tokens']+=p+c;task['cost']+=cost;parent.batch_cost+=cost;record['referenceCostUsd']=cost
                        else:
                            parent.ledger.release(rid,model_id=parent.config.model,route_id=parent.config.route_id,error=failure or 'usage-missing',uncertain=dispatched)
                            parent.stop_reason='unknown-model-usage' if dispatched else 'request-not-dispatched'
                        if failure:parent.stop_reason=failure
                        parent.batch_reserved=max(0.,parent.batch_reserved-expected);task['active']-=1;parent.records.append(redact_secret_values(record))
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def activate(self,identifier):
        with self.lock:
            if self.active and self.active['active']:raise RuntimeError('incomplete physical requests')
            task={'id':identifier,'calls':0,'tokens':0,'cost':0.,'active':0};self.rows.append(task);self.active=task;return task
    def finish(self):
        deadline=time.monotonic()+self.drain_seconds
        while self.active and self.active['active'] and time.monotonic()<deadline:time.sleep(.2)
        if self.active and self.active['active']:self.stop_reason='request-drain-incomplete'
        result=dict(self.active or {});self.active=None;return result
    def close(self):
        self.server.shutdown();self.server.server_close();self.upstream.close()
