"""Download public pinned student weights, preserve interrupted transfers, verify official LFS hashes."""
from pathlib import Path
from datetime import datetime,timezone
from concurrent.futures import ThreadPoolExecutor
import json,hashlib,os,shutil,time,threading,urllib.request
W=Path(__file__).resolve().parents[1]
M=W/'models/Qwen2.5-Coder-7B-Instruct';M.mkdir(parents=True,exist_ok=True)
S=json.loads((W/'artifacts/student-model.json').read_text())
LOCK=threading.Lock();PROGRESS={};START=time.monotonic()
def write(name,value):
 p=W/'artifacts'/name;tmp=p.with_suffix(p.suffix+'.new');tmp.write_text(json.dumps(value,indent=2));os.replace(tmp,p)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def status(name,n,total,state):
 with LOCK:
  PROGRESS[name]={'bytes':n,'total':total,'status':state}
  write('download-progress.json',{'utc':datetime.now(timezone.utc).isoformat(),'wallSeconds':time.monotonic()-START,'files':PROGRESS})
for name,expected in S['smallFileHashes'].items():
 p=W/'model-metadata'/name
 assert sha(p)==expected,('metadata hash',name)
 dest=M/name
 if dest.exists():assert sha(dest)==expected
 else:shutil.copyfile(p,dest)
def download(info):
 name=info['file'];target=M/name;part=M/(name+'.part');total=info['size'];expected=info['lfs']['sha256']
 if target.exists():
  assert target.stat().st_size==total and sha(target)==expected,('existing weight mismatch',name)
  status(name,total,total,'verified');return {'file':name,'sha256':expected,'size':total}
 url='https://huggingface.co/'+S['repository']+'/resolve/'+S['revision']+'/'+name
 for attempt in range(1,4):
  pos=part.stat().st_size if part.exists() else 0
  try:
   if pos<total:
    req=urllib.request.Request(url,headers={'Range':f'bytes={pos}-'} if pos else {})
    with urllib.request.urlopen(req,timeout=90) as response:
     if pos and response.status!=206:raise RuntimeError('Server did not honor resume range; partial file retained')
     with part.open('ab' if pos else 'wb') as out:
      last=time.monotonic()
      while True:
       chunk=response.read(4*1024*1024)
       if not chunk:break
       out.write(chunk);pos+=len(chunk)
       if time.monotonic()-last>3:status(name,pos,total,'downloading');last=time.monotonic()
   assert pos==total,('weight size',name,pos,total)
   status(name,pos,total,'hashing');actual=sha(part)
   assert actual==expected,('weight hash',name,actual,expected)
   os.replace(part,target);status(name,total,total,'verified')
   print('WEIGHT_VERIFIED',name,total,expected,flush=True)
   return {'file':name,'sha256':actual,'size':total}
  except Exception as e:
   status(name,pos,total,'attempt_failed_'+str(attempt));print('DOWNLOAD_ERROR',name,attempt,type(e).__name__,str(e),flush=True)
   if attempt==3:raise
   time.sleep(5*attempt)
try:
 with ThreadPoolExecutor(max_workers=2) as pool:verified=list(pool.map(download,S['officialWeightMetadata']))
 result={'status':'WEIGHTS_VERIFIED','utc':datetime.now(timezone.utc).isoformat(),'model':S['repository'],'revision':S['revision'],'files':verified,'wallSeconds':time.monotonic()-START,'path':str(M),'publicUnauthenticatedDownload':True}
 write('download-result.json',result);print(json.dumps(result),flush=True)
except Exception as e:
 write('download-result.json',{'status':'DOWNLOAD_INCOMPLETE','error':type(e).__name__+': '+str(e),'utc':datetime.now(timezone.utc).isoformat(),'partialFilesPreserved':True});raise
