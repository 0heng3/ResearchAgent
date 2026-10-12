"""D1: two fresh end-to-end scientific tasks for the frozen native ResearchAgent.
This module prepares and independently verifies tasks; it does not act as an Agent.
"""
import csv,hashlib,json,os,subprocess,sys,time,zipfile
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC
from sklearn.metrics import mean_squared_error,mean_absolute_error,accuracy_score,balanced_accuracy_score,f1_score,roc_auc_score
ROOT=Path(__file__).resolve().parents[1]
def dump(p,j):p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(j,indent=2,ensure_ascii=False),encoding='utf-8')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def now():return datetime.now(timezone.utc).isoformat()
def read(p):
 with Path(p).open() as f:return list(csv.DictReader(f))
def write(p,cols,rows):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
 with p.open('w',newline='') as f:w=csv.writer(f);w.writerow(cols);w.writerows(rows)
def source_hashes():
 return {str(p.relative_to(ROOT)):sha(p) for top in ['tools','experiments'] for p in (ROOT/top).glob('*.py') if p.is_file()}
def baseline_check():
 b=json.loads((ROOT/'artifacts/baseline-source.json').read_text());assert all(sha(ROOT/'snapshot'/k)==v for k,v in b['nativeSourceHashes'].items())

def compute(task,workspace):
 w=Path(workspace);s=task['spec'];frames={k:read(w/s[k+'_csv']) for k in ['train','validation','test']}
 target=s['target'];y={k:np.asarray([float(r[target]) for r in rows]) for k,rows in frames.items()};numeric=s['numeric_features'];x={k:np.asarray([[float(r[col]) for col in numeric] for r in rows]) for k,rows in frames.items()}
 scaler=StandardScaler().fit(x['train']);x={k:scaler.transform(v) for k,v in x.items()}
 if task['kind']=='regression':
  if s.get('sex_categories'):
   for k in x:x[k]=np.column_stack([x[k],np.asarray([[float(r['sex']==sex) for sex in s['sex_categories']] for r in frames[k]])])
  ym=y['train'].mean();yc=y['train']-ym;xm=x['train'].mean(0);xc=x['train']-xm;fits=[]
  for c in s['candidates']:
   if c['family']=='ridge':
    beta=np.linalg.lstsq(np.vstack([xc,np.sqrt(c['alpha'])*np.eye(xc.shape[1])]),np.concatenate([yc,np.zeros(xc.shape[1])]),rcond=None)[0]
    pred={k:(x[k]-xm)@beta+ym for k in ['validation','test']}
   else:
    def kernel(a,b):return np.exp(-c['gamma']*np.maximum((a*a).sum(1)[:,None]+(b*b).sum(1)[None,:]-2*a@b.T,0))
    weights=np.linalg.solve(kernel(x['train'],x['train'])+c['alpha']*np.eye(len(x['train'])),yc)
    pred={k:kernel(x[k],x['train'])@weights+ym for k in ['validation','test']}
   fits.append({'candidate_id':c['id'],'validation_rmse':float(np.sqrt(np.mean((pred['validation']-y['validation'])**2))),'testPrediction':pred['test']})
  chosen=min(range(len(fits)),key=lambda i:fits[i]['validation_rmse']);best=fits[chosen];prediction=best['testPrediction'];metrics={'selected_candidate':best['candidate_id'],'n_eval':len(y['test']),'test_rmse':float(np.sqrt(np.mean((prediction-y['test'])**2))),'test_mae':float(np.mean(np.abs(prediction-y['test']))),'validation_results':[{k:v for k,v in f.items() if k!='testPrediction'} for f in fits]};return prediction,None,metrics
 else:
  fits=[]
  for c in s['candidates']:
   model=LogisticRegression(C=c['C'],solver='liblinear',penalty='l2',max_iter=5000,random_state=s['model_seed']) if c['family']=='logistic' else SVC(C=c['C'],gamma=c['gamma'],kernel='rbf',probability=False)
   model.fit(x['train'],y['train'].astype(int));pv=model.predict(x['validation']);sv=model.decision_function(x['validation']);pt=model.predict(x['test']);st=model.decision_function(x['test'])
   fits.append({'candidate_id':c['id'],'validation_balanced_accuracy':float(balanced_accuracy_score(y['validation'],pv)),'validation_roc_auc':float(roc_auc_score(y['validation'],sv)),'testPrediction':pt,'testScore':st})
  chosen=min(range(len(fits)),key=lambda i:(-fits[i]['validation_balanced_accuracy'],i));best=fits[chosen];prediction=best['testPrediction'];score=best['testScore'];metrics={'selected_candidate':best['candidate_id'],'n_eval':len(y['test']),'test_accuracy':float(accuracy_score(y['test'],prediction)),'test_balanced_accuracy':float(balanced_accuracy_score(y['test'],prediction)),'test_f1':float(f1_score(y['test'],prediction,pos_label=1)),'test_roc_auc':float(roc_auc_score(y['test'],score)),'validation_results':[{k:v for k,v in f.items() if k not in ['testPrediction','testScore']} for f in fits]};return prediction,score,metrics

def check(task,out):
 out=Path(out);expected=np.load(ROOT/'reference'/task['id']/'expected.npz');metrics=json.loads((ROOT/'reference'/task['id']/'metrics.json').read_text());parts={'prediction':False,'metrics':False};details=[]
 try:
  rows=read(out/'predictions.csv');ids=[str(r['row_id']) for r in rows];assert ids==expected['row_ids'].tolist(),'row ids/order differ'
  pred=np.asarray([float(r['prediction']) for r in rows]);assert pred.shape==expected['prediction'].shape and np.allclose(pred,expected['prediction'],rtol=1e-4,atol=1e-4),'predictions differ from requested procedure'
  if task['kind']=='classification':
   scores=np.asarray([float(r['decision_score']) for r in rows]);assert np.allclose(scores,expected['score'],rtol=1e-3,atol=1e-3),'decision_function scores differ'
  parts['prediction']=True
 except Exception as e:details.append('prediction:'+type(e).__name__+':'+str(e)[:400])
 try:
  got=json.loads((out/'metrics.json').read_text());assert got['selected_candidate']==metrics['selected_candidate'],'selected candidate is not validation-selected'
  assert got['n_eval']==metrics['n_eval'],'n_eval must count test rows'
  for key,value in metrics.items():
   if key in ['selected_candidate','n_eval','validation_results']:continue
   assert np.isfinite(float(got[key])) and np.isclose(got[key],value,rtol=1e-4,atol=1e-4),key+' must be computed on test'
  actual={v['candidate_id']:v for v in got['validation_results']};assert set(actual)=={r['candidate_id'] for r in metrics['validation_results']},'missing/extra validation candidates'
  for row in metrics['validation_results']:
   for key,value in row.items():
    if key!='candidate_id':assert np.isclose(actual[row['candidate_id']][key],value,rtol=1e-4,atol=1e-4),'validation metric mismatch'
  parts['metrics']=True
 except Exception as e:details.append('metrics:'+type(e).__name__+':'+str(e)[:400])
 return {'success':all(parts.values()),'parts':parts,'details':details}


def datasets():
 data={}
 sources={182:('slump_test.data',','),267:('data_banknote_authentication.txt',','),504:('qsar_fish_toxicity.csv',';'),252:('pop_failures.dat',None)}
 for uid,(name,sep) in sources.items():
  with zipfile.ZipFile(ROOT/'data'/f'uci-{uid}.zip') as z:text=z.read(name).decode().strip()
  lines=text.splitlines()
  if uid==182:
   a=np.asarray([[float(v) for v in l.split(',')] for l in lines[1:]]);x=a[:,1:8];y=a[:,-1];features=['cement','slag','fly_ash','water','superplasticizer','coarse_aggregate','fine_aggregate'];kind='regression'
  elif uid==267:
   a=np.asarray([[float(v) for v in l.split(',')] for l in lines]);x=a[:,:4];y=a[:,-1];features=['variance','skewness','kurtosis','entropy'];kind='classification'
  elif uid==504:
   a=np.asarray([[float(v) for v in l.split(';')] for l in lines]);x=a[:,:6];y=a[:,-1];features=['CIC0','SM1_DzZ','GATS1i','NdsCH','NdssC','MLOGP'];kind='regression'
  else:
   header=lines[0].split();a=np.asarray([[float(v) for v in l.split()] for l in lines[1:]]);x=a[:,2:-1];y=a[:,-1];features=header[2:-1];kind='classification'
  assert np.isfinite(x).all() and np.isfinite(y).all() and len(features)==x.shape[1]
  data[uid]={'x':x,'y':y,'features':features,'kind':kind}
 return data

def prepare():
 assert not (ROOT/'artifacts/protocol.json').exists();baseline_check();data=datasets();tasks=[]
 for index in range(12):
  train=index<8;variant=index//2 if train else (index-8)//2;uid=([182,267] if train else [504,252])[index%2];d=data[uid];x=d['x'];y=d['y'];rng=np.random.default_rng(2026101120+index);ident=f'TR{index:03d}' if train else f'EV{index-8:03d}';kind=d['kind'];n=min(len(y),900 if uid==267 else 500 if uid==504 else len(y));ids=rng.permutation(len(y))[:n];features=d['features']
  if kind=='regression':
   selected_cols=np.sort(rng.choice(len(features),size=max(4,len(features)-(variant%2)),replace=False));features=[features[i] for i in selected_cols];x=x[:,selected_cols]
   split={'train':ids[:int(n*.6)],'validation':ids[int(n*.6):int(n*.8)],'test':ids[int(n*.8):]};a0=[.05,.1,.2,.5][variant%4];g0=[.02,.05,.03,.1][variant%4]
   candidates=[{'id':f'RIDGE_A{a}','family':'ridge','alpha':a} for a in [a0,a0*10,a0*100]]+[{'id':f'KRR_A{a}_G{g}','family':'kernel_ridge','alpha':a,'gamma':g} for a in [a0,a0*10] for g in [g0,g0*4]]
  else:
   first,test=train_test_split(ids,test_size=.2,random_state=2026101200+index,stratify=y[ids]);fit,val=train_test_split(first,test_size=.25,random_state=2026101300+index,stratify=y[first]);split={'train':fit,'validation':val,'test':test};c0=[.1,.2,.5,1.][variant%4];g0=[.01,.02,.03,.05][variant%4]
   candidates=[{'id':f'LOGISTIC_C{c}','family':'logistic','C':c} for c in [c0,c0*10,c0*100]]+[{'id':f'SVC_C{c}_G{g}','family':'svc','C':c,'gamma':g} for c in [c0,c0*10,c0*100] for g in [g0,g0*10]]
  folder=ROOT/'tasks'/ident;folder.mkdir();target='target' if kind=='regression' else 'label';cols=['row_id']+features+[target]
  spec={'task_id':ident,'kind':kind,'source_uci_id':uid,'train_csv':'inputs/train.csv','validation_csv':'inputs/validation.csv','test_csv':'inputs/test.csv','numeric_features':features,'target':target,'candidates':candidates,'model_seed':2026101400+index,'selection':'minimum validation_rmse' if kind=='regression' else 'maximum validation_balanced_accuracy','tie_break':'first in candidate list','no_refit_on_validation':True}
  for part,indices in split.items():write(folder/spec[part+'_csv'],cols,[[str(int(i))]+x[int(i)].tolist()+[float(y[int(i)])] for i in indices])
  dump(folder/'inputs/task_spec.json',spec)
  common='Take over this scientific method-comparison experiment: inspect and analyse the supplied data, organise a plan, implement the methods, run the real experiment, check the results, and report limitations. The complete public specification is inputs/task_spec.json. CSV inputs have headers. Use ONLY numeric_features as predictors; never use row_id or target. Fit StandardScaler ONLY on TRAIN numeric features and reuse it on validation/test. Fit every candidate on ORIGINAL TRAIN only, with no refit on validation. Select only by the specified VALIDATION metric, with ties resolved by supplied candidate order.\n'
  method=('Compare linear Ridge (fit_intercept=True, supplied alpha) and RBF kernel ridge. Kernel is exp(-gamma*||x-z||^2). For kernel ridge subtract TRAIN target mean before fitting and add it back at prediction; no additional intercept or kernel centering. Evaluate all supplied candidates by VALIDATION RMSE. metrics.json: selected_candidate, n_eval (TEST rows), test_rmse, test_mae, validation_results (candidate_id and validation_rmse). All test_* metrics are from TEST targets and exported TEST predictions, not TRAIN or validation metrics.\n' if kind=='regression' else 'Compare L2 logistic regression (solver=liblinear, max_iter=5000, random_state=model_seed, supplied C) and RBF SVC (probability=False, supplied C/gamma). Preserve original binary labels 0/1; class1 is positive. Evaluate candidates using VALIDATION balanced accuracy and ROC-AUC. Export selected model TEST predictions plus decision_function scores oriented to class1. metrics.json: selected_candidate, n_eval (TEST rows), test_accuracy, test_balanced_accuracy, test_f1 (pos_label1), test_roc_auc, validation_results (candidate_id, validation_balanced_accuracy, validation_roc_auc). All test_* metrics use TEST targets and exported predictions/scores, not TRAIN/validation metrics.\n')
  outputs='Deliver run_experiment.py (additional modules allowed), accepting --output-dir with default results. Execute python run_experiment.py --output-dir results. Output predictions.csv with row_id and prediction in original TEST order, plus decision_score for classification, and metrics.json in that output dir. Write a substantive report.md explaining data, methods, validation selection, TEST results and limitations; report.md may be in the workspace root OR the output directory. There is no hidden minimum character count. A different --output-dir must reproduce numerical results. Use the installed numpy/pandas/scipy/sklearn Python on PATH. Stay inside the active workspace, no package/model downloads or paid API calls from your code; do not read reference programs, evaluator files or other projects. Real source and actual experiment execution are required, not placeholders or manually entered metrics. This is a small controlled study, not a SOTA or full-paper reproduction claim.'
  goal=common+method+outputs;(folder/'TASK.md').write_text(goal);t={'id':ident,'split':'train' if train else 'heldout','kind':kind,'source_uci_id':uid,'folder':str(folder),'spec':spec,'goal':goal};tasks.append(t)
  pred,score,m=compute(t,folder);ref=ROOT/'reference'/ident;ref.mkdir();row_ids=np.asarray([r['row_id'] for r in read(folder/spec['test_csv'])]);np.savez(ref/'expected.npz',prediction=pred,row_ids=row_ids,score=np.asarray([]) if score is None else score);dump(ref/'metrics.json',m);write(ref/'predictions.csv',['row_id','prediction']+(['decision_score'] if score is not None else []),[[rid,float(p)]+([float(v)] if score is not None else []) for rid,p,v in zip(row_ids,pred,np.zeros(len(pred)) if score is None else score)]);assert check(t,ref)['success']
 dump(ROOT/'artifacts/tasks.json',tasks)
 protocol={'id':'D2_EXECUTION_VERIFIED_TRAJECTORY_SFT','registeredAtUtc':now(),'researchHypothesis':'Execution-verified assistant-action trajectory SFT improves an unchanged coding student in the SAME complete native scientific Agent loop on unseen, dataset-disjoint tasks. This does not isolate filtering benefit from SFT itself.','nativeBaseline':json.loads((ROOT/'artifacts/baseline-source.json').read_text()),'sourceHashes':source_hashes(),'taskHash':sha(ROOT/'artifacts/tasks.json'),'inputHashes':{str(p.relative_to(ROOT)):sha(p) for p in (ROOT/'tasks').rglob('*') if p.is_file()},'trainTaskIds':[t['id'] for t in tasks if t['split']=='train'],'heldoutTaskIds':[t['id'] for t in tasks if t['split']=='heldout'],'trainDatasets':[182,267],'heldoutDatasets':[504,252],'datasetDisjoint':True,'noB1C1D1OrPaperBenchCases':True,'allReferencesVerified':12,'student':json.loads((ROOT/'artifacts/student-model.json').read_text()),'teacherModel':'deepseek-flash','route':'key2:deepseek-flash',
 'budget':{'wallSecondsPerTask':900,'physicalCallsPerTask':24,'conservativeTokensPerTask':2500000,'outputTokensPerCall':8192,'referenceBatchUsd':5,'sharedUtcDailyUsd':50,'teacherTrainAttempts':1},
 'dataAdmission':'Only Agent-produced scientific outputs, actual experiment invocation and independent source replay + numerical/method/selection checks all correct, plus publicly allowed report location; retain failed teacher attempts; no manual fixes or score-based reruns.',
 'stateSampling':'Per valid teacher trajectory: first inspection action, first todo/planning action, last Python-source write/edit contributing the final verified program, last experiment-run action after that source; one assistant turn per state, deterministic category order. No held-out messages or feedback in training.',
 'trainingFixedBeforeAnyStudentCall':{'algorithm':'Assistant-action-only causal SFT; tool observations are context, no loss on them','implementation':'HF/PEFT-compatible LoRA, no Runtime/controller changes','loraRank':16,'loraAlpha':32,'loraDropout':0,'targetModules':['q_proj','k_proj','v_proj','o_proj'],'epochs':2,'learningRate':2e-5,'optimizer':'AdamW','weightDecay':0,'gradientAccumulation':1,'microbatch':1,'warmupFraction':.08,'maxGradNorm':1,'seed':2026101500,'bf16':True,'gradientCheckpointing':True,'maxSequenceTokens':24576,'checkpointSelection':'Final checkpoint only; no held-out-driven hyperparameters or checkpoint selection'},
 'studentEvaluationFixedBeforeAnyStudentCall':{'sameFrozenNativeLoop':True,'beforeAfterModelAliasSame':True,'beforeAfterTokenizerChatTemplateParserSame':True,'rawModelIsBaseline':True,'tasks':4,'attemptsPerTaskPerArm':1,'maxPhysicalCalls':16,'wallSecondsPerTask':1200,'maxOutputTokens':4096,'temperature':.4,'topP':1,'noGrammarForcingOrArgumentCorrection':True,'generationSeedBase':2026101600},
 'continuationConditions':'At least4 verified teacher trajectories; if raw student scores4/4 then stop this completion-gain pilot as ceiling, do not train to manufacture improvement. Inspect no held-out qualitative feedback to change recipe. Raw result count only can trigger preregistered stop.',
 'primary':'Independent complete scientific procedure/code/Agent execution/numeric outputs/source replay with report in either PUBLICLY allowed location; +at least1 of4 new held-out tasks (25pp) vs raw, no general significance claim.',
 'resources':'GPU stage only after a safe free-device snapshot; no takeover of unknown/non-project GPU tasks. Data collection is API + CPU, no GPU training.',
 'scope':'8 fresh teacher train tasks +4 unseen dataset-disjoint held-out tasks, same2 scientific method families; not a public benchmark score, general reasoning claim, DPO/SDPO/RL run or production-model gain.',
 'gpuStageSourceFreeze':'Provider/trainer code must be frozen before the first raw student call; no changes between raw and SFT arms. Original data-stage protected source hashes remain unchanged; additional phase code cannot modify frozen scientific tasks or Native Runtime.'}
 dump(ROOT/'artifacts/protocol.json',protocol);print('D2_REGISTERED',json.dumps({'trainTasks':8,'heldoutUnobservedTasks':4,'allReferenceChecks':12,'datasetDisjoint':True,'studentWeightsLoaded':False,'gpuTrainingStarted':False}),flush=True)

def verify(ident):
 t=next(t for t in json.loads((ROOT/'artifacts/tasks.json').read_text()) if t['id']==ident);w=ROOT/'runs'/ident;before=check(t,w/'results');entry=w/'run_experiment.py';reports=[p for p in [w/'report.md',w/'results/report.md'] if p.is_file() and p.read_text().strip()];replay=None;exitcode=None
 if entry.is_file():
  env=dict(os.environ,PYTHONPATH=str(ROOT/'vendor'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
  try:
   p=subprocess.run([str(ROOT/'.venv-train/bin/python'),'run_experiment.py','--output-dir','_independent_replay'],cwd=w,env=env,capture_output=True,text=True,timeout=120);exitcode=p.returncode;(ROOT/'logs'/f'{ident}-replay.stdout.log').write_text(p.stdout);(ROOT/'logs'/f'{ident}-replay.stderr.log').write_text(p.stderr);replay=check(t,w/'_independent_replay') if p.returncode==0 else {'success':False,'details':[p.stderr[-1600:]]}
  except subprocess.TimeoutExpired:replay={'success':False,'details':['replay timeout']}
 v={'task':ident,'agentProducedOutputCheck':before,'sourceExists':entry.is_file(),'reportPaths':[str(p.relative_to(w)) for p in reports],'independentReplay':replay,'replayExitCode':exitcode,'verifiedSuccess':before['success'] and bool(replay and replay['success']) and bool(reports),'modelCalls':0};dump(ROOT/'artifacts/verification'/f'{ident}.json',v);print('D2_TEACHER_VERIFY',json.dumps(v),flush=True);return v
if __name__=='__main__':prepare() if sys.argv[1]=='prepare' else verify(sys.argv[2])
