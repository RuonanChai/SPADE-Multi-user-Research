# Run ON the SSH server (Worker2) in *Administrator* PowerShell.
# See: https://github.com/PowerShell/Win32-OpenSSH/wiki/Security-Protecting-authorized-keys-file
# Microsoft: administrative accounts must use C:\ProgramData\ssh\administrators_authorized_keys (not only %USERPROFILE%\.ssh\authorized_keys)
param(
  # e.g. C:\Users\YourAccount — set this if you run this script as another account (e.g. Administrator)
  [string]$UserProfilePath = "",
  # Local Administrators must use C:\ProgramData\ssh\administrators_authorized_keys (default Match in sshd_config)
  [bool]$AlsoInstallForAdministratorsGroup = $true
)

if ([string]::IsNullOrWhiteSpace($UserProfilePath)) {
  $UserProfilePath = $env:USERPROFILE
}

$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Error "Run in elevated (Administrator) PowerShell."
  exit 1
}

$sshDir = Join-Path $UserProfilePath ".ssh"
$auth = Join-Path $sshDir "authorized_keys"
$adminAuth = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"
$sidAdmins = "*S-1-5-32-544"
$sidSystem = "SYSTEM"

function Grant-UserAuthorizedKeys {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $ownStr = (Get-Acl -Path $Path).Owner.Value
  Write-Host "File owner: $ownStr"
  & icacls $Path /inheritance:r
  & icacls $Path /grant:r "${ownStr}:(F)"
  & icacls $Path /grant:r "SYSTEM:F"
  & icacls $Path /remove "NT AUTHORITY\Authenticated Users" 2>$null
  & icacls $Path /remove "BUILTIN\Users" 2>$null
  Write-Host "ACL: $Path"
  & icacls $Path
}

function Set-AdminAuthorizedKeys {
  param([string]$KeyLine)
  if ([string]::IsNullOrWhiteSpace($KeyLine)) {
    return
  }
  $dir = Split-Path $adminAuth -Parent
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $existing = ""
  if (Test-Path $adminAuth) {
    $existing = [System.IO.File]::ReadAllText($adminAuth)
  }
  if ($existing -notmatch [regex]::Escape($KeyLine.Trim())) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::AppendAllText($adminAuth, ($KeyLine.Trim() + "`r`n"), $utf8NoBom)
    Write-Host "Appended one line to: $adminAuth"
  } else {
    Write-Host "Key line already present in: $adminAuth"
  }
  & icacls $adminAuth /inheritance:r
  & icacls $adminAuth /grant:r "$($sidAdmins):F"
  & icacls $adminAuth /grant:r "$($sidSystem):F"
  Write-Host "ACL: $adminAuth"
  & icacls $adminAuth
}

# --- per-user file ---
if (-not (Test-Path $auth)) {
  Write-Error "Not found: $auth. Put your .pub line there first (one line, UTF-8, no BOM)."
  exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [System.IO.File]::ReadAllLines($auth, $utf8)
$firstKeyLine = ($lines | Where-Object { $_.Trim() -match "^(ssh-rsa|ssh-ed25519|ecdsa-)" } | Select-Object -First 1)
if (-not $firstKeyLine) {
  $firstKeyLine = $lines[0]
}
# Rewrite file UTF-8 no BOM to avoid OpenSSH parse issues
$keyText = ($lines -join "`r`n").Trim() + "`r`n"
[System.IO.File]::WriteAllText($auth, $keyText, $utf8)
Write-Host "Rewrote (UTF-8 no BOM): $auth"

Write-Host "Hardening ACL on: $sshDir"
if (-not (Test-Path $sshDir)) {
  New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
}
& icacls $sshDir /inheritance:r
$ownDir = (Get-Acl $UserProfilePath).Owner.Value
Write-Host "Profile owner: $ownDir"
& icacls $sshDir /grant:r "SYSTEM:(OI)(CI)F" 2>$null
& icacls $sshDir /grant:r "$($ownDir):(OI)(CI)F" 2>$null

Grant-UserAuthorizedKeys -Path $auth

# Local Administrators: sshd by default uses ProgramData\ssh\administrators_authorized_keys (see sshd_config Match Group administrators)
if ($AlsoInstallForAdministratorsGroup) {
  Write-Host ""
  Write-Host "Also installing to ProgramData\ssh\administrators_authorized_keys (OpenSSH for Windows rule for members of local Administrators)..."
  Set-AdminAuthorizedKeys -KeyLine $firstKeyLine
} else {
  Write-Host "Skipped ProgramData admin key file (AlsoInstallForAdministratorsGroup = false)"
}

Write-Host ""
Write-Host "Run: Restart-Service sshd"
Write-Host "Then from client: ssh -o BatchMode=yes -i <privkey> <user>@<host> echo OK"
