"""Continue ONLY fixed training and SFT evaluation after all4 valid raw tasks completed."""
from pathlib import Path
import json,os,sys,time,signal,subprocess
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'tools'));import run_gpu_study_cli_fix as fixed

def main():
 cfg=json.loads(sys.stdin.readline());fixed.freeze_check();proof=json.loads((W/'artifacts/after-raw-continuation-freeze-20261012.json').read_text())
 assert all(fixed.e.sha(W/k)==v for k,v in proof['additionalSources'].items())
 assert fixed.e.sha(W/'artifacts/student-raw-results.json')==proof['rawResultsSha256']
 assert fixed.e.sha(W/'artifacts/student-raw-requests.jsonl')==proof['rawRequestsSha256']
 baseline=json.loads((W/'artifacts/student-raw-results.json').read_text());raw=baseline['rows'];count=baseline['verifiedSuccessCount']
 assert len(raw)==4 and all(x['protocolValid'] for x in raw) and count<4
 assert not (W/'artifacts/training/training-progress.json').exists() and not (W/'artifacts/training/final-adapter').exists()
 assert not (W/'evaluation-cli-fix/sft').exists()
 gpu=fixed.free_gpu();fixed.progress('LORA_SFT_TRAINING',rawSuccess=count,rawTotal=4,baselineNotRerun=True,epochs=2)
 start=time.monotonic();out=(W/'logs/student-lora-training.log').open('a')
 trainer=subprocess.Popen([fixed.PY,'-u',str(W/'experiments/train_action_lora.py')],cwd=W,env=dict(fixed.BASE_ENV,CUDA_VISIBLE_DEVICES=gpu),stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
 fixed.e.dump(W/'artifacts/training/launch.json',{'atUtc':fixed.stamp(),'pid':trainer.pid,'gpuUuid':gpu,'recipeAndTrainingCodeUnchanged':True,'baselineNotRerun':True})
 try:rc=trainer.wait(timeout=7200)
 except subprocess.TimeoutExpired:
  assert os.getpgid(trainer.pid)==trainer.pid;os.killpg(trainer.pid,signal.SIGTERM);trainer.wait(timeout=30);raise RuntimeError('Fixed training window expired; no adaptive retries')
 if rc:raise RuntimeError('Fixed LoRA training failed; recipe not changed')
 trained=json.loads((W/'artifacts/training/TRAINING_RESULTS.json').read_text());assert trained['gradientUpdates']==54
 # Await release only after OUR OWN successful training process exited, never compete with another GPU job.
 deadline=time.monotonic()+60
 while True:
  try:fixed.free_gpu();break
  except RuntimeError:
   if time.monotonic()>=deadline:raise RuntimeError('GPU remains occupied after own trainer exit; preserve final checkpoint, do not share')
   time.sleep(2)
 fixed.freeze_check();after=fixed.run_arm('sft',cfg);new=sum(x['verifiedSuccess'] for x in after);gain=new-count
 resources={arm:json.loads((W/'artifacts'/('student-'+arm+'-resources.json')).read_text()) for arm in ['raw','sft']}
 result={'status':'COMPARISON_COMPLETE','atUtc':fixed.stamp(),'rawSuccess':count,'sftSuccess':new,'tasksPerArm':4,'completionGainPercentagePoints':25*gain,'rawResults':raw,'sftResults':after,'training':trained,'gpuResources':resources,'totalAllocatedGpuHours':trained['gpuHours']+sum(x['modelServiceAllocationGpuHours'] for x in resources.values()),'algorithmGainEstablished':gain>=1,'researchGoalAchieved':gain>=1,'claim':'Exploratory paired4-task student-model result only; not production gain, significance, or verification-filter ablation','model':'Qwen/Qwen2.5-Coder-7B-Instruct','revision':'c03e6d358207e414f1eca0bb1891e29f1db0e242','nativeRuntimeModified':False,'teacherTrainPoolChanged':False,'apiCostUsd':0,'gpuCostNotMonetized':True,'rawBaselineNotRerun':True,'continuationWallSeconds':time.monotonic()-start,'invalidPremodelAttemptPreservedAt':str(W/'artifacts/cli-launch-invalid-20261012')}
 fixed.e.dump(W/'artifacts/FINAL_GPU_RESULTS.json',result);fixed.progress('COMPARISON_COMPLETE',rawSuccess=count,sftSuccess=new,completionGainPercentagePoints=25*gain,researchGoalAchieved=gain>=1)
if __name__=='__main__':
 try:main()
 except Exception as ex:
  fixed.stop_server();error={'status':'GPU_STAGE_BLOCKED_OR_FAILED','atUtc':fixed.stamp(),'error':type(ex).__name__+': '+str(ex),'completedRawBaselinePreserved':True,'noAutomaticTaskOrTrainingRerun':True,'researchGoalAchieved':False};fixed.e.dump(W/'artifacts/GPU_STAGE_ERROR.json',error);fixed.progress('GPU_STAGE_BLOCKED_OR_FAILED',error=error['error']);raise
