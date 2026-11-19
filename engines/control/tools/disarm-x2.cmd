@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disarm-x2.ps1" %*
exit /b %errorlevel%
