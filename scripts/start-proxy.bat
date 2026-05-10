@echo off
echo Starting StepClaw OpenCode Proxy...
cd /d C:\Users\test\Desktop\stepclaw_opencode
start /min "StepClaw Proxy" cmd /c "node dist\index.js"
echo Proxy started. Check http://127.0.0.1:8080
