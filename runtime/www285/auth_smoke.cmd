@echo off
setlocal EnableDelayedExpansion
cd /d F:\WWW_N3_MUX\runtime\www285
set OUT=F:\WWW_N3_MUX\research_control\auth_smoke_stdout.txt
set ERR=F:\WWW_N3_MUX\research_control\auth_smoke_stderr.txt
set META=F:\WWW_N3_MUX\research_control\auth_smoke_meta.txt
whoami > "%META%"
echo USERDOMAIN=%USERDOMAIN%>> "%META%"
echo USERNAME=%USERNAME%>> "%META%"
echo CWD=%CD%>> "%META%"
call "C:\Users\IoT\AppData\Local\cursor-agent\agent.cmd" -p --output-format text --trust --workspace F:\WWW_N3_MUX\runtime\www285 "Return exactly AUTH_OK; do not use tools or edit files." > "%OUT%" 2> "%ERR%"
echo EXIT=!ERRORLEVEL!>> "%META%"
endlocal
