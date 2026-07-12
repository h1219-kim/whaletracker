# WhaleTracker — 국민연금 투자 동향 대시보드 설계

날짜: 2026-07-12
상태: 확정 (사용자 전권 위임, 자율 진행)

## 1. 목표

국민연금(NPS)의 투자 동향을 한눈에 보는 로컬 웹앱.

1. **포트폴리오**: 전체 자산배분(주식/채권/대체 등) + 국내주식 종목별 비중/지분율
2. **최근 매매**: DART 공시 기반 — 최근 어떤 종목을 사고팔았는지(방향·규모·시점)
3. 한국어 UI, 로컬 실행, 무료 공개 데이터만 사용(API 키/로그인 불필요)

## 2. 데이터 소스 (2026-07-12 전부 실검증 완료)

| # | 데이터 | 소스 | 형식 | 기준일 | 인증 |
|---|---|---|---|---|---|
| A | 국내주식 종목별 투자현황 (1,200종목) | data.go.kr 데이터셋 3070507 | CSV(CP949) | 2024-12-31 (연 1회 갱신) | 불필요 |
| B | 대량보유주식 보고내역 (5%+ 스냅샷, 142건) | data.go.kr 데이터셋 15106890 | CSV(CP949) | 분기 갱신 | 불필요 |
| C | 기금 전체 자산배분 | fund.nps.or.kr `getOHED0016M0.do` | HTML | 월 갱신 (현재 2026-04) | 불필요 |
| D | 최근 공시 목록 (제출인=국민연금공단) | dart.fss.or.kr `POST /dsab007/detailSearch.ax` | HTML | 실시간 | 불필요 |
| E | 공시 본문 (지분 증감 + 개별 매매내역) | dart.fss.or.kr `/report/viewer.do` | HTML | 실시간 | 불필요 |

### 검증된 요청 상세

- **A/B 다운로드 URL**: 데이터셋 페이지 HTML 내 `"contentUrl": "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_...&fileDetailSn=1&insertDataPrcus=N"` 를 정규식으로 추출 후 다운로드 (atchFileId는 갱신 시 변경되므로 매번 페이지에서 추출). UA 헤더 필요.
  - A 페이지: `https://www.data.go.kr/data/3070507/fileData.do`
  - B 페이지: `https://www.data.go.kr/data/15106890/fileData.do`
  - A 컬럼: `번호,종목명,평가액(억 원),자산군 내 비중(퍼센트),지분율(퍼센트)`
  - B 컬럼: `번호,발행기관명 ,보고서 작성기준일,지분율(퍼센트)` (발행기관명 뒤 공백 주의, `(주)` 접두/접미 존재)
- **D**: `POST https://dart.fss.or.kr/dsab007/detailSearch.ax`, form-urlencoded:
  `currentPage=N&maxResults=100&maxLinks=10&sort=date&series=desc&textPresenterNm=국민연금공단&startDate=YYYYMMDD&endDate=YYYYMMDD`
  헤더: `User-Agent`, `Referer: https://dart.fss.or.kr/dsab007/main.do`, `X-Requested-With: XMLHttpRequest`
  응답: HTML 테이블. 행마다 공시대상회사(`openCorpInfoNew('00152686',...)`에서 corp_code), 보고서명+rcpNo(`/dsaf001/main.do?rcpNo=...`), 접수일자. 페이지네이션: 100건 초과 시 currentPage 증가(결과 없으면 `조회 결과가 없습니다`).
- **E**: 2단계.
  1. `GET https://dart.fss.or.kr/dsaf001/main.do?rcpNo=...` → JS에서 목차 추출: `node1['text']/['dcmNo']/['eleId']/['offset']/['length']` 패턴.
  2. `GET https://dart.fss.or.kr/report/viewer.do?rcpNo=..&dcmNo=..&eleId=..&offset=..&length=..&dtd=dart4.xsd` → 섹션 HTML.
  - **임원ㆍ주요주주특정증권등소유상황보고서** (`exec`): 섹션 `3. 특정증권등의 소유상황` — `직전보고서/이번보고서/증 감` 행(주식수·비율)과 `다. 세부변동내역` 테이블(보고사유[장내매수(+)/장내매도(-) 등], 일자, 증감 주식수, 취득/처분 단가).
  - **주식등의대량보유상황보고서(약식)** (`bulk`): 섹션 `3. 보유주식등의 수 및 보유비율` — `직전보고서/이번보고서/증    감` 행(작성기준일, 주식등의 수, 비율).
  - 실제 픽스처: `tests/fixtures/dart_*.html` (목록/exec 목차/exec 소유상황/bulk 목차/bulk 보유비율).

### 예의(politeness) 정책
- DART 요청 간 0.4초 지연, 문서 파싱은 rcpNo 기준 증분 캐시(이미 파싱한 공시는 재요청 금지).
- 기본 조회 기간 180일, 1회 갱신 시 최대 신규 문서 300건.

## 3. 아키텍처

```
whaletracker/
├── .venv/                    # 가상환경 (커밋 제외)
├── requirements.txt
├── app.py                    # Flask 앱 (실행: python app.py [--port 5000])
├── nps_fetcher/              # 데이터 수집 패키지
│   ├── __init__.py
│   ├── __main__.py           # python -m nps_fetcher [--days 180] [--max-new 300]
│   ├── datago.py             # 소스 A, B (CSV 다운로드+파싱)
│   ├── npsfund.py            # 소스 C (자산배분 HTML 파싱)
│   ├── dart.py               # 소스 D, E (목록 검색 + 문서 파싱)
│   └── store.py              # data/*.json 읽기/쓰기, 증분 캐시, 집계(trends)
├── data/                     # JSON 캐시 (실데이터 커밋)
│   ├── holdings.json  allocation.json  major_stakes.json  filings.json
├── templates/index.html      # 대시보드 (단일 페이지)
├── static/                   # chart 렌더링은 직접 SVG/HTML (외부 CDN 금지, 로컬 파일만)
├── tests/                    # pytest — 픽스처 기반 파서 테스트
└── docs/superpowers/specs/   # 본 문서
```

- **백엔드**: Python 3.13 + Flask. 수집은 requests+BeautifulSoup(lxml).
- **프론트**: 서버 렌더 아님 — Flask가 JSON API 제공, index.html이 fetch로 그림. 차트는 외부 라이브러리 없이 손수 만든 SVG/HTML 바 차트(의존성/CSP 최소화, dataviz 스킬 준수가 더 쉬움).
- **갱신**: UI의 "데이터 갱신" 버튼 → `POST /api/refresh` → 백그라운드 스레드로 수집 실행, `GET /api/refresh/status` 폴링. CLI `python -m nps_fetcher`도 동일 동작.
- **자동 갱신** (2026-07-12 추가): 서버 데몬 스레드가 15분마다 `filings.json`의 `fetched_at` 신선도를 점검, `--auto-refresh HOURS`(기본 24, 0=끄기)보다 오래되면 수동 갱신과 같은 경로로 수집 시작. 프론트는 5분마다 `last_finished` 변화를 감시해 자동 반영(토스트 + 리로드). 진행 중이던 수동 갱신과는 단일 스레드 가드를 공유.

## 4. 데이터 스키마 (계약 — 백엔드/프론트 공통)

### data/holdings.json (소스 A)
```json
{
  "as_of": "2024-12-31",
  "source": "공공데이터포털 · 국민연금공단 국내주식 투자정보",
  "fetched_at": "2026-07-12T12:00:00+09:00",
  "total_value_100m": 1379434,
  "stocks": [
    {"rank": 1, "name": "삼성전자", "value_100m": 230421.0, "weight_pct": 16.7, "ownership_pct": 7.26}
  ]
}
```

### data/allocation.json (소스 C)
```json
{
  "as_of": "2026-04",
  "source": "국민연금기금운용본부 포트폴리오 현황",
  "fetched_at": "...",
  "total_trillion": 1670.7,
  "assets": [
    {"name": "해외주식", "value_trillion": 604.5, "weight_pct": 36.2},
    {"name": "국내주식", "value_trillion": 419.5, "weight_pct": 25.1},
    {"name": "국내채권", "value_trillion": 293.6, "weight_pct": 17.6},
    {"name": "대체투자", "value_trillion": 245.7, "weight_pct": 14.7},
    {"name": "해외채권", "value_trillion": 103.1, "weight_pct": 6.2},
    {"name": "단기자금", "value_trillion": 3.6, "weight_pct": 0.2},
    {"name": "복지·기타", "value_trillion": 1.5, "weight_pct": 0.1}
  ]
}
```

### data/major_stakes.json (소스 B)
```json
{
  "as_of": "2026-03-31",
  "source": "공공데이터포털 · 국민연금공단 대량보유주식 보고내역",
  "fetched_at": "...",
  "stakes": [
    {"name": "(주)KB금융지주", "report_date": "2026-01-29", "ownership_pct": 8.94}
  ]
}
```

### data/filings.json (소스 D+E, rcpNo 증분 캐시)
```json
{
  "fetched_at": "...",
  "range_start": "2026-01-14",
  "range_end": "2026-07-12",
  "filings": [
    {
      "rcp_no": "20260707000347",
      "filed_date": "2026-07-07",
      "company": "코리아써키트",
      "corp_code": "00152686",
      "report_type": "exec",
      "report_name": "임원ㆍ주요주주특정증권등소유상황보고서",
      "prev": {"date": "2026-06-30", "shares": 2521629, "ratio": 9.09},
      "curr": {"date": "2026-07-02", "shares": 2383828, "ratio": 8.60},
      "delta": {"shares": -137801, "ratio": -0.49},
      "trades": [
        {"reason": "장내매도(-)", "date": "2026-07-01", "delta_shares": -113075, "price": 85753.0}
      ],
      "parse_ok": true
    }
  ]
}
```
- `report_type`: `"exec"` | `"bulk"`. bulk는 `trades: []`.
- 파싱 실패 시 `parse_ok: false`로 목록 메타만 저장(집계에서 제외, UI 공시 목록에는 표시).
- `delta.ratio` 단위: %p. `price`: 원(취득/처분 단가, 없으면 null).

### GET /api/trends?days=90 (집계 — store.py에서 계산)
```json
{
  "days": 90, "since": "2026-04-13",
  "top_buys":  [{"company": "...", "delta_ratio": 1.08, "delta_shares": 149874, "last_date": "2026-05-13", "filings": 2}],
  "top_sells": [{"company": "...", "delta_ratio": -1.08, "...": "..."}],
  "recent_filings": [ "...filings.json의 filings 항목 (최신순)..." ]
}
```
- 집계 규칙: 회사별 × 보고유형(exec/bulk)별로 기간 내 `delta.ratio`/`delta.shares`를 합산한 뒤, **|순변동|이 큰 유형 하나만 채택**(동률이면 bulk 우선, `basis` 필드로 표기). 같은 매매가 두 유형으로 이중 보고되는 일이 실데이터에서 흔해(10%+ 보유 종목) 단순 합산은 과대 계상됨 — 2026-07-12 실측으로 확인 후 규칙 변경. 공시 수·최근 접수일은 두 유형 합산. `parse_ok=false`, `is_correction=true`, `delta.ratio=null`(최초 보고) 제외. `delta_ratio` 절대값 내림차순 상위 12개씩 + 전체 종목 수(`buy_count`/`sell_count`).

## 5. Flask API

| 라우트 | 응답 |
|---|---|
| `GET /` | index.html |
| `GET /api/holdings` | holdings.json 그대로 |
| `GET /api/allocation` | allocation.json 그대로 |
| `GET /api/major-stakes` | major_stakes.json 그대로 |
| `GET /api/trends?days=N` | 위 집계 (N ∈ 30/90/180, 기본 90) |
| `POST /api/refresh` | `{started: true}` — 이미 실행 중이면 409 |
| `GET /api/refresh/status` | `{running, step, done_steps, total_steps, error, last_finished}` |

- 데이터 파일 없으면 API는 `{... "empty": true}` 반환, UI는 "데이터 갱신을 눌러 수집하세요" 안내.

## 6. UI 설계 (dataviz 스킬 준수)

단일 페이지, 한국어, 라이트/다크 모두 지원(`prefers-color-scheme`). 구성(위→아래):

1. **헤더**: 제목 "🐋 국민연금 투자 동향", 데이터 기준일 뱃지, "데이터 갱신" 버튼(+진행 상태).
2. **KPI 카드 행** (stat tiles): 기금 총자산(1,670.7조원, 기준월), 국내주식 평가액·비중, 최근 90일 순매수 종목 수 / 순매도 종목 수.
3. **자산배분**: 가로 스택 바(part-to-whole) + 범례 + 직접 라벨(≥5%만), 카테고리 순서 고정. 0.5% 미만(단기자금·복지기타)은 "기타"로 접기.
4. **최근 매매 동향** (핵심 섹션): 기간 토글(30/90/180일).
   - 다이버징 가로 바: 순매수(우, 파랑 계열) / 순매도(좌, 주황 계열) 상위 종목, x=Δ지분율(%p). 0 기준선.
   - 최근 공시 테이블: 접수일, 회사, 보고서 유형, 지분율 변화(전→후, %p 컬러 표시), 상세(매매 건수). DART 원문 링크(rcpNo).
5. **국내주식 보유 현황**: 상위 20 가로 바(단일 색상 sequential, 값 = 평가액) + 전체 1,200종목 검색·정렬 테이블(페이지네이션 25행). 5%+ 대량보유 지분율(소스 B)을 테이블에 병합 컬럼으로 표시.
6. **푸터**: 출처(공공데이터포털·기금운용본부·DART), 기준일별 고지, "투자 조언 아님" 면책.

차트 구현 규칙: dataviz 스킬 절차 준수 — 팔레트는 `references/palette.md` 기본 팔레트 사용, `scripts/validate_palette.js`로 라이트/다크 검증, 얇은 마크·2px 간격·호버 툴팁·테이블 대체 뷰 제공. 이중축 금지, 파이 금지(스택바), 색은 텍스트에 쓰지 않음.

## 6.5 간접 지표 확장 (2026-07-12~13 추가)

- **연기금 일별 순매수** (`naver_flow.py` → pension_flow.json): 네이버 금융 investorDealTrendDay.naver
  (sosok 01/02, EUC-KR, 11컬럼 — 기관 세부 6개 합≈기관계 검증, 연기금등=10번째 컬럼). 60거래일.
- **연기금 종목별 순매수/매도** (`krx_flow.py` → pension_stock_flow.json): KRX 정규 통계 화면은
  로그인제이나, 외부 임베드용 outerLoader(MDCSTAT024)의 bld
  `dbms/MDC_OUT/STAT/standard/MDCSTAT02401_OUT`은 Referer만으로 접근 가능.
  invstTpCd=6000(연기금등) — 일별 합계가 네이버 수치와 일치함을 교차 검증(2026-07-13, +355억).
  기간 3종(1주/1개월/3개월) × 시장 2종, 상/하위 20종목씩 저장.
- **미국 주식 13F** (`sec13f.py` → us_holdings.json): SEC EDGAR CIK 1608046, 13F-HR 분기.
  연락처 포함 UA 필수, cusip 집계, putCall·PRN 제외, 직전 분기와 비교(신규/청산/Δ주식수).
- 한계 고지: '연기금등' ≠ 국민연금 단독 (타 연기금 포함, 위탁운용분은 투신·사모로 집계).

## 7. 오류 처리

- 각 소스 독립 수집: 하나 실패해도 나머지 저장, 기존 캐시 유지(부분 갱신).
- 네트워크: 타임아웃 15초, 재시도 2회(지수 백오프). 실패 시 status에 소스별 오류 메시지.
- 파서: 구조 변화 감지 시(필수 테이블 미발견) 해당 공시 `parse_ok=false` 저장하고 계속.
- CSV 인코딩: CP949 우선, 실패 시 UTF-8-SIG 폴백.

## 8. 테스트

- `tests/test_dart_parsers.py`: 픽스처 5종으로 목록 파서·exec 본문 파서·bulk 본문 파서 검증(위 실측값과 일치 단언).
- `tests/test_datago.py`: CSV 파싱(헤더 공백, 콤마 숫자, CP949), contentUrl 추출 정규식.
- `tests/test_store.py`: trends 집계(합산, 기간 필터, parse_ok 제외, 정렬), 증분 머지.
- `tests/test_app.py`: Flask 라우트 스모크(JSON 형태, empty 상태, refresh 409).
- 통합 검증(수동): 실수집 → 브라우저 확인.

## 9. 한계 (UI에 고지)

- 종목별 보유 현황은 연 1회 공시(현재 2024년말 기준) — 실시간 아님.
- 매매 동향은 5%+ 보유 종목 및 주요주주 공시 대상만 포착(전체 매매의 부분집합).
- exec/bulk 이중 보고는 대표 유형 채택으로 방지하나, 두 공시의 작성기준일 차이만큼 잔여 오차 가능.
- 최초 보고(직전보고서 없음)는 증감 미상으로 집계 제외, 공시 목록에는 "신규 보고 → N%"로 표시.
