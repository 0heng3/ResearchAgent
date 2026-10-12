"""One frozen, all20 Code-Dev campaign. No Agent retries or post-Judge source repair."""
from __future__ import annotations
import argparse,ast,hashlib,json,os,secrets,shutil,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
B=Path(__file__).resolve().parent
ROOT=B.parents[2]
AGENT=B/'agent-snapshot'
PB=B/'official/project/paperbench'
NODE=Path(r'E:\nodejs\node.exe')
JUDGE_PY=Path(r'E:\code\COG-related works\cog-paperbench\bench\project\paperbench\.venv\Scripts\python.exe')
sys.path[:0]=[str(ROOT/'src'),str(B)]
from cogclaw.runtime.config import RuntimeConfig
from cogclaw.model.cost import CostLedger,pricing_for_model,environment_pricing
from cogclaw.runtime.process import run_process
from cogclaw.security.sensitive import redact_secret_values
from metered_transport_pooled import Relay
GOAL=('Read the supplied paper.md and addendum.md, obey blacklist.txt, and implement the paper contributions as a working codebase under submission/. '
'This is a Code Development attempt, not a request for the full expensive experiment run. Include the actual method implementations, data/model interfaces, '
'training/evaluation entrypoints and concise usage instructions. Run small CPU smoke tests where feasible; do not invoke paid external model APIs or download '
'large pretrained models during checks. Do not access the paper original codebase, benchmark rubrics, Judge data or historical submissions. '
'Finish with the real implemented file paths and clearly state what is implemented versus unrun.')
BUDGET={'sharedUtcDailyUsd':50,'campaignReferenceUsd':45,'agentWallSecondsPerPaper':1800,'agentPhysicalCallsPerPaper':48,
'agentConservativeTokensPerPaper':2500000,'agentMaxOutputPerRequest':16384,'judgeWallSecondsPerPaper':21600,
'judgePhysicalCallsPerPaper':4000,'judgeConservativeTokensPerPaper':200000000,'judgeMaxOutputPerRequest':8192,
'judgeConcurrency':2,'minimumPhysicalRequestSpacingSeconds':4,'proxyReadTimeoutSeconds':300,'proxyDrainSeconds':330}
SAVE_LOCK=threading.RLock()
def now():return datetime.now(timezone.utc).isoformat()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,value):
    p.parent.mkdir(parents=True,exist_ok=True)
    temporary=p.with_name(p.name+'.tmp')
    if not p.resolve().is_relative_to(B.resolve()) or not temporary.resolve().is_relative_to(B.resolve()):
        raise ValueError('Only campaign artifacts may be written')
    with SAVE_LOCK:
        temporary.write_text(json.dumps(redact_secret_values(value),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        os.replace(temporary,p)
def environment(python):
    env=dict(os.environ)
    for k in list(env):
        if k.startswith(('CLAW_MODEL_','LLM_','OPENAI_','ANTHROPIC_','LITELLM_','BENCH_')):env.pop(k)
    env.update({'PATH':str(python.parent)+os.pathsep+env['PATH'],'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1',
                'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':'','PYTHONNOUSERSITE':'1','PYTHONIOENCODING':'utf-8','PYTHONUTF8':'1'})
    return env
def execute(argv,cwd,timeout,env):
    start=time.perf_counter()
    try:
        p=run_process(argv,cwd=cwd,timeout=timeout,env=env)
        return {'argv':argv,'exitCode':p.returncode,'seconds':time.perf_counter()-start,'stdout':p.stdout,'stderr':p.stderr,'timedOut':False}
    except subprocess.TimeoutExpired as e:
        return {'argv':argv,'exitCode':None,'seconds':time.perf_counter()-start,'stdout':str(e.output or ''),'stderr':str(e.stderr or ''),'timedOut':True}
    except Exception as e:
        return {'argv':argv,'exitCode':None,'seconds':time.perf_counter()-start,'stdout':'','stderr':type(e).__name__+': '+str(e),'timedOut':False,'launcherError':True}
def hashes(folder):return {str(p.relative_to(folder)):sha(p) for p in folder.rglob('*') if p.is_file()}
def frozen_source_ok(protocol):
    return all((AGENT/k).is_file() and sha(AGENT/k)==v for k,v in protocol['agentSourceHashes'].items()) and all(sha(B/k)==v for k,v in protocol['runnerHashes'].items())
def register():
    if (B/'protocol.json').exists():raise RuntimeError('Protocol already frozen; do not replace')
    prepared=json.loads((B/'prepared.json').read_text())
    ids=[x.strip() for x in (PB/'experiments/splits/all.txt').read_text().splitlines() if x.strip()]
    assert ids==prepared['paperIds'] and len(ids)==20
    cfg=RuntimeConfig.from_env(ROOT/'.env',model='key2:deepseek-flash')
    price=pricing_for_model(cfg.model,environment_pricing());ledger=CostLedger.from_environment()
    source=json.loads((B/'agent-hashes.json').read_text())
    input_hashes=json.loads((B/'input-hashes.json').read_text())
    assert all(sha(PB/'data/papers'/k)==v for k,v in input_hashes.items())
    protocol={'registeredAtUtc':now(),'cohort':'official all.txt full20, exactly1 Agent attempt each','paperIds':ids,
      'agentOriginalRoot':prepared['agentOriginalRoot'],'agentSnapshotRoot':str(AGENT),'agentSourceHashes':source,
      'agentPackageVersion':json.loads((AGENT/'package.json').read_text())['version'],
      'dependencyLockSha256':sha(AGENT/'node_modules/.package-lock.json'),
      'runtimeVersions':{'python':sys.version.split()[0],'node':subprocess.check_output([str(NODE),'--version'],text=True).strip()},
      'officialSnapshot':json.loads((B/'official-source.json').read_text()),'inputHashesFile':'input-hashes.json',
      'inputHashesSha256':sha(B/'input-hashes.json'),'splitSha256':sha(PB/'experiments/splits/all.txt'),
      'leafCounts':json.loads((B/'leaf-counts.json').read_text()),'model':cfg.model,'route':cfg.route_id,
      'pricing':price.as_dict(),'priceBasis':'Frozen official DeepSeek peak reference, not gateway invoice','sharedLedger':str(ledger.path),
      'goal':GOAL,'goalSha256':hashlib.sha256(GOAL.encode()).hexdigest(),'mode':'auto','tools':'Unmodified native public CLI tools and default capabilities',
      'agentAttemptsPerPaper':1,'budget':BUDGET,'generationOrder':'Exact official all.txt order, serial, fresh workspace/home/temp per paper',
      'stages':'Generate all submissions first; freeze all submissions; then grade all fixed submissions',
      'judge':{'model':cfg.model,'officialJudgeModel':False,'implementation':'Pinned official SimpleJudge','codeOnly':True,'maxDepth':999,
               'concurrency':2,'adaptations':['Windows local-file Code-Dev; optional remote-computer imports shimmed but never instantiated',
                 'DeepSeek OpenAI-compatible transport; original structured parser with JSON shape formatting; surrogate tokenizer/context100000']},
      'baseline':{'officialStandaloneCodeDevPercent':43.4,'semPercentagePoints':0.8,'model':'IterativeAgent o1-high',
                  'judge':'o3-mini-2025-01-31 high','comparison':'Descriptive reference only; different model/Judge/budget; no superiority or causal claim'},
      'exposure':'Full-suite development evaluation. Some papers were previously observed; not an unseen/held-out result. No historical outputs or scores reused.',
      'primary':'Mean of20 paper root-level weighted Code-Dev scores, reported only when every paper has an admissible complete score',
      'validFailurePolicy':'Valid bounded Agent failures, timeouts and no-code deliveries are submitted to the same Judge; no dropping failed papers',
      'invalidPolicy':'Transport/unknown-usage, modified inputs, launcher errors or incomplete grading retain null primary scores and remain in all20 results; no completed-only mean called full20',
      'disqualificationPolicy':'Observed blacklisted/hidden evaluation access is disqualified and assigned0, never rerun',
      'stopPolicy':'Unknown physical usage, daily/campaign cost cap or frozen-source drift stops paid work. All remaining entries are retained as not run. No task/prompt/model substitution.',
      'resumePolicy':'No Agent replay. A started campaign cannot be launched again by this runner.',
      'submissionExport':'submission/ if created, otherwise workspace; retain authored files excluding input files, environment and Runtime/cache metadata',
      'runnerHashes':{name:sha(B/name) for name in ['campaign.py','metered_transport_pooled.py','judge_bridge.py']}}
    assert frozen_source_ok(protocol)
    save(B/'protocol.json',protocol)
    save(B/'ledger-at-registration.json',ledger_snapshot(ledger))
    print('REGISTERED',len(ids),'papers','model',cfg.route_id,'customJudge=true',flush=True)
def ledger_snapshot(ledger):
    if not ledger.path.exists():return {'exists':False}
    value=json.loads(ledger.path.read_text())
    return {k:value.get(k) for k in ['windowDate','dailyCostUsd','dailyCalls','dailyReservedCostUsd']}
def export_submission(work,target,inputs):
    target.mkdir(parents=True,exist_ok=False)
    source=work/'submission' if (work/'submission').is_dir() else work
    skip={'.env','.git','.cogclaw','__pycache__','node_modules','.pytest_cache','.venv','venv'}
    for p in source.rglob('*'):
        if not p.is_file():continue
        rel=p.relative_to(source)
        if set(rel.parts)&skip:continue
        if source==work and (str(rel) in inputs or rel.parts[0]=='artifacts'):continue
        out=target/rel;out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,out)
    analysis=[]
    for p in target.rglob('*.py'):
        row={'file':str(p.relative_to(target)),'bytes':p.stat().st_size,'sha256':sha(p)}
        try:
            tree=ast.parse(p.read_text(encoding='utf-8'));row['syntaxValid']=True
            row['definitions']=sum(isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) for x in ast.walk(tree))
        except Exception as e:row.update(syntaxValid=False,error=str(e),definitions=0)
        analysis.append(row)
    return analysis
def violations(work,paper):
    blacklist=[x.strip().lower().rstrip('/') for x in (paper/'blacklist.txt').read_text(encoding='utf-8').splitlines() if x.strip()]
    bad=[]
    for p in (work/'artifacts/cli/sessions').glob('*.json'):
        session=json.loads(p.read_text(encoding='utf-8'))
        for turn in session.get('input',{}).get('conversation',[]):
            for call in turn.get('toolCalls',[]):
                text=str(call.get('inputSummary','')).lower()
                if call.get('name') in ['WebFetch','WebSearch','Bash','Read'] and any(x in text for x in blacklist):
                    bad.append({'kind':'blacklist','tool':call.get('name'),'input':text[:400]})
                if any(x in text for x in ['rubric.json','judge.addendum.md','demo_submissions','demo_judge_out']):
                    bad.append({'kind':'hidden-evaluation','tool':call.get('name'),'input':text[:400]})
    return bad
def aggregate(rows):
    complete=[r for r in rows if r.get('benchmarkScore') is not None]
    return {'paperCount':len(rows),'scoredPaperCount':len(complete),
      'benchmarkComplete':len(rows)==20 and len(complete)==20,
      'full20CodeDevScorePercent':sum(r['benchmarkScore'] for r in complete)/20*100 if len(rows)==20 and len(complete)==20 else None,
      'completedOnlyMeanPercentNotFull20':sum(r['benchmarkScore'] for r in complete)/len(complete)*100 if complete else None,
      'generationAttemptedCount':sum(r.get('agentAttempted',False) for r in rows),
      'generationFinishedCount':sum(r.get('generationStatus') not in ['NOT_STARTED','RUNNING'] for r in rows),
      'gradingFinishedCount':sum(r.get('gradingStatus') not in ['NOT_STARTED','RUNNING'] for r in rows)}
def persist(rows,stage,status='RUNNING',relay=None,reason=None):
    value={'updatedAtUtc':now(),'campaignStatus':status,'stage':stage,'stopReason':reason,'model':'deepseek-flash','officialJudgeModel':False,
           **aggregate(rows),'rows':rows}
    if relay:
        with relay.lock:
            known=[x for x in relay.records if x.get('usage')]
            value['resources']={'physicalCalls':len(relay.records),'unknownUsageCalls':len(relay.records)-len(known),
              'knownTokens':sum(int(x['usage']['prompt_tokens'])+int(x['usage']['completion_tokens']) for x in known),
              'peakReferenceCostUsd':relay.batch_cost,'activeStageCalls':relay.active.get('calls') if relay.active else None}
    save(B/'progress.json',value)
    return value
class Recorder:
    def __init__(self,relay,rows,state):
        self.relay,self.rows,self.state=relay,rows,state;self.stop=threading.Event();self.index=0
        self.thread=threading.Thread(target=self.loop,daemon=True);self.thread.start()
    def flush(self):
        with self.relay.lock:items=list(self.relay.records[self.index:]);self.index+=len(items)
        if items:
            with (B/'physical-requests.jsonl').open('a',encoding='utf-8') as out:
                for item in items:out.write(json.dumps(redact_secret_values(item),ensure_ascii=False)+'\n')
    def loop(self):
        while not self.stop.wait(2):
            self.flush();persist(self.rows,self.state['stage'],relay=self.relay)
    def close(self):self.stop.set();self.thread.join(timeout=5);self.flush()
def run():
    protocol=json.loads((B/'protocol.json').read_text(encoding='utf-8'))
    if (B/'started.json').exists():raise RuntimeError('Campaign already started; Agent attempts must not be replayed')
    if not frozen_source_ok(protocol):raise RuntimeError('Frozen-source drift before start')
    cfg=RuntimeConfig.from_env(ROOT/'.env',model='key2:deepseek-flash');price=pricing_for_model(cfg.model,environment_pricing());ledger=CostLedger.from_environment()
    assert cfg.route_id==protocol['route'] and price.as_dict()==protocol['pricing']
    nonce=secrets.token_urlsafe(32)
    relay=Relay(cfg,ledger,price,nonce,max_calls=48,max_tokens=2500000,output_tokens=16384,batch_cap=45,read_timeout_seconds=300,drain_seconds=330)
    (B/'.env').write_text('BENCH_BASE_URL='+relay.url+'\nBENCH_PROXY_API_KEY='+nonce+'\n',encoding='utf-8')
    rows=[{'paperId':p,'agentAttempted':False,'generationStatus':'NOT_STARTED','gradingStatus':'NOT_STARTED','protocolValid':None,'benchmarkScore':None} for p in protocol['paperIds']]
    state={'stage':'GENERATION'};recorder=Recorder(relay,rows,state)
    save(B/'started.json',{'startedAtUtc':now(),'pid':os.getpid(),'protocolSha256':sha(B/'protocol.json')})
    reason=None;success=False
    try:
        for row in rows:
            if relay.stop_reason:reason=relay.stop_reason;break
            if not frozen_source_ok(protocol):reason='frozen-source-drift';break
            paper=PB/'data/papers'/row['paperId'];base=B/'runs'/row['paperId'];work=base/'repo';work.mkdir(parents=True,exist_ok=False)
            inputs={}
            for name in ['paper.md','paper.pdf','addendum.md','blacklist.txt']:
                if (paper/name).is_file():shutil.copyfile(paper/name,work/name);inputs[name]=sha(work/name)
            if (paper/'assets').is_dir():
                shutil.copytree(paper/'assets',work/'assets')
                inputs.update({str(p.relative_to(work)):sha(p) for p in (work/'assets').rglob('*') if p.is_file()})
            (base/'home').mkdir();(base/'temp').mkdir()
            (work/'.env').write_text('CLAW_MODEL_CHANNELS=bench\nCLAW_MODEL_BENCH_BASE_URL='+relay.url+'\nCLAW_MODEL_BENCH_API_KEY='+nonce+'\n',encoding='utf-8')
            env=environment(Path(sys.executable));env.update({'CLAW_MODEL_CHANNELS':'bench','CLAW_MODEL_BENCH_BASE_URL':relay.url,
              'HOME':str(base/'home'),'USERPROFILE':str(base/'home'),'TEMP':str(base/'temp'),'TMP':str(base/'temp')})
            row.update(agentAttempted=True,generationStatus='RUNNING',agentStartedAtUtc=now())
            save(base/'attempt-started.json',{'startedAtUtc':row['agentStartedAtUtc'],'attemptNumber':1,'goalSha256':protocol['goalSha256']})
            state['stage']='GENERATION:'+row['paperId'];persist(rows,state['stage'],relay=relay)
            print('AGENT_START',row['paperId'],now(),flush=True)
            relay.max_calls=48;relay.max_tokens=2500000;relay.output_tokens=16384;relay.activate('agent:'+row['paperId'])
            ex=execute([str(NODE),str(AGENT/'node_modules/tsx/dist/cli.mjs'),str(AGENT/'src/cli.ts'),'--workspace',str(work),
              '--model','bench:'+cfg.model,'--mode','auto','--once',GOAL],work,1800,env)
            usage=relay.finish();save(base/'agent-execution.json',ex);save(base/'agent-usage.json',usage)
            bad=violations(work,paper)
            unchanged=all((work/k).is_file() and sha(work/k)==v for k,v in inputs.items())
            target=B/'submissions'/row['paperId'];analysis=export_submission(work,target,inputs)
            source_hashes=hashes(target);save(base/'submission-hashes.json',source_hashes)
            row.update(agentFinishedAtUtc=now(),agentSeconds=ex['seconds'],agentTimedOut=ex['timedOut'],agentExitCode=ex['exitCode'],
              agentPhysicalCalls=usage['calls'],agentKnownTokens=usage['tokens'],agentPeakReferenceCostUsd=usage['cost'],
              inputsUnchanged=unchanged,accessViolations=bad,submission=str(target),submissionFileCount=len(source_hashes),
              pythonSourceAnalysis=analysis,hasCodeDelivery=any(x.get('definitions',0)>0 for x in analysis))
            if relay.stop_reason:row.update(generationStatus='INVALID_TRANSPORT_OR_BUDGET_STOP',protocolValid=False);reason=relay.stop_reason
            elif ex.get('launcherError'):row.update(generationStatus='INVALID_LAUNCHER',protocolValid=False)
            elif not unchanged:row.update(generationStatus='INVALID_INPUT_MODIFICATION',protocolValid=False)
            elif bad:row.update(generationStatus='DISQUALIFIED',protocolValid=False,benchmarkScore=0.0,gradingStatus='DISQUALIFIED_ZERO')
            else:
                status='VALID_TIME_LIMIT' if ex['timedOut'] else ('VALID_FINISHED' if ex['exitCode']==0 else 'VALID_AGENT_FAILURE')
                row.update(generationStatus=status,protocolValid=True)
            save(base/'result.json',row);persist(rows,state['stage'],relay=relay)
            print('AGENT_END',row['paperId'],row['generationStatus'],'calls',usage['calls'],'files',len(source_hashes),flush=True)
        save(B/'generation-results.json',rows)
        save(B/'submissions-frozen.json',{'frozenAtUtc':now(),'paperIdsWithSubmissions':[r['paperId'] for r in rows if r.get('submission')],
          'all20Generated':all(r['agentAttempted'] for r in rows),'generationFinishedBeforeAnyJudge':True})
        if not reason:
            for row in rows:
                if row['benchmarkScore'] is not None:continue
                if not row.get('protocolValid'):row['gradingStatus']='NOT_GRADED_INVALID_GENERATION';continue
                if relay.stop_reason:reason=relay.stop_reason;break
                if not frozen_source_ok(protocol):reason='frozen-source-drift';break
                base=B/'runs'/row['paperId'];submission=Path(row['submission']);before=json.loads((base/'submission-hashes.json').read_text())
                if hashes(submission)!=before:row.update(gradingStatus='INVALID_SUBMISSION_DRIFT',protocolValid=False);continue
                state['stage']='GRADING:'+row['paperId'];row['gradingStatus']='RUNNING';row['judgeStartedAtUtc']=now()
                persist(rows,state['stage'],relay=relay);print('JUDGE_START',row['paperId'],now(),flush=True)
                relay.max_calls=4000;relay.max_tokens=200000000;relay.output_tokens=8192;relay.activate('judge:'+row['paperId'])
                grade_dir=B/'judges'/row['paperId']
                env=environment(JUDGE_PY)
                ex=execute([str(JUDGE_PY),str(B/'judge_bridge.py'),row['paperId'],str(submission),str(grade_dir)],B,21600,env)
                usage=relay.finish();save(grade_dir/'judge-execution.json',ex);save(grade_dir/'judge-usage.json',usage)
                row.update(judgeFinishedAtUtc=now(),judgeSeconds=ex['seconds'],judgeTimedOut=ex['timedOut'],judgeExitCode=ex['exitCode'],
                  judgePhysicalCalls=usage['calls'],judgeKnownTokens=usage['tokens'],judgePeakReferenceCostUsd=usage['cost'],
                  submissionUnchangedDuringJudge=hashes(submission)==before)
                grade_file=grade_dir/'code-dev-grade.json'
                if grade_file.exists():
                    g=json.loads(grade_file.read_text());row.update(artifactCodeDevScore=g['score'],codeDevLeafCount=g['leafCount'],invalidLeafCount=g['invalidLeafCount'])
                    if g['allLeafScoresValid'] and ex['exitCode']==0 and row['submissionUnchangedDuringJudge'] and not relay.stop_reason:
                        row.update(gradingStatus='COMPLETE_CUSTOM_JUDGE',benchmarkScore=g['score'])
                    else:row['gradingStatus']='INCOMPLETE_OR_INVALID_JUDGE'
                else:row['gradingStatus']='INCOMPLETE_JUDGE_NO_GRADE'
                save(base/'result.json',row);persist(rows,state['stage'],relay=relay)
                print('JUDGE_END',row['paperId'],row['gradingStatus'],'score',row['benchmarkScore'],'calls',usage['calls'],flush=True)
                if relay.stop_reason:reason=relay.stop_reason;break
        success=aggregate(rows)['benchmarkComplete']
    except BaseException as error:
        reason=type(error).__name__+': '+str(error);save(B/'runner-error.json',{'atUtc':now(),'stage':state['stage'],'error':reason})
        print('CAMPAIGN_ERROR',reason,flush=True)
    finally:
        if relay.active and relay.active.get('active'):relay.finish()
        recorder.close()
        reason=reason or relay.stop_reason
        for row in rows:
            if not row['agentAttempted'] and reason:row['notRunReason']=reason
            if row['gradingStatus']=='NOT_STARTED' and reason:row['notGradedReason']=reason
        status='COMPLETE' if success else ('STOPPED' if reason else 'FINISHED_INCOMPLETE')
        final=persist(rows,'DONE',status,relay,reason)
        final['finishedAtUtc']=now();final['agentSnapshotUnchanged']=frozen_source_ok(protocol);final['noSourceRepairOrAgentReplay']=True
        save(B/'FINAL_RESULTS.json',final);save(B/'ledger-at-finish.json',ledger_snapshot(ledger))
        save(B/'physical-request-records.json',relay.records);relay.close()
        print('CAMPAIGN_END',status,'scored',final['scoredPaperCount'],'/20','full20',final['full20CodeDevScorePercent'],flush=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--register',action='store_true');parser.add_argument('--run',action='store_true');args=parser.parse_args()
    if args.register:register()
    elif args.run:run()
    else:parser.print_help()
