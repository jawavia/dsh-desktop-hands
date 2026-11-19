@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem ============================================================
rem  dsh-desktop-hands : rollback a profile field-level: only the 4 links + bundle membership of dsh-desktop-hands (other fields of package.json are kept)
rem  ASCII ONLY. Works even if DeepSeek Harness cannot boot:
rem  quit DSH, run this, then start DSH again.
rem  Optional: set HANDS_PROFILE to point at another profile dir.
rem ============================================================
rem Portable: PKG is this script's own folder; node comes from PATH.
set "PKG=%~dp0"
set "PKG=%PKG:~0,-1%"
set "NODE=node"
where node >nul 2>nul || (echo ERROR: node.exe not found in PATH. Install Node.js 22+ or add it to PATH. & exit /b 1)
if "%HANDS_PROFILE%"=="" set "PROF=%USERPROFILE%\.dsh\profiles\desktop"
if not "%HANDS_PROFILE%"=="" set "PROF=%HANDS_PROFILE%"

echo ============================================================
echo  dsh-desktop-hands - rollback
echo  profile: %PROF%
echo ============================================================
echo.

if not exist "%PROF%\package.json" (
  echo [STOP] profile not found: %PROF%
  if not defined NO_PAUSE pause
  exit /b 1
)

if defined NO_GUARD (
  echo [TEST] NO_GUARD is set - skipping the running-app check.
  goto :guard_ok
)
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | "%SystemRoot%\System32\find.exe" /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [STOP] DeepSeek Harness is still running. Fully quit it first.
  if not defined NO_PAUSE pause
  exit /b 1
)
:guard_ok

echo [1/2] list backups:
dir /b /o-d "%PROF%\package.json.bak-hands-*" 2>nul
if errorlevel 1 (
  echo [STOP] no package.json.bak-hands-* found in %PROF%
  if not defined NO_PAUSE pause
  exit /b 2
)

echo.
echo [2/2] field-level rollback using the newest backup ...
set "LATEST="
for /f "delims=" %%F in ('dir /b /o-d "%PROF%\package.json.bak-hands-*" 2^>nul') do (
  if not defined LATEST set "LATEST=%PROF%\%%F"
)
echo using: %LATEST%
"%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --rollback "%LATEST%"
if errorlevel 1 (
  echo [FAIL] rollback failed
  if not defined NO_PAUSE pause
  exit /b 3
)

echo.
echo ============================================================
echo  DONE. Start DeepSeek Harness again.
echo  Note: node_modules may still hold the dsh-desktop-hands link;
echo  it is harmless (nothing loads it once the bundle entry is gone).
echo ============================================================
if not defined NO_PAUSE pause
exit /b 0
