"""종목 수급 현미경 — 본주 투자자별 일별 순매수 + 레버리지 상품 경유 개인 수요.

목적: "매일의 주가를 누가 주도했나"를 보여주되, 개인이 레버리지 ETF/ETN을
사면 LP(기관)가 헤지를 위해 본주/선물을 사서 통계상 '기관'으로 잡히는
희석 문제를 보정한 '개인 실질 수요' 시리즈를 함께 제공한다.

- 본주 일별 순매수(개인/외국인/기관합계): KRX (정확한 대금, 일별 캐시)
- 레버리지 상품 개인 유입: 네이버 종목별 투자자 일별표에서
  개인 ≈ -(기관+외국인) 역산 × 종가 (LP 설정/환매 구조라 유효한 근사)
- 보정 개인 = 본주 개인 + Σ(상품 개인유입 × 레버리지 배수(부호 포함))
- 연계 상품은 갱신 때마다 네이버 검색으로 자동 탐색 (신상품 자동 반영)
"""

import re
import urllib.parse
from datetime import date, timedelta

from . import krx_flow, prices, store
from .http_util import make_session, request_with_retry

STOCKS = [
    {"code": "000660", "name": "SK하이닉스"},
    {"code": "005930", "name": "삼성전자"},
]
INVESTORS = {"individual": "8000", "foreign": "9000", "institution": "7050"}
HISTORY_DAYS = 130  # 달력일 기준 (거래일 ~90일)
FRGN_URL = "https://finance.naver.com/item/frgn.naver"
AC_URL = "https://ac.stock.naver.com/ac"

_DATE_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")


# ---------------------------------------------------------------- 상품 탐색
def classify_product(name: str) -> int:
    """상품명 → 레버리지 배수(부호 포함). 대상 아니면 0.

    '단일종목레버리지'=+2, '인버스2X'=-2. 채권혼합·커버드콜·1배 상품은 제외.
    """
    if "인버스" in name or "곱버스" in name:
        return -2
    if "레버리지" in name or ("2X" in name.upper() and "인버스" not in name):
        return 2
    return 0


def discover_products(base_name: str, base_code: str, session=None) -> list[dict]:
    """네이버 검색으로 연계 레버리지/인버스 상품을 자동 수집."""
    session = session or make_session()
    found: dict[str, dict] = {}
    queries = [f"{base_name} 레버리지", f"{base_name}단일종목", f"{base_name} 인버스"]
    for q in queries:
        try:
            resp = request_with_retry(
                session, "GET", f"{AC_URL}?q={urllib.parse.quote(q)}&target=stock",
                delay=0.25,
            )
            items = resp.json().get("items", [])
        except Exception:
            continue
        for it in items:
            name, code = it.get("name", ""), it.get("code", "")
            if base_name not in name or code == base_code:
                continue
            factor = classify_product(name)
            if factor:
                found[code] = {"code": code, "name": name, "factor": factor}
    return sorted(found.values(), key=lambda p: p["name"])


# ------------------------------------------- 네이버 종목별 투자자 일별표 파싱
def parse_frgn_rows(html: str) -> list[dict]:
    """[{date, close, inst_qty, frgn_qty}] — 개인은 -(inst+frgn)로 역산."""
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = [re.sub(r"<[^>]+>|&nbsp;?", "", c).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(cells) != 9 or not _DATE_RE.match(cells[0]):
            continue
        try:
            out.append({
                "date": cells[0].replace(".", "-"),
                "close": float(cells[1].replace(",", "")),
                "inst_qty": int(cells[5].replace(",", "").replace("+", "")),
                "frgn_qty": int(cells[6].replace(",", "").replace("+", "")),
            })
        except ValueError:
            continue
    return out


def fetch_retail_flow_via_frgn(code: str, pages: int = 6, session=None) -> dict[str, float]:
    """{날짜: 개인 순매수 대금(원)} — 개인수량 ≈ -(기관+외국인), 대금 ≈ ×종가."""
    session = session or make_session()
    out: dict[str, float] = {}
    for p in range(1, pages + 1):
        resp = request_with_retry(
            session, "GET", FRGN_URL, params={"code": code, "page": str(p)},
            headers={"Referer": "https://finance.naver.com"}, delay=0.3,
        )
        resp.encoding = "euc-kr"
        rows = parse_frgn_rows(resp.text)
        if not rows:
            break
        for r in rows:
            person_qty = -(r["inst_qty"] + r["frgn_qty"])
            out[r["date"]] = person_qty * r["close"]
    return out


# ---------------------------------------------------------------- 보정 계산
def adjusted_individual(base: list[float], lever_extra: list[float]) -> list[float]:
    """개인 실질 수요 = 본주 개인 + 레버리지 경유(배수 반영) 익스포저."""
    return [round(b + e, 1) for b, e in zip(base, lever_extra)]


# ---------------------------------------------------------------- 전체 수집
def _aum_snapshot(codes: set[str], session) -> dict[str, float]:
    """상품 현재 시가총액(억원). 실패해도 무시(빈 dict)."""
    aum = {}
    for api in ("etfItemList.nhn", "etnItemList.nhn"):
        try:
            d = request_with_retry(
                session, "GET", f"https://finance.naver.com/api/sise/{api}",
                headers={"Referer": "https://finance.naver.com"}, delay=0.3,
            ).json()
            items = (d.get("result", {}).get("etfItemList")
                     or d.get("result", {}).get("etnItemList") or [])
            for it in items:
                if it.get("itemcode") in codes:
                    aum[it["itemcode"]] = it.get("marketSum", 0)
        except Exception:
            pass
    return aum


def compute_stock_flow(session=None, today: date | None = None) -> dict:
    """stock_flow.json 전체 생성."""
    session = session or make_session()
    today = today or date.today()
    hist_start = today - timedelta(days=HISTORY_DAYS)

    idx = prices.fetch_index_closes(prices.KOSPI, hist_start - timedelta(days=20),
                                    today, session)
    dates = prices.trading_days(idx, hist_start.isoformat(), today.isoformat())

    # 본주 일별 순매수: (일, 투자자) 캐시 — 한 파일에 전 종목이 들어있어 종목 공유
    daily: dict[str, dict[str, dict[str, int]]] = {k: {} for k in INVESTORS}
    for key, invst in INVESTORS.items():
        for d in dates:
            try:
                daily[key][d] = krx_flow.fetch_daily_netbuy(
                    "kospi", prices.to_date(d), session, invst=invst)
            except Exception:
                daily[key][d] = {}

    stocks_out = {}
    all_product_codes: set[str] = set()
    per_stock_products: dict[str, list[dict]] = {}
    for s in STOCKS:
        per_stock_products[s["code"]] = discover_products(s["name"], s["code"], session)
        all_product_codes |= {p["code"] for p in per_stock_products[s["code"]]}
    aum = _aum_snapshot(all_product_codes, session)

    for s in STOCKS:
        code, name = s["code"], s["name"]
        closes = prices.fetch_closes_cached(code, hist_start - timedelta(days=7),
                                            today, session)
        products = per_stock_products[code]

        # 상품별 개인 유입 (일별)
        product_flows: dict[str, dict[str, float]] = {}
        for p in products:
            product_flows[p["code"]] = fetch_retail_flow_via_frgn(p["code"], session=session)

        flows = {k: [] for k in INVESTORS}
        lever_extra, lever_inflow = [], []
        close_series = []
        for d in dates:
            close_series.append(prices.last_close_on_or_before(closes, d))
            for k in INVESTORS:
                flows[k].append(round(daily[k][d].get(code, 0) / 1e8, 1))  # 억원
            extra = inflow = 0.0
            for p in products:
                f = product_flows[p["code"]].get(d, 0.0)
                inflow += f if p["factor"] > 0 else 0.0
                extra += f * p["factor"]
            lever_extra.append(round(extra / 1e8, 1))
            lever_inflow.append(round(inflow / 1e8, 1))

        cum = lambda xs: round(sum(xs), 1)  # noqa: E731
        stocks_out[code] = {
            "name": name,
            "dates": dates,
            "close": close_series,
            "flows": flows,                      # 억원/일 (KRX 정확)
            "lever_extra": lever_extra,          # 억원/일, 배수 반영 익스포저 (근사)
            "lever_inflow": lever_inflow,        # 억원/일, 레버리지 개인 유입(1배 돈)
            "individual_adjusted": adjusted_individual(flows["individual"], lever_extra),
            "products": [
                {**p, "aum_100m": aum.get(p["code"])} for p in products
            ],
            "summary": {
                "individual": cum(flows["individual"]),
                "foreign": cum(flows["foreign"]),
                "institution": cum(flows["institution"]),
                "lever_inflow": cum(lever_inflow),
                "lever_aum_100m": round(sum(
                    a["aum_100m"] or 0 for a in
                    ({**p, "aum_100m": aum.get(p["code"])} for p in products)
                    if a["factor"] > 0), 0),
            },
        }

    return {
        "source": "KRX 투자자별(본주) + 네이버 종목별 투자자(레버리지 역산)",
        "fetched_at": store.now_kst_iso(),
        "as_of": today.isoformat(),
        "stocks": stocks_out,
    }
