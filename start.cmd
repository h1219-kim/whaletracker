@echo off
rem WhaleTracker 대시보드 실행 — 더블클릭하면 서버를 켜고 브라우저를 자동으로 엽니다.
rem (index.html 파일을 직접 열면 안 됩니다. 반드시 이 스크립트로 서버를 통해 접속하세요.)
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [오류] 가상환경이 없습니다. 먼저 아래를 실행하세요:
  echo     python -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 1
)

echo WhaleTracker 서버를 시작합니다. 브라우저가 자동으로 열립니다.
echo 종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
".venv\Scripts\python.exe" app.py --open
pause
