@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem ============================================================
rem  dsh-desktop-hands : enable the merged bundle in a real profile
rem  ASCII ONLY (cmd.exe reads this file in the OEM code page).
rem  Run ONLY after DeepSeek Harness is fully closed.
rem  Optional: set HANDS_PROFILE to point at another profile dir.
rem ============================================================
rem Portable: PKG is this script's own folder; node/pnpm come from PATH.
set "PKG=%~dp0"
set "PKG=%PKG:~0,-1%"
set "NODE=node"
where node >nul 2>nul || (echo ERROR: node.exe not found in PATH. Install Node.js 22+ or add it to PATH. & exit /b 1)
set "PNPM=pnpm"
where pnpm >nul 2>nul || (echo ERROR: pnpm not found in PATH. Install pnpm or add it to PATH. & exit /b 1)
if "%HANDS_PROFILE%"=="" set "PROF=%USERPROFILE%\.dsh\profiles\desktop"
if not "%HANDS_PROFILE%"=="" set "PROF=%HANDS_PROFILE%"

echo ============================================================
echo  dsh-desktop-hands - enable merged bundle
echo  profile: %PROF%
echo ============================================================
echo.

echo [1/6] check that DeepSeek Harness is not running ...
if defined NO_GUARD (
  echo [TEST] NO_GUARD is set - skipping the running-app check. Only for test profiles.
  set "EXTRA=--force"
  goto :guard_ok
)
set "EXTRA="
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | "%SystemRoot%\System32\find.exe" /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo.
  echo [STOP] DeepSeek Harness is still running.
  echo        Fully quit it ^(tray icon too^), then run this again.
  if not defined NO_PAUSE pause
  exit /b 1
)
:guard_ok

if not exist "%PROF%\package.json" (
  echo [STOP] profile not found: %PROF%
  if not defined NO_PAUSE pause
  exit /b 1
)

echo [2/6] dry run ...
"%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%"
if errorlevel 1 (
  echo [STOP] dry run failed - nothing was changed.
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo [3/6] apply (backup first, then atomic write) ...
"%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --apply %EXTRA%
if errorlevel 1 (
  echo [STOP] apply failed - check the backup file it printed.
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo [4/6] pnpm install in the profile ...
pushd "%PROF%"
call "%PNPM%" install --no-frozen-lockfile --prefer-offline
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo [FAIL] pnpm install exit code %RC%
  call :rollback
  if not defined NO_PAUSE pause
  exit /b 2
)

echo.
echo [5/6] check the package really landed in node_modules ...
if not exist "%PROF%\node_modules\dsh-desktop-hands\package.json" (
  echo [FAIL] node_modules\dsh-desktop-hands is missing after install
  call :rollback
  if not defined NO_PAUSE pause
  exit /b 3
)
echo ok: node_modules\dsh-desktop-hands

echo.
echo [6/6] check-bundle ...
"%NODE%" "%PKG%\tools\check-bundle.mjs" --profile "%PROF%"
if errorlevel 1 (
  echo.
  echo [WARN] check-bundle reported FAIL - see the lines above.
  echo        Rollback with:  "%NODE%" "%PKG%\tools\profile-switch.mjs" --rollback ^<bak^>
  if not defined NO_PAUSE pause
  exit /b 4
)

echo.
echo ============================================================
echo  DONE. Start DeepSeek Harness as usual.
echo  Expected after restart: click-matrix 14 (24 with mergeReadSide=false) + x2 6 + stroke 5 = 25 default (35 fallback) tools.
echo ============================================================
if not defined NO_PAUSE pause
exit /b 0

:rollback
for /f "delims=" %%F in ('dir /b /o-d "%PROF%\package.json.bak-hands-*" 2^>nul') do (
  echo [ROLLBACK] restoring %%F
  "%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --rollback "%PROF%\%%F"
  goto :rollback_done
)
echo [ROLLBACK] no backup file found in %PROF%
:rollback_done
exit /b 0
