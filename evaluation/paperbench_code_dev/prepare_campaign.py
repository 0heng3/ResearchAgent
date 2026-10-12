from __future__ import annotations
import hashlib,json,re,shutil,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import httpx
B=Path(__file__).resolve().parent
R=B.parents[2]
OLD=R/'artifacts/benchmarks/paperbench-mle-20261006-r4'
AGENT=Path(r'E:\code\COG-related works\COG-CLAW-main')
COMMIT=json.loads((OLD/'source.json').read_text())['commit']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if (B/'prepared.json').exists():raise SystemExit('Already prepared; no replacement permitted')
for name in ('src','config'):
    target=B/'agent-snapshot'/name
    if name=='src':shutil.copytree(AGENT/name,target)
    else:
        target.mkdir(parents=True)
        shutil.copyfile(AGENT/name/'cogclaw.capabilities.json',target/'cogclaw.capabilities.json')
for name in ('package.json','package-lock.json','tsconfig.json'):
    shutil.copyfile(AGENT/name,B/'agent-snapshot'/name)
for rel in ('paperbench','common/preparedness_turn_completer'):
    shutil.copytree(OLD/'official/project'/rel,B/'official/project'/rel)
for name in ('metered_transport_pooled.py','judge_bridge.py'):
    shutil.copyfile(OLD/name,B/name)
shutil.copyfile(OLD/'source.json',B/'official-source.json')
PB=B/'official/project/paperbench'
ids=[x.strip() for x in (PB/'experiments/splits/all.txt').read_text().splitlines() if x.strip()]
assert len(ids)==20 and len(set(ids))==20
raw=json.loads((R/'artifacts/benchmarks/paperbench-20-analysis-20261006/official-20-leaf-counts.json').read_text())
assert [x['paperId'] for x in raw]==ids
save(B/'leaf-counts.json',raw)
caches=[Path(r'E:\code\COG-related works\cog-paperbench\bench\project\paperbench\data\papers')]
items=[]
for ident in ids:
    for p in (PB/'data/papers'/ident).rglob('*'):
        if p.is_file() and p.stat().st_size<512:
            data=p.read_bytes()
            if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
                oid=re.search(rb'oid sha256:([a-f0-9]{64})',data).group(1).decode()
                size=int(re.search(rb'size (\d+)',data).group(1))
                items.append((p,oid,size))
print('LFS_PENDING',len(items),'BYTES',sum(x[2] for x in items),flush=True)
def hydrate(item):
    p,oid,size=item
    rel=p.relative_to(PB/'data/papers')
    for cache in caches:
        candidate=cache/rel
        if candidate.is_file() and candidate.stat().st_size==size and sha(candidate)==oid:
            shutil.copyfile(candidate,p)
            return {'path':str(rel),'oid':oid,'bytes':size,'source':'verified-local-official-input-cache'}
    url='https://media.githubusercontent.com/media/openai/frontier-evals/'+COMMIT+'/project/paperbench/data/papers/'+rel.as_posix()
    error=None
    for attempt in range(3):
        try:
            with httpx.Client(timeout=90,follow_redirects=True) as client:
                response=client.get(url);response.raise_for_status();body=response.content
            if len(body)!=size or hashlib.sha256(body).hexdigest()!=oid:
                raise ValueError('official LFS content size/hash mismatch')
            p.write_bytes(body)
            return {'path':str(rel),'oid':oid,'bytes':size,'source':'official-media-pinned-commit'}
        except Exception as e:
            error=type(e).__name__+': '+str(e);time.sleep(2*(attempt+1))
    return {'path':str(rel),'oid':oid,'bytes':size,'error':error}
results=[]
with ThreadPoolExecutor(max_workers=4) as pool:
    futures=[pool.submit(hydrate,x) for x in items]
    for f in as_completed(futures):
        result=f.result();results.append(result)
        save(B/'hydration-progress.json',results)
        if len(results)%20==0 or result.get('error'):print('LFS_PROGRESS',len(results),'/',len(items),'ERRORS',sum(bool(x.get('error')) for x in results),flush=True)
errors=[x for x in results if x.get('error')]
if errors:raise SystemExit('Official input hydration incomplete; no Agent call allowed')
all_hashes={str(p.relative_to(PB/'data/papers')):sha(p) for ident in ids for p in (PB/'data/papers'/ident).rglob('*') if p.is_file()}
for ident in ids:
    for name in ('paper.md','paper.pdf','rubric.json','blacklist.txt'):
        p=PB/'data/papers'/ident/name
        assert p.exists() and not p.read_bytes().startswith(b'version https://git-lfs.github.com/spec/v1')
snapshot=B/'agent-snapshot'
agent_hashes={str(p.relative_to(snapshot)):sha(p) for p in snapshot.rglob('*') if p.is_file()}
assert all(sha(AGENT/k)==v for k,v in agent_hashes.items())
save(B/'input-hashes.json',all_hashes)
save(B/'agent-hashes.json',agent_hashes)
save(B/'prepared.json',{'paperIds':ids,'paperCount':20,'commit':COMMIT,'inputFiles':len(all_hashes),'lfsHydratedFiles':len(results),'hydratedBytes':sum(x['bytes'] for x in results),'agentOriginalRoot':str(AGENT),'agentSnapshot':str(snapshot),'agentFiles':len(agent_hashes),'newModelCalls':0})
print('PREPARED',20,'papers;',len(all_hashes),'verified input files;',len(agent_hashes),'frozen Agent files',flush=True)
