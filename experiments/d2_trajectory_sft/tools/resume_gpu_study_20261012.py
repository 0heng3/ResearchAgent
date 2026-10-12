"""Human-authorized D2 resume after PRE-MODEL GPU denial; no student task may be repeated."""
from pathlib import Path
import sys,json,os,time
W=Path(__file__).resolve().parents[1];sys.path.insert(0,str(W/'tools'));import run_gpu_study as base
original_freeze=base.freeze_check;original_setup=base.arm_setup

def freeze_with_resume():
 original_freeze();f=json.loads((W/'artifacts/gpu-resume-source-freeze-20261012.json').read_text())
 assert all(base.e.sha(W/k)==v for k,v in f['additionalSources'].items())
 assert base.e.sha(W/'artifacts/gpu-stage-source-freeze.json')==f['originalFreezeSha256']

def empty_arm_only(arm):
 # Check resource eligibility BEFORE touching or creating an evaluation directory.
 base.free_gpu();a=W/'evaluation'/arm
 if not a.exists():return original_setup(arm)
 for name in ['student-'+arm+'-requests.jsonl','student-'+arm+'-results.json','student-'+arm+'-rejections.jsonl']:
  assert not (W/'artifacts'/name).exists(),'Prior student execution exists: no automatic task replay'
 required={'vendor':W/'vendor','.venv-train':W/'.venv-train','snapshot':W/'snapshot','reference':W/'reference','artifacts/tasks.json':W/'artifacts/tasks.json','artifacts/baseline-source.json':W/'artifacts/baseline-source.json'}
 for name,target in required.items():
  p=a/name;assert p.is_symlink() and p.resolve()==target.resolve(),('Unexpected prior symlink',name)
 for name in ['runs','logs','artifacts/task-starts','artifacts/task-runs','artifacts/verification']:
  p=a/name;assert p.is_dir() and not list(p.iterdir()),('Prior attempt/nonempty workspace',name)
 expected={'vendor','.venv-train','snapshot','reference','runs','logs','artifacts'}
 assert {p.name for p in a.iterdir()}==expected
 assert {p.name for p in (a/'artifacts').iterdir()}=={'tasks.json','baseline-source.json','task-starts','task-runs','verification'}
 base.e.dump(W/'artifacts/gpu-resume-empty-workspace-check.json',{'atUtc':base.stamp(),'arm':arm,'path':str(a),'priorStudentAttempts':0,'noDeleteOrMove':True,'originalSourcesUnchanged':True})
 return a

base.freeze_check=freeze_with_resume;base.arm_setup=empty_arm_only
if __name__=='__main__':
 try:base.main()
 except Exception as ex:
  base.stop_server();error={'status':'GPU_STAGE_BLOCKED_OR_FAILED','atUtc':base.stamp(),'error':type(ex).__name__+': '+str(ex),'humanAuthorizedResume':True,'noAutomaticTaskRerun':True,'researchGoalAchieved':False};base.e.dump(W/'artifacts/GPU_STAGE_ERROR.json',error);base.progress('GPU_STAGE_BLOCKED_OR_FAILED',error=error['error']);raise
