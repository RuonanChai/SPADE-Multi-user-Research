#Requires -Version 5.0
# 同 oneclick-260424v2.cmd，用于计划任务/CI：无交互
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root
$script = Join-Path $root "scripts\run-260424-v2-dual.mjs"
if (-not (Test-Path -LiteralPath $script)) { throw "Missing $script" }
& node $script @args
exit $LASTEXITCODE
