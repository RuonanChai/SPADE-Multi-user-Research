$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_retest_$ts"
Remove-Item Env:\VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue
& 'D:\Program\spark-main\spark-main\vrc-paper\_launch_master.ps1'
