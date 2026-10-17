$env:VRC_RESULTS_ROOT = 'D:\Program\spark-main\spark-main\vrc-paper\results_retest_20260513_v1'
Remove-Item Env:\VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue
& 'D:\Program\spark-main\spark-main\vrc-paper\_launch_master.ps1'
