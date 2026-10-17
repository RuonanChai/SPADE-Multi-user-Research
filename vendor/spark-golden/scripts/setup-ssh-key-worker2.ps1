# One-time: local ed25519 key + append to Worker2 (Windows OpenSSH) authorized_keys.
# PowerShell 5.1: save this file as UTF-8 with BOM, or use ASCII only + -RemoteUser.
# Usage:
#   .\\setup-ssh-key-worker2.ps1 -RemoteUser "YourWorker2AccountName"
#   $env:SPARK_SSH_USER = "YourWorker2AccountName"; .\\setup-ssh-key-worker2.ps1
param(
  [string]$RemoteHost = "10.4.146.68",
  [string]$RemoteUser = "",
  [string]$KeyName = "id_ed25519_spark_bench"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RemoteUser)) {
  $RemoteUser = $env:SPARK_SSH_USER
}
if ([string]::IsNullOrWhiteSpace($RemoteUser)) {
  Write-Error "Set -RemoteUser to the Worker2 Windows user name, or set env var SPARK_SSH_USER, then re-run."
  exit 1
}

$sshDir = Join-Path $env:USERPROFILE ".ssh"
$priv = Join-Path $sshDir $KeyName
$pub = "$priv.pub"

if (-not (Test-Path $sshDir)) {
  New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
}

if (-not (Test-Path $pub)) {
  Write-Host "Generating key: $priv"
  ssh-keygen -t ed25519 -f $priv -N '""' -C "spark-bench-dual-260424"
} else {
  Write-Host "Using existing key: $pub"
}

$remoteName = "spark_bench_key_upload.pub"
$localPubPath = (Resolve-Path $pub).Path

Write-Host "Uploading public key to ${RemoteUser}@${RemoteHost} as $remoteName (enter password if prompted)..."
scp -o "StrictHostKeyChecking=accept-new" $localPubPath ("${RemoteUser}@${RemoteHost}:" + $remoteName)

Write-Host "Appending to authorized_keys (enter password if prompted)..."
# Use -EncodedCommand to avoid -f / brace parsing errors (if { } in -Command breaks -f format strings).
$remoteBlock = @"
New-Item -Force -ItemType Directory -Path (Join-Path `$env:USERPROFILE '.ssh') | Out-Null
`$f = Join-Path `$env:USERPROFILE "$remoteName"
`$a = Join-Path (Join-Path `$env:USERPROFILE '.ssh') 'authorized_keys'
if (Test-Path `$f) {
  Get-Content `$f | Add-Content `$a
  Remove-Item `$f -ErrorAction SilentlyContinue
  'OK'
} else {
  'MISSING_FILE'
  exit 1
}
"@
$encBytes = [System.Text.Encoding]::Unicode.GetBytes($remoteBlock)
$encoded = [Convert]::ToBase64String($encBytes)
# Single argument to remote ssh; + in base64 is safe inside double quotes for cmd on remote
ssh -o "StrictHostKeyChecking=accept-new" ("${RemoteUser}@${RemoteHost}") "powershell -NoProfile -EncodedCommand $encoded"
Write-Host "If login still requires password, fix .ssh/authorized_keys ACL on Worker2 (OpenSSH for Windows doc)."

Write-Host "Testing passwordless session..."
ssh -o "BatchMode=yes" -o "ConnectTimeout=10" -i $priv ("${RemoteUser}@${RemoteHost}") "echo DUAL_SSH_OK"

Write-Host ""
Write-Host "Optional SSH config block (Host worker2 + IdentityFile):"
$cfg = ("  Host worker2" + [Environment]::NewLine + "    HostName {0}" + [Environment]::NewLine + "    User {1}" + [Environment]::NewLine + "    IdentityFile {2}") -f $RemoteHost, $RemoteUser, $priv
Write-Host $cfg
Write-Host ""
$sshLine = "ssh -i `"{0}`" {1}@{2}" -f $priv, $RemoteUser, $RemoteHost
Write-Host "Or: $sshLine"
