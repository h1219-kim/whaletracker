"""네이버 금융 — 종목/지수의 일별 종가 수집.

엔드포인트: https://api.finance.naver.com/siseJson.naver
  ?symbol=<종목코드|KOSPI|KOSDAQ>&requestType=1&startTime=YYYYMMDD&endTime=YYYYMMDD&timeframe=day

응답은 JSON이 아니라 **파이썬/JS 리터럴 형태의 2차원 배열**이다:
    [['날짜','시가','고가','저가','종가','거래량','외국인소진율'],
     ["20260401", 179000, 190800, 178000, 189600, 32390251, 48.43], ...]
→ ast.literal_eval로 안전 파싱(코드 실행 없음)하고 헤더행을 버린 뒤 종가만 취한다.
"""

import ast
import json
from datetime import date, datetime

from . import store
from .http_util import make_session, request_with_retry

PRICE_CACHE_DIR = store.DATA_DIR / ".cache" / "prices"

URL = "https://api.finance.naver.com/siseJson.naver"
HEADERS = {"Referer": "https://finance.naver.com"}
DELAY = 0.3  # 요청 간 지연(초)

KOSPI = "KOSPI"
KOSDAQ = "KOSDAQ"


def parse_sise_json(text: str) -> dict[str, float]:
    """응답 텍스트 → {"YYYY-MM-DD": 종가}."""
    text = (text or "").strip()
    if not text:
        raise ValueError("빈 응답 (네이버 시세)")
    try:
        rows = ast.literal_eval(text)
    except (ValueError, SyntaxError) as e:
        raise ValueError(f"시세 응답 파싱 실패: {e}") from e
    if not isinstance(rows, list) or len(rows) < 2:
        raise ValueError("시세 응답에 데이터 행이 없음")

    out: dict[str, float] = {}
    for row in rows[1:]:  # 첫 행은 헤더
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        raw_date = str(row[0]).strip()
        if len(raw_date) != 8 or not raw_date.isdigit():
            continue  # 헤더/이상행 방어
        try:
            close = float(row[4])
        except (TypeError, ValueError):
            continue
        out[f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"] = close
    if not out:
        raise ValueError("시세 응답에서 종가를 얻지 못함")
    return out


def parse_sise_ohlc(text: str) -> dict[str, dict[str, float]]:
    """응답 텍스트 → {"YYYY-MM-DD": {"o","h","l","c"}} (캔들 차트용)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("빈 응답 (네이버 시세)")
    try:
        rows = ast.literal_eval(text)
    except (ValueError, SyntaxError) as e:
        raise ValueError(f"시세 응답 파싱 실패: {e}") from e
    if not isinstance(rows, list) or len(rows) < 2:
        raise ValueError("시세 응답에 데이터 행이 없음")

    out: dict[str, dict[str, float]] = {}
    for row in rows[1:]:
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        raw_date = str(row[0]).strip()
        if len(raw_date) != 8 or not raw_date.isdigit():
            continue
        try:
            o, h, l, c = (float(row[i]) for i in (1, 2, 3, 4))
        except (TypeError, ValueError):
            continue
        if not c:
            continue  # 거래 없는 날(전부 0) 방어
        out[f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"] = {
            "o": o, "h": h, "l": l, "c": c,
        }
    if not out:
        raise ValueError("시세 응답에서 시가/고가/저가를 얻지 못함")
    return out


def fetch_ohlc(code: str, start: date, end: date, session=None) -> dict[str, dict[str, float]]:
    """종목코드의 일별 시가/고가/저가/종가. 한 요청으로 전체 구간을 받는다."""
    session = session or make_session()
    params = {
        "symbol": code,
        "requestType": "1",
        "startTime": start.strftime("%Y%m%d"),
        "endTime": end.strftime("%Y%m%d"),
        "timeframe": "day",
    }
    resp = request_with_retry(
        session, "GET", URL, params=params, headers=HEADERS, delay=DELAY
    )
    return parse_sise_ohlc(resp.text)


def last_close_on_or_before(closes: dict[str, float], day: str) -> float | None:
    """day의 종가. 휴장 등으로 없으면 그 이전 최근 거래일 종가. 없으면 None."""
    if day in closes:
        return closes[day]
    earlier = [d for d in closes if d <= day]
    if not earlier:
        return None
    return closes[max(earlier)]


def _fetch(symbol: str, start: date, end: date, session=None) -> dict[str, float]:
    session = session or make_session()
    params = {
        "symbol": symbol,
        "requestType": "1",
        "startTime": start.strftime("%Y%m%d"),
        "endTime": end.strftime("%Y%m%d"),
        "timeframe": "day",
    }
    resp = request_with_retry(
        session, "GET", URL, params=params, headers=HEADERS, delay=DELAY
    )
    return parse_sise_json(resp.text)


def fetch_closes(code: str, start: date, end: date, session=None) -> dict[str, float]:
    """종목코드(6자리)의 일별 종가."""
    return _fetch(code, start, end, session)


def fetch_index_closes(symbol: str, start: date, end: date, session=None) -> dict[str, float]:
    """지수(KOSPI/KOSDAQ)의 일별 종가."""
    return _fetch(symbol, start, end, session)


def fetch_closes_cached(code: str, start: date, end: date, session=None,
                        cache_dir=None) -> dict[str, float]:
    """종가를 디스크에 캐시하되, **부족한 구간만 증분 수집**한다.

    매일 갱신 시 전체를 다시 받지 않고 마지막 날짜 이후만 붙인다
    (백테스트에 수백 종목이 필요하므로 전체 재수집은 너무 느리다).
    """
    cdir = cache_dir or PRICE_CACHE_DIR
    cache_file = cdir / f"{code}.json"
    s_iso, e_iso = start.isoformat(), end.isoformat()

    cached_closes: dict[str, float] = {}
    cached_start, cached_end = None, None
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            cached_closes = cached.get("closes", {})
            cached_start, cached_end = cached.get("start"), cached.get("end")
        except (ValueError, KeyError):
            cached_closes, cached_start, cached_end = {}, None, None

    # 캐시가 요청 구간을 완전히 덮으면 네트워크 없이 반환
    if cached_start and cached_end and cached_start <= s_iso and cached_end >= e_iso:
        return {d: v for d, v in cached_closes.items() if s_iso <= d <= e_iso}

    if cached_closes and cached_start and cached_start <= s_iso and cached_end < e_iso:
        # 증분: 캐시 끝 이후 구간만 추가 수집 (겹치게 조금 여유를 둔다)
        gap_start = to_date(cached_end)
        new = fetch_closes(code, gap_start, end, session)
        merged = {**cached_closes, **new}
        new_start, new_end = cached_start, e_iso
    else:
        merged = fetch_closes(code, start, end, session)
        new_start, new_end = s_iso, e_iso

    cdir.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(
        json.dumps({"start": new_start, "end": new_end, "closes": merged}, ensure_ascii=False),
        encoding="utf-8",
    )
    return {d: v for d, v in merged.items() if s_iso <= d <= e_iso}


def trading_days(closes: dict[str, float], start: str, end: str) -> list[str]:
    """지수 종가를 기준으로 [start, end] 구간의 거래일 목록(오름차순)."""
    return sorted(d for d in closes if start <= d <= end)


def to_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()
