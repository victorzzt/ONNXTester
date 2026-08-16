@echo off
rem Launch ONNXTTS from the project directory regardless of the caller's CWD.
rem Delayed expansion preserves the Node exit code after Ctrl+C returns control.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Prefer Node.js from CMD's PATH. PowerShell sessions on this machine may not
rem inherit the same PATH, so use the known installation as a Windows fallback.
set "NODE_EXE=node.exe"
where node.exe >nul 2>&1
if errorlevel 1 (
  if exist "D:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=D:\Program Files\nodejs\node.exe"
  ) else (
    echo Node.js was not found in PATH or at D:\Program Files\nodejs\node.exe.
    endlocal
    exit /b 1
  )
)

rem Forward every command-line option to server.mjs. The empty CALL resets the
rem aborted-batch state produced by Ctrl+C so this wrapper can return cleanly.
"%NODE_EXE%" server.mjs %* & set "ONNXTTS_EXIT_CODE=!ERRORLEVEL!" & call;

rem Restore the caller's environment and propagate the Server exit code.
endlocal & exit /b %ONNXTTS_EXIT_CODE%