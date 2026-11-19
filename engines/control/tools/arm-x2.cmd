@echo off
rem Human authorization for dsh-x2. Usage: arm-x2.cmd [minutes]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arm-x2.ps1" %*
exit /b %errorlevel%
