param(
  [Parameter(Mandatory = $true)][string]$LaunchCmd,
  [Parameter(Mandatory = $true)][string]$TaskName
)

$ErrorActionPreference = "Stop"
$console = (query session) | Select-String -Pattern "^\s*console\s+" | Select-Object -First 1
if (-not $console) { throw "CONSOLE_SESSION_MISSING" }
$line = $console.ToString()
# Username may contain spaces (C5: "Thinkpad T14"). Take text between SESSIONNAME and the numeric session ID.
if ($line -notmatch '^\s*console\s+(.+?)\s+(\d+)\s+\S+') {
  throw "CONSOLE_PARSE $($line)"
}
$consoleUser = $Matches[1].Trim()
$sessionId = $Matches[2]
if (-not $consoleUser -or $consoleUser -match "^\d+$") { throw "CONSOLE_USER_MISSING $($line)" }

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $LaunchCmd"
$principal = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[ordered]@{
  console_user = $consoleUser
  session_id = $sessionId
  task = $TaskName
  last_result = $info.LastTaskResult
} | ConvertTo-Json -Compress
