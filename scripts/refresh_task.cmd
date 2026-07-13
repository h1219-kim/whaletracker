@echo off
rem WhaleTracker manual data refresh (optional).
rem The public site auto-updates daily via GitHub Actions, so this is NOT required.
rem Run it only when you want to refresh the LOCAL data/ files (e.g. before using
rem the local app offline). It does NOT commit or push.
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd in the OEM codepage,
rem so non-ASCII (Korean) text corrupts command parsing.
cd /d "%~dp0.."
if not exist "data\.cache" mkdir "data\.cache"
set "LOG=data\.cache\refresh_task.log"
echo ===== %date% %time% ===== > "%LOG%"
".venv\Scripts\python.exe" -X utf8 -m nps_fetcher --days 180 --max-new 300 >> "%LOG%" 2>&1
echo [%time%] local data refresh done >> "%LOG%"
