"""KRX 정보데이터시스템 — 연기금의 '종목별' 순매수/매도 (투자자별 순매수상위종목).

정규 통계 화면(data.krx.co.kr)은 로그인이 필요하지만, KRX가 외부 임베드용으로
공개한 outerLoader 화면(MDCSTAT024)의 데이터 엔드포인트는 Referer만으로 접근된다.
2026-07-13 교차 검증: invstTpCd=6000(연기금등)의 일별 순매수 합계가
네이버 금융의 '연기금등' 수치와 정확히 일치함을 확인.

응답 행: ISU_SRT_CD(종목코드), ISU_NM(종목명), NETBID_TRDVOL(순매수 수량, 주),
NETBID_TRDVAL(순매수 대금, 원) — 순매수 대금 내림차순 정렬(하단이 순매도 상위).
"""

import json
import time
from datetime import date, timedelta
from datetime import datetime

from . import store
from .http_util import make_session, request_with_retry

OUTER_REFERER = (
    "https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd"
    "?screenId=MDCSTAT024&locale=ko_KR"
)
DATA_URL = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
BLD = "dbms/MDC_OUT/STAT/standard/MDCSTAT02401_OUT"
INVST_PENSION = "6000"  # 연기금등
MARKETS = {"kospi": "STK", "kosdaq": "KSQ"}
WINDOWS = [("1d", "오늘", 0), ("1w", "1주", 7), ("1m", "1개월", 30), ("3m", "3개월", 91)]
KRX_DELAY = 0.4  # 요청 간 지연(초)
TOP_N = 20


def _num(s: str) -> int:
    return int(str(s).replace(",", "") or 0)


def parse_rank_rows(rows: list[dict]) -> list[dict]:
    """KRX 응답 행 → [{code, name, net_shares, net_value}] (원 단위)."""
    out = []
    for r in rows:
        code = (r.get("ISU_SRT_CD") or "").strip()
        name = (r.get("ISU_NM") or "").strip()
        if not code or not name:
            continue
        out.append(
            {
                "code": code,
                "name": name,
                "net_shares": _num(r.get("NETBID_TRDVOL", "0")),
                "net_value": _num(r.get("NETBID_TRDVAL", "0")),
            }
        )
    return out


def split_buys_sells(rows: list[dict], top_n: int = TOP_N) -> dict:
    """순매수 대금 기준 상위/하위 top_n. 0원은 제외."""
    ordered = sorted(rows, key=lambda r: -r["net_value"])
    buys = [r for r in ordered if r["net_value"] > 0][:top_n]
    sells = [r for r in reversed(ordered) if r["net_value"] < 0][:top_n]
    return {"buys": buys, "sells": sells}


def _fetch_window(session, mkt_id: str, start: date, end: date,
                  invst: str = INVST_PENSION) -> list[dict]:
    data = {
        "bld": BLD,
        "locale": "ko_KR",
        "mktId": mkt_id,
        "invstTpCd": invst,
        "strtDd": start.strftime("%Y%m%d"),
        "endDd": end.strftime("%Y%m%d"),
        "share": "1",
        "money": "1",
        "csvxls_isNo": "false",
    }
    resp = request_with_retry(
        session, "POST", DATA_URL, data=data,
        headers={"Referer": OUTER_REFERER, "X-Requested-With": "XMLHttpRequest"},
        delay=KRX_DELAY,
    )
    body = resp.json()
    if "output" not in body:
        raise ValueError(f"KRX 응답에 output 없음 (로그인 게이트 변경 가능성): {str(body)[:120]}")
    return parse_rank_rows(body["output"])


# ------------------------------------------- 일별 종목별 순매수 (연속 방식용)
DAILY_CACHE_DIR = store.DATA_DIR / ".cache" / "krx_daily"


def rows_to_netbuy(rows: list[dict]) -> dict[str, int]:
    """파싱된 행 목록 → {종목코드: 순매수 대금(원)}."""
    return {r["code"]: r["net_value"] for r in rows}


def fetch_daily_netbuy(market: str, day: date, session=None, cache_dir=None,
                       invst: str = INVST_PENSION) -> dict[str, int]:
    """특정 거래일의 종목별 순매수 대금 (기본: 연기금, invst로 투자자 변경).

    같은 날짜는 다시 바뀌지 않으므로 디스크에 캐시한다(재수집 방지).
    캐시가 있으면 네트워크를 타지 않는다. 연기금(기본값)은 기존 캐시
    파일명을 그대로 써서 이미 쌓인 캐시와 호환된다.
    """
    mkt_id = MARKETS[market]
    cdir = cache_dir or DAILY_CACHE_DIR
    suffix = "" if invst == INVST_PENSION else f"_{invst}"
    cache_file = cdir / f"{day.strftime('%Y%m%d')}_{mkt_id}{suffix}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except ValueError:
            pass  # 손상된 캐시는 무시하고 다시 받는다

    session = session or make_session()
    rows = _fetch_window(session, mkt_id, day, day, invst=invst)
    result = rows_to_netbuy(rows)

    cdir.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def fetch_pension_stock_flow(session=None) -> dict:
    """기간별(1주/1개월/3개월) × 시장별 연기금 종목별 순매수/매도 상위."""
    session = session or make_session()
    # 임베드 화면을 먼저 열어 세션 쿠키 확보 (없어도 동작하지만 예의상)
    request_with_retry(session, "GET", OUTER_REFERER, delay=KRX_DELAY)

    end = date.today()
    windows = []
    for key, label, days_back in WINDOWS:
        if days_back == 0:
            # '오늘' = 최근 거래일 하루. 당일 데이터가 없으면(장중·휴장)
            # 직전 거래일까지 최대 6일 거슬러 올라가 데이터가 있는 하루를 쓴다.
            markets, used = {}, end
            for back in range(6):
                day = end - timedelta(days=back)
                trial = {
                    m: split_buys_sells(_fetch_window(session, mid, day, day))
                    for m, mid in MARKETS.items()
                }
                if any(t["buys"] or t["sells"] for t in trial.values()):
                    markets, used = trial, day
                    break
            windows.append({
                "key": key, "label": label,
                "start": used.isoformat(), "end": used.isoformat(),
                "markets": markets,
            })
            continue
        start = end - timedelta(days=days_back)
        markets = {}
        for market, mkt_id in MARKETS.items():
            rows = _fetch_window(session, mkt_id, start, end)
            markets[market] = split_buys_sells(rows)
        windows.append(
            {
                "key": key,
                "label": label,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "markets": markets,
            }
        )
    return {
        "source": "KRX 정보데이터시스템 · 투자자별(연기금) 순매수상위종목",
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "unit": "원",
        "windows": windows,
    }
