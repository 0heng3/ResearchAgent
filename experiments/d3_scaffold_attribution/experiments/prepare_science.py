from pathlib import Path
from datetime import datetime,timezone
import csv,json,os,sys,io,zipfile,urllib.request,hashlib
import numpy as np
from sklearn.model_selection import train_test_split
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'experiments'));import science as e
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
D2=W.parent/'researchagent-trajectory-sft-d2-20261011';old=json.loads((D2/'artifacts/tasks.json').read_text());sources=[];tasks=[]
for ident,uci,slug,kind,seed in [('SC000',186,'wine+quality','regression',2026102100),('SC001',94,'spambase','classification',2026102101)]:
 url=f'https://archive.ics.uci.edu/static/public/{uci}/{slug}.zip'
 with urllib.request.urlopen(url,timeout=60) as r:raw=r.read()
 source=W/'data'/f'uci-{uci}.zip';source.parent.mkdir(exist_ok=True);source.write_bytes(raw);z=zipfile.ZipFile(io.BytesIO(raw))
 if kind=='regression':
  member=next(n for n in z.namelist() if n.endswith('winequality-red.csv'));allrows=list(csv.DictReader(io.StringIO(z.read(member).decode()),delimiter=';'));cols=[c for c in allrows[0] if c!='quality'];target='quality';y=np.asarray([float(r[target]) for r in allrows]);indices=np.random.default_rng(seed).choice(len(allrows),size=512,replace=False)
 else:
  member=next(n for n in z.namelist() if n.endswith('spambase.data'));allvalues=np.loadtxt(io.BytesIO(z.read(member)),delimiter=',');cols=[f'feature_{i:02d}' for i in range(57)];target='spam';allrows=[dict(zip(cols+[target],map(float,row))) for row in allvalues];y=allvalues[:,-1];indices,_=train_test_split(np.arange(len(allrows)),train_size=512,stratify=y,random_state=seed)
 train,remaining=train_test_split(indices,train_size=320,random_state=seed+1,stratify=y[indices] if kind=='classification' else None);val,test=train_test_split(remaining,train_size=96,random_state=seed+2,stratify=y[remaining] if kind=='classification' else None)
 folder=W/'tasks'/ident;(folder/'inputs').mkdir(parents=True)
 for split,ids in [('train',train),('validation',val),('test',test)]:e.write(folder/'inputs'/f'{split}.csv',['row_id']+cols+[target],[[f'uci{uci}_{int(i):05d}']+[allrows[int(i)][c] for c in cols]+[allrows[int(i)][target]] for i in ids])
 spec={'task_id':ident,'source_uci_id':uci,'train_csv':'inputs/train.csv','validation_csv':'inputs/validation.csv','test_csv':'inputs/test.csv','target':target,'numeric_features':cols,'model_seed':seed,'fit_on':'train only; select on validation; no train+validation refit','metric_split':'test','n_eval_definition':'number of test rows'}
 if kind=='regression':spec['candidates']=[{'id':f'R_A{a}','family':'ridge','alpha':a} for a in [0.1,1.0,10.0]]+[{'id':f'K_A{a}_G{g}','family':'kernel','alpha':a,'gamma':g} for a,g in [(0.1,0.05),(1.,0.05),(0.1,0.2),(1.,0.2)]]
 else:spec['candidates']=[{'id':f'L_C{c}','family':'logistic','C':c} for c in [0.1,1.,10.]]+[{'id':f'S_C{c}_G{g}','family':'svc','C':c,'gamma':g} for c,g in [(1.,0.01),(10.,0.01),(1.,0.1),(10.,0.1)]]
 goal=next(t['goal'] for t in old if t['kind']==kind)+'\n\nDataset provenance: UCI '+str(uci)+('. Red Wine Quality physicochemical measurements.' if kind=='regression' else '. Spambase email numeric features; label1 is spam.')+' All data and candidate definitions are in inputs/task_spec.json and the provided CSVs.'
 e.dump(folder/'inputs/task_spec.json',spec);(folder/'TASK.md').write_text(goal);t={'id':ident,'kind':kind,'folder':str(folder),'goal':goal,'spec':spec};tasks.append(t)
 pred,score,metrics=e.compute(t,folder);pred2,score2,metrics2=e.compute(t,folder);assert np.allclose(pred,pred2,rtol=1e-10,atol=1e-10) and metrics==metrics2
 out=W/'reference'/ident;out.mkdir(parents=True);kw={'row_ids':np.asarray([r['row_id'] for r in e.read(folder/'inputs/test.csv')]),'prediction':pred}
 if score is not None:assert np.allclose(score,score2);kw['score']=score
 np.savez(out/'expected.npz',**kw);e.dump(out/'metrics.json',metrics)
 sources.append({'task':ident,'uciId':uci,'url':url,'zipSha256':sha(source),'member':member,'originalRows':len(allrows),'sampledRows':512,'train':320,'validation':96,'test':96,'seed':seed,'freshVersusPriorStudyUciIds':[1,9,52,182,252,267,291,504],'referenceDeterministicChecks':2})
e.dump(W/'artifacts/tasks.json',tasks);e.dump(W/'artifacts/data-sources.json',sources)
print('FRESH_TASK_POOL_READY',json.dumps([{k:t[k] for k in ['id','kind']} for t in tasks]));print('INDEPENDENT_REFERENCE_STABLE',len(tasks));print('inputFiles',sum(1 for p in (W/'tasks').rglob('*') if p.is_file()))
