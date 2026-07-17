"""네이버 일별 종가 파서 테스트 — 실제 응답 저장본으로 검증."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import prices  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_parse_sise_json_stock():
    """종목 응답 → {날짜: 종가}. 헤더행은 제외."""
    closes = prices.parse_sise_json(_read("naver_sise_005930.txt"))

    # 실측: 2026-04-01 종가 189600
    assert closes["2026-04-01"] == 189600.0
    assert closes["2026-04-02"] == 178400.0
    # 헤더('날짜')가 키로 들어오면 안 된다
    assert "날짜" not in closes
    assert all(k[4] == "-" and len(k) == 10 for k in closes)  # YYYY-MM-DD
    assert all(isinstance(v, float) and v > 0 for v in closes.values())
    assert len(closes) > 50  # 3개월치 거래일


def test_parse_sise_json_index():
    """지수도 같은 형식 (KOSPI 종가는 소수)."""
    closes = prices.parse_sise_json(_read("naver_sise_kospi.txt"))
    assert closes["2026-04-01"] == pytest.approx(5478.7)
    assert closes["2026-04-02"] == pytest.approx(5234.05)


def test_parse_sise_json_empty_raises():
    with pytest.raises(ValueError):
        prices.parse_sise_json("")


def test_parse_sise_ohlc_stock():
    """캔들용: 같은 응답에서 시/고/저/종을 함께 얻는다."""
    ohlc = prices.parse_sise_ohlc(_read("naver_sise_005930.txt"))

    # 실측: 2026-04-01 시 179000 / 고 190800 / 저 178000 / 종 189600
    bar = ohlc["2026-04-01"]
    assert bar == {"o": 179000.0, "h": 190800.0, "l": 178000.0, "c": 189600.0}
    # 종가 파서와 날짜·종가가 완전히 일치해야 한다
    closes = prices.parse_sise_json(_read("naver_sise_005930.txt"))
    assert set(ohlc) == set(closes)
    assert all(ohlc[d]["c"] == closes[d] for d in closes)
    # 고가 ≥ 시/종 ≥ 저가 불변식
    assert all(b["h"] >= max(b["o"], b["c"]) and b["l"] <= min(b["o"], b["c"])
               for b in ohlc.values())


def test_parse_sise_ohlc_empty_raises():
    with pytest.raises(ValueError):
        prices.parse_sise_ohlc("[['날짜','시가'],]")


def test_last_close_on_or_before():
    """휴장일 보정: 해당일이 없으면 그 이전 최근 거래일 종가."""
    closes = {"2026-04-01": 100.0, "2026-04-03": 110.0}
    assert prices.last_close_on_or_before(closes, "2026-04-01") == 100.0
    assert prices.last_close_on_or_before(closes, "2026-04-02") == 100.0  # 휴장 → 직전
    assert prices.last_close_on_or_before(closes, "2026-04-05") == 110.0
    assert prices.last_close_on_or_before(closes, "2026-03-31") is None  # 이전 데이터 없음
