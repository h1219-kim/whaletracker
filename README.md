# 🐋 WhaleTracker — 국민연금 투자 동향 대시보드

국민연금(NPS)의 **포트폴리오 구성**과 **최근 매매 동향**을 공개 데이터만으로 한눈에 보여주는 로컬 웹앱입니다.

- 기금 전체 자산배분 (국내/해외 주식·채권, 대체투자 …)
- 국내주식 종목별 보유 현황 (평가액·비중·지분율, 1,200종목 검색)
- 최근 매매 동향 — DART 공시 기반 순매수/순매도 상위 종목, 개별 매매 내역(일자·수량·단가)

## 실행 방법 (Windows)

```powershell
# 1) 가상환경 생성 및 의존성 설치 (최초 1회)
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2) 서버 실행
.venv\Scripts\python.exe app.py            # http://127.0.0.1:5000
.venv\Scripts\python.exe app.py --port 8080  # 포트 변경 시
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

서버를 꺼두는 시간이 많다면 위 CLI를 Windows 작업 스케줄러에 등록하는 방법도 있습니다
(수집은 서버와 무관하게 동작하며, 이미 파싱한 공시는 재요청하지 않는 증분 방식입니다).

## 데이터 출처 (전부 무료 공개, API 키 불필요)

| 데이터 | 출처 | 갱신 주기 |
|---|---|---|
| 기금 자산배분 | [국민연금기금운용본부](https://fund.nps.or.kr/oprtprcn/ivsmprcn/getOHED0016M0.do) | 월 |
| 국내주식 종목별 투자현황 | [공공데이터포털](https://www.data.go.kr/data/3070507/fileData.do) | 연 (연말 기준) |
| 대량보유주식 보고내역 (5%+) | [공공데이터포털](https://www.data.go.kr/data/15106890/fileData.do) | 분기 |
| 지분 변동 공시 (매매 내역) | [DART 전자공시](https://dart.fss.or.kr) — 제출인: 국민연금공단 | 실시간 |

## 알아둘 것 (데이터의 한계)

- **종목별 보유 현황은 연 1회** 공시됩니다(현재 2024년말 기준). 실시간 보유량이 아닙니다.
- **매매 동향은 공시 의무 대상만** 포착합니다 — 지분 5% 이상 보유 종목의 1%p 이상 변동(대량보유보고)과 주요주주 소유상황 보고. 국민연금 전체 매매의 부분집합입니다.
- 본 도구는 정보 제공용이며 **투자 조언이 아닙니다**.

## 개발

```powershell
.venv\Scripts\python.exe -m pytest -q     # 테스트 (네트워크 불필요, 픽스처 기반)
```

- 설계 문서: `docs/superpowers/specs/2026-07-12-whaletracker-design.md`
- 수집기: `nps_fetcher/` · 웹앱: `app.py` + `templates/` + `static/`
- DART 요청은 0.4초 간격 + 증분 캐시(이미 파싱한 공시는 재요청하지 않음)로 서버에 부담을 주지 않게 설계되어 있습니다.
