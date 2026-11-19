@echo off
rem dsh-x2 config panel. Usage: config-x2.cmd
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0config-x2.ps1" %*
exit /b %errorlevel%
