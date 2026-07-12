@echo off
rem WhaleTracker 데이터 수집 — Windows 작업 스케줄러용 러너
rem 프로젝트 폴더로 이동 후 증분 수집을 실행하고, 마지막 실행 로그를 남긴다.
cd /d "%~dp0.."
if not exist "data\.cache" mkdir "data\.cache"
echo ===== %date% %time% ===== > "data\.cache\refresh_task.log"
".venv\Scripts\python.exe" -X utf8 -m nps_fetcher --days 180 --max-new 300 >> "data\.cache\refresh_task.log" 2>&1
