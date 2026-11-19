@echo off
rem dsh-stroke helper service launcher (ASCII only).
rem Double-click once per session and LEAVE THIS WINDOW OPEN (minimize is fine).
rem Started from your desktop => medium integrity => real mouse injection works.
rem The DSH plugin connects to it on 127.0.0.1:47999.
setlocal
cd /d "%~dp0runtime"
echo dsh-stroke helper service - listening on 127.0.0.1:47999
echo Close this window (or press Ctrl+C) to stop the service.
stroke-helper.exe --serve 47999
echo service exited.
pause
