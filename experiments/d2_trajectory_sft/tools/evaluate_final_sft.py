"""Evaluate ONLY the already saved final LoRA, same frozen model service and full Agent loop."""
from pathlib import Path
import os,sys,json,time
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'tools'));import run_gpu_study_cli_fix as fixed
original_setup=fixed.arm_setup

def empty_existing_sft(arm):
 assert arm=='sft';a=W/'evaluation-cli-fix/sft'
 assert a.is_dir()
 assert not (W/'artifacts/student-sft-requests.jsonl').exists() and not (W/'artifacts/student-sft-results.json').exists()
 for name in ['runs','logs','artifacts/task-starts','artifacts/task-runs','artifacts/verification']:assert not list((a/name).iterdir())
 for name,target in {'vendor':W/'vendor','.venv-train':W/'.venv-train','snapshot':W/'snapshot','reference':W/'reference','artifacts/tasks.json':W/'artifacts/tasks.json','artifacts/baseline-source.json':W/'artifacts/baseline-source.json'}.items():assert (a/name).is_symlink() and (a/name).resolve()==target.resolve()
 return a
fixed.arm_setup=empty_existing_sft

def main():
 cfg=json.loads(sys.stdin.readline());fixed.freeze_check();proof=json.loads((W/'artifacts/final-sft-evaluation-freeze-20261012.json').read_text());assert fixed.e.sha(W/'tools/evaluate_final_sft.py')==proof['evaluationEntrySha256']
 assert fixed.e.sha(W/'artifacts/student-raw-results.json')==proof['rawResultsSha256'];assert fixed.e.sha(W/'artifacts/training/TRAINING_RESULTS.json')==proof['trainingResultSha256']
 for name,h in proof['finalAdapterFiles'].items():assert fixed.e.sha(W/'artifacts/training/final-adapter'/name)==h
 baseline=json.loads((W/'artifacts/student-raw-results.json').read_text());raw=baseline['rows'];trained=json.loads((W/'artifacts/training/TRAINING_RESULTS.json').read_text());assert trained['gradientUpdates']==54 and baseline['completed']==4 and baseline['protocolValidCount']==4
 fixed.free_gpu();fixed.progress('FINAL_SFT_EVALUATION_STARTING',rawSuccess=baseline['verifiedSuccessCount'],rawTotal=4,gradientUpdates=54,noTrainingOrRawRerun=True)
 start=time.monotonic();after=fixed.run_arm('sft',cfg);new=sum(x['verifiedSuccess'] for x in after);count=baseline['verifiedSuccessCount'];gain=new-count
 resources={arm:json.loads((W/'artifacts'/('student-'+arm+'-resources.json')).read_text()) for arm in ['raw','sft']}
 result={'status':'COMPARISON_COMPLETE','atUtc':fixed.stamp(),'rawSuccess':count,'sftSuccess':new,'tasksPerArm':4,'completionGainPercentagePoints':25*gain,'rawResults':raw,'sftResults':after,'training':trained,'gpuResources':resources,'totalAllocatedGpuHours':trained['gpuHours']+sum(x['modelServiceAllocationGpuHours'] for x in resources.values()),'algorithmGainEstablished':gain>=1,'researchGoalAchieved':gain>=1,'claim':'Exploratory paired4-task student-model result only; not production gain, significance, or verification-filter ablation','model':'Qwen/Qwen2.5-Coder-7B-Instruct','revision':'c03e6d358207e414f1eca0bb1891e29f1db0e242','nativeRuntimeModified':False,'teacherTrainPoolChanged':False,'apiCostUsd':0,'gpuCostNotMonetized':True,'rawBaselineNotRerun':True,'trainingNotRerun':True,'finalEvaluationWallSeconds':time.monotonic()-start,'premodelInvalidAttemptPreservedAt':str(W/'artifacts/cli-launch-invalid-20261012')}
 fixed.e.dump(W/'artifacts/FINAL_GPU_RESULTS.json',result);fixed.progress('COMPARISON_COMPLETE',rawSuccess=count,sftSuccess=new,completionGainPercentagePoints=25*gain,researchGoalAchieved=gain>=1)
if __name__=='__main__':
 try:main()
 except Exception as ex:
  fixed.stop_server();error={'status':'GPU_STAGE_BLOCKED_OR_FAILED','atUtc':fixed.stamp(),'error':type(ex).__name__+': '+str(ex),'completedRawAndTrainingPreserved':True,'noAutomaticTaskOrTrainingRerun':True,'researchGoalAchieved':False};fixed.e.dump(W/'artifacts/GPU_STAGE_ERROR.json',error);fixed.progress('GPU_STAGE_BLOCKED_OR_FAILED',error=error['error']);raise
