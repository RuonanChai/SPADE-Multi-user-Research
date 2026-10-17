@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"D:\Download\cursor\_\Cursor.exe" "D:\Download\cursor\_\resources\app\out\cli.js" agent -p "Reply with the single word PING. Do not use tools and do not edit files." --output-format json
endlocal
