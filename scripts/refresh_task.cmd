@echo off
rem WhaleTracker data refresh runner for Windows Task Scheduler.
rem Collects data, then commits and pushes if data changed
rem (this auto-updates the public GitHub Pages site).
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd in the OEM codepage,
rem so non-ASCII (Korean) comments/messages corrupt command parsing.
cd /d "%~dp0.."
if not exist "data\.cache" mkdir "data\.cache"
set "LOG=data\.cache\refresh_task.log"
echo ===== %date% %time% ===== > "%LOG%"

rem 1) Incremental data collection
".venv\Scripts\python.exe" -X utf8 -m nps_fetcher --days 180 --max-new 300 >> "%LOG%" 2>&1

rem 2) Commit and push only if data/ changed (avoids empty commits).
rem    Commit timestamp records the date; no date needed in the message.
git add data >> "%LOG%" 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore: auto data refresh" >> "%LOG%" 2>&1
  git push >> "%LOG%" 2>&1
  echo [%time%] changes detected - committed and pushed >> "%LOG%"
) else (
  echo [%time%] no data changes - skipped commit/push >> "%LOG%"
)
