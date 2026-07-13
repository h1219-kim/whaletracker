# 🐋 WhaleTracker — 국민연금 투자 동향 대시보드

국민연금(NPS)의 **포트폴리오 구성**과 **최근 매매 동향**을 공개 데이터만으로 한눈에 보여주는 로컬 웹앱입니다.

- 기금 전체 자산배분 (국내/해외 주식·채권, 대체투자 …)
- 국내주식 종목별 보유 현황 (평가액·비중·지분율, 1,200종목 검색)
- 최근 매매 동향 — DART 공시 기반 순매수/순매도 상위 종목, 개별 매매 내역(일자·수량·단가)
- 연기금 일별 순매수 (코스피·코스닥, 간접 지표) — 공시보다 빠른 일별 방향성
- 연기금 **종목별** 순매수·매도 상위 (1주/1개월/3개월, KRX) — 어떤 종목을 사고팔았는지
- 미국 주식 보유 (SEC 13F, 분기) — 전체 보유 목록과 분기 매매 상위

## 실행 방법 (Windows)

> ⚠️ **`templates/index.html` 파일을 브라우저로 직접 열지 마세요.** 이 페이지는 Flask
> 템플릿(`{{ url_for(...) }}`)이라 서버가 실행 시점에 경로를 채워 넣습니다. 파일을 그냥
> 열면 스타일·데이터가 로드되지 않아 **깨진 화면**이 나옵니다. 반드시 아래처럼 서버를
> 띄운 뒤 `http://127.0.0.1:5000` 으로 접속하세요.

**가장 쉬운 방법:** 파일 탐색기에서 **`start.cmd` 를 더블클릭**하면 서버가 켜지고
브라우저가 자동으로 열립니다.

터미널에서 직접 실행하려면:

```powershell
# 1) 가상환경 생성 및 의존성 설치 (최초 1회)
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2) 서버 실행 (--open: 브라우저 자동 열기)
.venv\Scripts\python.exe app.py --open        # http://127.0.0.1:5000
.venv\Scripts\python.exe app.py --port 8080   # 포트 변경 시
```

저장소에 최신 수집 데이터가 포함되어 있어 바로 확인할 수 있습니다.

## 데이터 갱신 (자동 + 수동)

- **자동**: 서버가 켜져 있는 동안 15분마다 신선도를 점검해, 데이터가 24시간보다
  오래되면 알아서 다시 수집합니다. 주기 조절은 `--auto-refresh 6`(6시간),
  끄려면 `--auto-refresh 0`. 열려 있는 대시보드도 5분마다 확인해 새 데이터를 자동 반영합니다.
- **수동**: 대시보드의 **[데이터 갱신]** 버튼, 또는 CLI:

```powershell
.venv\Scripts\python.exe -m nps_fetcher --days 180 --max-new 300
```

- **작업 스케줄러**: 서버와 무관하게 매일 18:30에 수집하는 Windows 예약 작업
  ("WhaleTracker 데이터 수집")이 등록되어 있습니다. 놓친 실행은 다음 기회에 보충되고,
  배터리 상태에서도 동작합니다. 실행 로그: `data\.cache\refresh_task.log`
  수집 후 **데이터가 바뀌면 자동으로 커밋·push**하여 공개 사이트(GitHub Pages)까지
  갱신합니다(변경 없는 날은 커밋하지 않음). Git Credential Manager에 저장된 인증을
  사용하므로 최초 1회 수동 `git push`로 인증을 저장해 두면 이후 무인 실행됩니다.

```powershell
# 예약 작업 관리
Get-ScheduledTask -TaskName "WhaleTracker 데이터 수집"          # 상태 확인
Start-ScheduledTask -TaskName "WhaleTracker 데이터 수집"        # 즉시 실행
Unregister-ScheduledTask -TaskName "WhaleTracker 데이터 수집"   # 삭제
```

수집은 이미 파싱한 공시를 재요청하지 않는 증분 방식이라 매일 돌아도 서버 부담과
소요 시간이 작습니다(보통 1~2분).

## 다른 사람에게 공유하기 (무료 공개 링크)

Flask 서버 없이 열 수 있는 **정적 사이트**로 구워 GitHub Pages에 올리면, 누구나
링크 하나로 볼 수 있고 내 PC를 켜둘 필요도 없습니다. 데이터는 GitHub Actions가
매일 자동 수집·재배포합니다.

### 1) 정적 사이트 굽기 (로컬 미리보기)

```powershell
.venv\Scripts\python.exe build_static.py                 # site\ 폴더 생성
.venv\Scripts\python.exe -m http.server -d site 8000     # http://localhost:8000
```

`site\`는 서버 API 대신 미리 구운 JSON을 읽는 완전한 정적 사본입니다(갱신 버튼은 숨겨짐).

### 2) GitHub Pages에 올리기 (최초 1회)

```powershell
# GitHub에서 빈 저장소를 만든 뒤 (예: whaletracker), 원격 연결 후 push
git remote add origin https://github.com/<사용자명>/whaletracker.git
git branch -M main
git push -u origin main
```

그다음 GitHub 저장소 웹페이지에서 **Settings → Pages → Build and deployment →
Source**를 **"GitHub Actions"**로 지정하세요. (`.github/workflows/deploy.yml`가
빌드·배포를 담당합니다.)

- 몇 분 뒤 `https://<사용자명>.github.io/whaletracker/` 로 공개됩니다.
- 이후 매일 18:40(KST) 자동으로 데이터를 수집해 재배포하며, Actions 탭에서 수동
  실행(**Run workflow**)도 가능합니다.
- 참고: GitHub 러너는 해외 IP라 일부 한국 소스(KRX 등)가 막힐 수 있습니다. 그럴
  땐 저장소에 커밋된 마지막 데이터로 사이트가 만들어지고, 로컬에서
  `python -m nps_fetcher` 후 `git push` 하면 그 데이터로 다시 배포됩니다.

> ⚠️ 공개 배포 시: DART·SEC은 공공데이터라 자유롭게 쓸 수 있으나, KRX 데이터는
> 개인 참고용 범위에서만 사용하고 상업적 재배포는 삼가세요. 화면 하단에 "투자
> 조언이 아님" 면책이 표시됩니다.

## 데이터 출처 (전부 무료 공개, API 키 불필요)

| 데이터 | 출처 | 갱신 주기 |
|---|---|---|
| 기금 자산배분 | [국민연금기금운용본부](https://fund.nps.or.kr/oprtprcn/ivsmprcn/getOHED0016M0.do) | 월 |
| 국내주식 종목별 투자현황 | [공공데이터포털](https://www.data.go.kr/data/3070507/fileData.do) | 연 (연말 기준) |
| 대량보유주식 보고내역 (5%+) | [공공데이터포털](https://www.data.go.kr/data/15106890/fileData.do) | 분기 |
| 지분 변동 공시 (매매 내역) | [DART 전자공시](https://dart.fss.or.kr) — 제출인: 국민연금공단 | 실시간 |
| 연기금 일별 순매수 (간접) | KRX 투자자별 매매동향 ([네이버 금융](https://finance.naver.com/sise/sise_trans_style.naver) 집계) | 일 |
| 연기금 종목별 순매수 (간접) | [KRX 정보데이터시스템](https://data.krx.co.kr) 투자자별 순매수상위종목 | 일 |
| 미국 주식 보유 | [SEC EDGAR 13F](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001608046&type=13F) | 분기 |

## 알아둘 것 (데이터의 한계)

- **종목별 보유 현황은 연 1회** 공시됩니다(현재 2024년말 기준). 실시간 보유량이 아닙니다.
- **매매 동향은 공시 의무 대상만** 포착합니다 — 지분 5% 이상 보유 종목의 1%p 이상 변동(대량보유보고)과 주요주주 소유상황 보고. 국민연금 전체 매매의 부분집합입니다.
- **'연기금등' 일별 순매수는 간접 지표**입니다 — 국민연금 외 연기금(사학·공무원연금 등)이 포함되고, 국민연금이 자산운용사에 위탁한 물량은 투신·사모로 집계되어 빠집니다(직접운용분만 반영).
- 본 도구는 정보 제공용이며 **투자 조언이 아닙니다**.

## 개발

```powershell
.venv\Scripts\python.exe -m pytest -q     # 테스트 (네트워크 불필요, 픽스처 기반)
```

- 설계 문서: `docs/superpowers/specs/2026-07-12-whaletracker-design.md`
- 수집기: `nps_fetcher/` · 웹앱: `app.py` + `templates/` + `static/`
- DART 요청은 0.4초 간격 + 증분 캐시(이미 파싱한 공시는 재요청하지 않음)로 서버에 부담을 주지 않게 설계되어 있습니다.
