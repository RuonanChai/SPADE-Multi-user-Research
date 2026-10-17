@echo off
setlocal
rem 双机 260424_v2 全程自动化：本机+Worker2+代理+分析，无需在终端里输入任何命令
cd /d "%~dp0"
if not exist "scripts\run-260424-v2-dual.mjs" (
  echo FATAL: 找不到 scripts\run-260424-v2-dual.mjs
  exit /b 1
)
node "scripts\run-260424-v2-dual.mjs" %*
exit /b %ERRORLEVEL%
