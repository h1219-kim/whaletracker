@echo off
rem WhaleTracker 데이터 수집 — Windows 작업 스케줄러용 러너
rem 프로젝트로 이동 → 증분 수집 → 데이터가 바뀌었으면 GitHub에 push하여
rem 공개 사이트(GitHub Pages)를 자동 갱신한다. 모든 출력은 로그에 남긴다.
cd /d "%~dp0.."
if not exist "data\.cache" mkdir "data\.cache"
set "LOG=data\.cache\refresh_task.log"
echo ===== %date% %time% ===== > "%LOG%"

rem 1) 데이터 수집 (증분)
".venv\Scripts\python.exe" -X utf8 -m nps_fetcher --days 180 --max-new 300 >> "%LOG%" 2>&1

rem 2) data/ 변경이 있을 때만 커밋 후 push (변경 없으면 빈 커밋 방지)
git add data >> "%LOG%" 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "데이터 자동 갱신 %date%" >> "%LOG%" 2>&1
  git push >> "%LOG%" 2>&1
  echo [%time%] 데이터 변경 감지 - 커밋 및 push 완료 >> "%LOG%"
) else (
  echo [%time%] 데이터 변경 없음 - 커밋/push 생략 >> "%LOG%"
)
