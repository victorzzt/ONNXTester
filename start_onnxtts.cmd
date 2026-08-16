@echo off
rem Launch ONNXTTS from the project directory regardless of the caller's CWD.
rem Delayed expansion preserves the Node exit code after Ctrl+C returns control.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Never reuse a Linux runtime copied into this Windows checkout. Clearing it
rem is an explicit user action because .local-env may contain valuable files.
if exist ".local-env\python\bin\python3" goto platform_conflict
if exist ".local-env\install.json" (
  findstr /i /c:"linux-" ".local-env\install.json" >nul 2>&1
  if not errorlevel 1 goto platform_conflict
)

rem Prefer Node.js from CMD's PATH. If it is unavailable, scan the standard
rem Program Files location on drives C: through F: before asking for install.
set "NODE_EXE=node.exe"
where node.exe >nul 2>&1
if errorlevel 1 (
  set "NODE_EXE="
  for %%D in (C D E F) do (
    if not defined NODE_EXE if exist "%%D:\Program Files\nodejs\node.exe" set "NODE_EXE=%%D:\Program Files\nodejs\node.exe"
  )
  if not defined NODE_EXE (
    echo Node.js was not found in PATH or under C:\ through F:\Program Files\nodejs.
    echo Install Node.js 20 or newer, then run this command again.
    endlocal
    exit /b 1
  )
)

rem Forward every command-line option to server.mjs. The empty CALL resets the
rem aborted-batch state produced by Ctrl+C so this wrapper can return cleanly.
"%NODE_EXE%" server.mjs %* & set "ONNXTTS_EXIT_CODE=!ERRORLEVEL!" & call;

rem Restore the caller's environment and propagate the Server exit code.
endlocal & exit /b %ONNXTTS_EXIT_CODE%
:platform_conflict
echo A Linux project-local Python/Piper environment is already present in .local-env.
echo ONNXTTS will not remove or replace an environment from another platform.
echo Run set_local_env.cmd -clear manually, then start ONNXTTS again.
endlocal
exit /b 2
