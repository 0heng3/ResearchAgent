"""Fixed two-epoch assistant-action-only LoRA SFT. Reads TRAIN states only."""
from pathlib import Path
from datetime import datetime,timezone
import json,os,time,hashlib,math,sys
W=Path(__file__).resolve().parents[1]
def dump(name,obj):
 p=W/'artifacts/training'/name;tmp=p.with_suffix(p.suffix+'.new');tmp.write_text(json.dumps(obj,indent=2));os.replace(tmp,p)
def run():
 import torch
 import torch.nn.functional as F
 from transformers import AutoModelForCausalLM,get_linear_schedule_with_warmup
 from peft import LoraConfig,get_peft_model
 protocol=json.loads((W/'artifacts/protocol.json').read_text());cfg=protocol['trainingFixedBeforeAnyStudentCall'];report=json.loads((W/'artifacts/training/DATASET_RESULTS.json').read_text())
 path=W/'artifacts/training/verified-action-sft.jsonl';raw=path.read_bytes();assert hashlib.sha256(raw).hexdigest()==report['datasetSha256']
 data=[json.loads(x) for x in raw.decode().splitlines()];assert len(data)==27
 assert all(r['task'] in protocol['trainTaskIds'] and not r['heldoutDataUsed'] and len(r['input_ids'])<=cfg['maxSequenceTokens'] for r in data)
 assert cfg['epochs']==2 and cfg['microbatch']==1 and cfg['gradientAccumulation']==1
 final=W/'artifacts/training/final-adapter';assert not final.exists(),'Final adapter already exists; no checkpoint selection or silent rerun'
 torch.manual_seed(cfg['seed']);torch.cuda.manual_seed_all(cfg['seed']);torch.cuda.reset_peak_memory_stats();start=time.monotonic()
 base=AutoModelForCausalLM.from_pretrained(str(W/'models/Qwen2.5-Coder-7B-Instruct'),torch_dtype=torch.bfloat16,device_map={'':0},attn_implementation='sdpa',local_files_only=True,low_cpu_mem_usage=True)
 base.config.use_cache=False
 model=get_peft_model(base,LoraConfig(r=cfg['loraRank'],lora_alpha=cfg['loraAlpha'],lora_dropout=cfg['loraDropout'],target_modules=cfg['targetModules'],bias='none',task_type='CAUSAL_LM'))
 model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False});model.enable_input_require_grads();model.train()
 params=[p for p in model.parameters() if p.requires_grad];optimizer=torch.optim.AdamW(params,lr=cfg['learningRate'],weight_decay=cfg['weightDecay'],betas=(0.9,0.999),eps=1e-8)
 total=len(data)*cfg['epochs'];warmup=math.ceil(total*cfg['warmupFraction']);scheduler=get_linear_schedule_with_warmup(optimizer,num_warmup_steps=warmup,num_training_steps=total)
 decoder=model.get_base_model().model;head=model.get_base_model().lm_head;step=0;history=[];trainable=sum(p.numel() for p in params)
 dump('training-progress.json',{'status':'TRAINING','steps':0,'totalSteps':total,'trainableParameters':trainable,'supervisedAssistantTokensPerEpoch':report['totalSupervisedAssistantTokens'],'loss':'assistant-action tokens only','wallSeconds':time.monotonic()-start})
 for epoch in range(cfg['epochs']):
  order=torch.randperm(len(data),generator=torch.Generator().manual_seed(cfg['seed']+epoch)).tolist()
  for index in order:
   row=data[index];ids=torch.tensor([row['input_ids']],device='cuda:0');labels=torch.tensor([row['labels']],device='cuda:0');mask=labels[:,1:]!=-100
   assert mask.any();assert torch.equal(ids[labels!=-100],labels[labels!=-100])
   optimizer.zero_grad(set_to_none=True)
   # Exact masked causal CE, without constructing logits for unsupervised prefix positions.
   hidden=decoder(input_ids=ids,attention_mask=torch.ones_like(ids),use_cache=False,return_dict=True).last_hidden_state
   logits=head(hidden[:,:-1,:][mask]);loss=F.cross_entropy(logits.float(),labels[:,1:][mask]);assert torch.isfinite(loss)
   loss.backward();norm=torch.nn.utils.clip_grad_norm_(params,cfg['maxGradNorm']);assert torch.isfinite(norm)
   optimizer.step();scheduler.step();step+=1
   entry={'step':step,'epoch':epoch+1,'task':row['task'],'phase':row['phase'],'sequenceTokens':len(row['input_ids']),'supervisedTokens':int(mask.sum()),'loss':float(loss.detach()),'gradientNorm':float(norm),'learningRateNext':scheduler.get_last_lr()[0],'wallSeconds':time.monotonic()-start}
   history.append(entry)
   with (W/'artifacts/training/training-steps.jsonl').open('a') as f:f.write(json.dumps(entry)+'\n')
   print('TRAIN_STEP',json.dumps(entry),flush=True)
   dump('training-progress.json',dict(entry,status='TRAINING',totalSteps=total,trainableParameters=trainable))
   del ids,labels,mask,hidden,logits,loss
 model.save_pretrained(final,safe_serialization=True)
 result={'status':'TRAINING_COMPLETE','finishedAtUtc':datetime.now(timezone.utc).isoformat(),'gradientUpdates':step,'epochs':cfg['epochs'],'trainableParameters':trainable,'trainExamples':len(data),'supervisedAssistantTokensPerEpoch':report['totalSupervisedAssistantTokens'],'sequenceTokensPerEpoch':report['totalInputAndTargetTokens'],'firstLoss':history[0]['loss'],'lastLoss':history[-1]['loss'],'wallSeconds':time.monotonic()-start,'gpuHours':(time.monotonic()-start)/3600,'peakGpuAllocatedBytes':torch.cuda.max_memory_allocated(),'adapterPath':str(final),'heldoutExamplesUsed':0,'checkpointChoice':'final only','hyperparameters':cfg,'studentModel':protocol['student']['repository'],'studentRevision':protocol['student']['revision'],'algorithmGainEstablished':False}
 dump('TRAINING_RESULTS.json',result);dump('training-progress.json',result);print('TRAINING_COMPLETE',json.dumps(result),flush=True)
if __name__=='__main__':
 try:run()
 except Exception as e:
  dump('TRAINING_ERROR.json',{'status':'TRAINING_FAILED','error':type(e).__name__+': '+str(e),'atUtc':datetime.now(timezone.utc).isoformat()});raise
