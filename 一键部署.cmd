@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem ============================================================
rem  dsh-desktop-hands : one-shot deploy
rem    A) seal the old click-matrix audit chain  (step 2)
rem    B) enable the merged bundle in the profile (step 1)
rem  ASCII ONLY. Run ONLY after DeepSeek Harness is fully closed.
rem  Env overrides (for testing): HANDS_PROFILE, HANDS_AUDITDIR.
rem ============================================================
rem Portable: PKG is this script's own folder; node/pnpm come from PATH.
set "PKG=%~dp0"
set "PKG=%PKG:~0,-1%"
set "NODE=node"
where node >nul 2>nul || (echo ERROR: node.exe not found in PATH. Install Node.js 22+ or add it to PATH. & exit /b 1)
set "PNPM=pnpm"
where pnpm >nul 2>nul || (echo ERROR: pnpm not found in PATH. Install pnpm or add it to PATH. & exit /b 1)

rem ---- preflight: runtime prerequisites (Node 22+ / pnpm / .NET Framework 4.x) ----
for /f "delims=" %%V in ('node -p "process.versions.node"') do set "NODE_VER=%%V"
if not defined NODE_VER (echo ERROR: cannot read the Node.js version from "node". & exit /b 1)
for /f "tokens=1 delims=." %%M in ("%NODE_VER%") do set "NODE_MAJOR=%%M"
if %NODE_MAJOR% LSS 22 (
  echo ERROR: Node.js 22+ is required. Found: %NODE_VER%
  echo        Download: https://nodejs.org/
  exit /b 1
)
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo ERROR: .NET Framework 4.x csc.exe not found ^(needed to compile the mouse helper^).
  echo        Windows 11 ships .NET 4.x; if missing, install .NET Framework 4.8.
  exit /b 1
)
echo [preflight] node %NODE_VER% / pnpm ok / csc ok
if "%HANDS_PROFILE%"=="" set "PROF=%USERPROFILE%\.dsh\profiles\desktop"
if not "%HANDS_PROFILE%"=="" set "PROF=%HANDS_PROFILE%"
if "%HANDS_AUDITDIR%"=="" set "AUDIT=%USERPROFILE%\.dsh\click-matrix"
if not "%HANDS_AUDITDIR%"=="" set "AUDIT=%HANDS_AUDITDIR%"

echo ============================================================
echo  dsh-desktop-hands - one-shot deploy
echo  profile: %PROF%
echo  audit  : %AUDIT%
echo ============================================================
echo.

echo [1/7] check that DeepSeek Harness is not running ...
if defined NO_GUARD (
  echo [TEST] NO_GUARD is set - skipping the running-app check.
  set "EXTRA=--force"
  goto :guard_ok
)
set "EXTRA="
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | "%SystemRoot%\System32\find.exe" /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo.
  echo [STOP] DeepSeek Harness is still running. Fully quit it ^(tray icon too^), then run this again.
  if not defined NO_PAUSE pause
  exit /b 1
)
:guard_ok

if not exist "%PROF%\package.json" (
  echo [STOP] profile not found: %PROF%
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo [2/7] seal the old audit chain ^(step 2, reversible rename^) ...
"%NODE%" "%PKG%\tools\seal-audit.mjs" "%AUDIT%"
set "SEAL_RC=%ERRORLEVEL%"
if not "%SEAL_RC%"=="0" (
  echo.
  echo [WARN] seal reported an issue - see above. This part is reversible; continuing.
)

echo.
echo [3/7] profile dry run ...
"%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%"
if errorlevel 1 (
  echo [STOP] dry run failed - nothing was changed.
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo [4/7] profile apply ^(backup first, atomic write^) ...
"%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --apply %EXTRA%
if errorlevel 1 (
  echo [STOP] apply failed - check the backup file it printed.
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo [5/7] pnpm install in the profile ...
pushd "%PROF%"
call "%PNPM%" install --no-frozen-lockfile --prefer-offline
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo [FAIL] pnpm install exit code %RC%
  call :rollback_profile
  if not defined NO_PAUSE pause
  exit /b 2
)

echo.
echo [6/7] confirm the package landed in node_modules ...
if not exist "%PROF%\node_modules\dsh-desktop-hands\package.json" (
  echo [FAIL] node_modules\dsh-desktop-hands is missing after install
  call :rollback_profile
  if not defined NO_PAUSE pause
  exit /b 3
)
echo ok: node_modules\dsh-desktop-hands

echo.
echo [7/7] check-bundle ...
"%NODE%" "%PKG%\tools\check-bundle.mjs" --profile "%PROF%"
if errorlevel 1 (
  echo.
  echo [WARN] check-bundle reported FAIL - see above.
  echo        Rollback profile with: "%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --rollback ^<bak^>
  if not defined NO_PAUSE pause
  exit /b 4
)

echo.
echo ============================================================
echo  DONE. Start DeepSeek Harness as usual.
echo  After restart:
echo    - merged bundle live: click-matrix 14 (24 with mergeReadSide=false) + x2 6 + stroke 5 = 25 default (35 fallback) tools
echo    - audit chain restarts from genesis (old file sealed, readable)
echo  If the audit FAIL disappears in click_matrix_doctor, steps 1+2 are
echo  both accepted.
echo ============================================================
if not defined NO_PAUSE pause
exit /b 0

:rollback_profile
for /f "delims=" %%F in ('dir /b /o-d "%PROF%\package.json.bak-hands-*" 2^>nul') do (
  echo [ROLLBACK] restoring %%F
  "%NODE%" "%PKG%\tools\profile-switch.mjs" --profile "%PROF%" --rollback "%PROF%\%%F"
  goto :rollback_done
)
echo [ROLLBACK] no backup file found in %PROF%
:rollback_done
exit /b 0
