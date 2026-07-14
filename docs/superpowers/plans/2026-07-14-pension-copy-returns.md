# 연기금 따라 투자 수익률 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (인라인 실행). Steps는 체크박스로 추적.

**Goal:** 연기금 순매수 상위 5개 종목을 두 방식(스냅샷/연속)으로 따라 샀을 때의 누적수익률을 지수 대비와 함께 보여준다.

**Architecture:** 수집(네이버 주가 + KRX 일별 순매수) → 계산(returns.py: 대상선정·스냅샷·연속TWR·벤치마크) → data/returns.json → API/정적빌드 → 프론트 라인차트(3곡선+호버).

**Tech Stack:** Python 3.13(.venv), requests, pytest / 바닐라 JS + SVG (외부 CDN 금지)

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-14-pension-copy-returns-design.md` (계산식·스키마의 단일 진실).
- **롱온리**: 보유 없는 종목의 순매도 무시, 보유 한도 내만 매도. 공매도 없음.
- **상위 5개**, 비중은 5개 내 정규화. 대상은 **T0 직전 1개월** 순매수로 선정(look-ahead 금지).
- 연속 방식은 **시간가중수익률(TWR)**.
- 테스트는 **네트워크 없이** 픽스처/합성 데이터로만.
- 외부 요청 지연: 네이버 0.3초, KRX 0.4초. 일별 KRX 응답은 `data/.cache/krx_daily/`에 캐시(재수집 금지).
- UI는 한국어, dataviz 규칙(2px 선, 3시리즈 범례, 크로스헤어 호버, 테이블 대체 뷰).

## File Structure

| 파일 | 책임 |
|---|---|
| `nps_fetcher/prices.py` (신규) | 네이버 siseJson: 종목/지수 일별 종가 |
| `nps_fetcher/krx_flow.py` (수정) | 일별 종목별 순매수 + 디스크 캐시 추가 |
| `nps_fetcher/returns.py` (신규) | 대상 선정 · 스냅샷 · 연속(TWR) · 벤치마크 · returns.json |
| `nps_fetcher/pipeline.py` (수정) | returns 단계 추가(실패해도 나머지 유지) |
| `app.py` (수정) | `GET /api/returns` |
| `build_static.py` (수정) | returns.json 복사 + build_meta 신선도 대상 |
| `templates/index.html`, `static/app.js`, `static/style.css` (수정) | 새 섹션·라인차트 |
| `tests/test_prices.py`, `tests/test_returns.py` (신규) | 파서·계산 테스트 |

---

### Task 1: 주가/지수 수집 (prices.py)

**Files:** Create `nps_fetcher/prices.py`, `tests/test_prices.py`, fixture `tests/fixtures/naver_sise_005930.txt`

**Interfaces (Produces):**
- `parse_sise_json(text: str) -> dict[str, float]` — {"2026-04-01": 189600.0, ...} 종가만
- `fetch_closes(code: str, start: date, end: date, session=None) -> dict[str, float]`
- `fetch_index_closes(symbol: str, start, end, session=None) -> dict[str, float]` (symbol: "KOSPI"|"KOSDAQ")

- [ ] Step 1: 실제 응답을 픽스처로 저장 (`curl`로 삼성전자 구간 저장)
- [ ] Step 2: 실패 테스트 작성 — `parse_sise_json`이 날짜→종가 매핑 반환, 첫날 189600.0
- [ ] Step 3: `pytest tests/test_prices.py -v` → FAIL
- [ ] Step 4: 구현 (네이버 응답은 JS 배열 형태라 `ast.literal_eval` 대신 정규식/JSON 정제 후 파싱; 헤더행 제외)
- [ ] Step 5: 테스트 PASS 확인
- [ ] Step 6: 커밋 `feat: 네이버 일별 종가 수집(prices.py)`

### Task 2: KRX 일별 종목별 순매수 + 캐시 (krx_flow.py)

**Files:** Modify `nps_fetcher/krx_flow.py`, `tests/test_krx_flow.py`

**Interfaces (Produces):**
- `fetch_daily_netbuy(market: str, day: date, session=None) -> dict[str, int]` — {종목코드: 순매수대금(원)}
- 캐시: `data/.cache/krx_daily/{YYYYMMDD}_{STK|KSQ}.json` (있으면 네트워크 안 탐)

- [ ] Step 1: 실패 테스트 — 단일일자 응답 픽스처로 `parse_rank_rows` 재사용해 {code: net_value} 반환
- [ ] Step 2: FAIL 확인
- [ ] Step 3: 구현 (기존 `_fetch_window(strtDd=endDd=day)` 재사용 + 디스크 캐시 read/write)
- [ ] Step 4: 캐시 테스트 — 두 번째 호출은 네트워크 미사용(세션 None이어도 성공)
- [ ] Step 5: PASS 확인 후 커밋 `feat: KRX 일별 종목별 순매수 + 캐시`

### Task 3: 수익률 계산 (returns.py) — 핵심

**Files:** Create `nps_fetcher/returns.py`, `tests/test_returns.py`

**Interfaces (Produces):**
- `select_basket(rows: list[dict], top_n=5) -> list[dict]` — [{code,name,weight,buy_value}] 비중 정규화
- `snapshot_curve(basket, closes: dict[code, dict[date,close]], dates: list[str]) -> list[float]` — 누적수익률 %
- `continuous_curve(basket, daily_flows: dict[date, dict[code,int]], closes, dates) -> list[float]` — 롱온리 + TWR
- `benchmark_curve(index_closes: dict[date,float], dates) -> list[float]`
- `compute_returns(session=None) -> dict` — returns.json 전체 (시장×기간)

**핵심 계산 (설계 4절 그대로):**
- 스냅샷: `s_i = w_i / P_i(T0)`, `V(t) = Σ s_i·P_i(t)`, `R(t) = (V(t) − 1) × 100`
- 연속(롱온리+TWR): 매일 `f_i(t)>0` → 매수 `s_i += f/P`; `f_i(t)<0` → `sell = min(s_i, |f|/P)`, `s_i −= sell` (보유 0이면 무시).
  `CF(t) = 매수대금 − 매도회수`, `V(t) = Σ s_i·P_i(t)`, `r(t) = (V(t) − CF(t))/V(t−1) − 1` (V(t−1)=0이면 r=0), `R(t) = (Π(1+r) − 1) × 100`

- [ ] Step 1: 실패 테스트 — **손계산 검증**: 2종목, 3일, 알려진 주가/순매수로 스냅샷·연속 값 단언
- [ ] Step 2: 실패 테스트 — **롱온리**: 보유 0인 종목의 순매도 무시 / 보유 초과 매도는 보유량까지만
- [ ] Step 3: 실패 테스트 — `select_basket` 상위 5개, 비중 합 1.0
- [ ] Step 4: FAIL 확인
- [ ] Step 5: 구현
- [ ] Step 6: PASS 확인 후 커밋 `feat: 따라투자 수익률 계산(스냅샷/연속 TWR, 롱온리)`

### Task 4: 파이프라인 · API · 정적빌드 통합

**Files:** Modify `nps_fetcher/pipeline.py`, `app.py`, `build_static.py`, `tests/test_app.py`

- [ ] Step 1: 실패 테스트 — `GET /api/returns` 패스스루(파일 없으면 `{"empty": true}`)
- [ ] Step 2: FAIL 확인
- [ ] Step 3: `app.py`에 라우트 추가; `pipeline`에 returns 단계(try/except, 실패해도 나머지 유지, TOTAL 8로); `build_static`의 `COPY_DATASETS`/`DATASET_FILES`에 `returns` 추가
- [ ] Step 4: `store.VALID_NAMES`에 `"returns"` 추가
- [ ] Step 5: PASS 확인 후 커밋 `feat: returns 파이프라인·API·정적빌드 통합`

### Task 5: 프론트엔드 (라인차트 + 호버 설명)

**Files:** Modify `templates/index.html`, `static/app.js`, `static/style.css`

- [ ] Step 1: index.html — 연기금 수급 섹션 **아래**에 새 카드 `#returns-section` (제목 "연기금 따라 샀다면", 기간/시장 토글, 차트/테이블 뷰 토글, 요약 영역, 한계 고지)
- [ ] Step 2: app.js — `/api/returns` fetch를 `loadAll`에 추가, `STATIC_MAP`에 `data/returns.json`
- [ ] Step 3: app.js — SVG 라인차트 렌더러: 3곡선(스냅샷/연속/지수), 2px 선, 0 기준선, 범례
- [ ] Step 4: app.js — **크로스헤어 호버**: 세 값 + **두 방식 차이 설명**("스냅샷=시작일에 사서 보유 / 연속=매일 따라매매")
- [ ] Step 5: app.js — 요약 카드(각 방식 최종수익률·초과수익) + 바스켓 5종목 + 테이블 대체 뷰
- [ ] Step 6: 브라우저 검증(정상 렌더·호버·토글, 콘솔 에러 0) 후 커밋 `feat: 따라투자 수익률 UI`

### Task 6: 실데이터 수집 및 검증

- [ ] Step 1: `python -m nps_fetcher` 실행 → returns.json 생성 확인(최초 KRX 일별 백필로 수 분 소요)
- [ ] Step 2: 수치 sanity check — 스냅샷/연속/지수 곡선이 합리적 범위, 바스켓 5종목 확인
- [ ] Step 3: 정적 빌드 + 브라우저 확인 → 커밋 & push (GitHub Actions 재배포)
