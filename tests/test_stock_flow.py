"""수급 현미경(stock_flow) 테스트 — 상품 분류·frgn 파싱·보정 계산."""

import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import krx_flow, stock_flow  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------- 상품 분류
def test_classify_product():
    assert stock_flow.classify_product("KODEX SK하이닉스단일종목레버리지") == 2
    assert stock_flow.classify_product("미래에셋 레버리지 SK하이닉스 단일종목ETN") == 2
    assert stock_flow.classify_product("SOL SK하이닉스선물단일종목인버스2X") == -2
    # 1배·채권혼합·커버드콜은 제외
    assert stock_flow.classify_product("KODEX 삼성전자SK하이닉스채권혼합50") == 0
    assert stock_flow.classify_product("UNICORN SK하이닉스밸류체인액티브") == 0


def test_discover_products_from_fixture(monkeypatch):
    """검색 응답 픽스처에서 레버리지/인버스만 골라낸다."""
    ac = json.loads((FIXTURES / "naver_ac_hynix.json").read_text(encoding="utf-8"))

    class FakeResp:
        def json(self):
            return ac

    monkeypatch.setattr(stock_flow, "request_with_retry",
                        lambda *a, **k: FakeResp())
    products = stock_flow.discover_products("SK하이닉스", "000660", session=object())
    codes = {p["code"] for p in products}
    assert "000660" not in codes  # 본주 제외
    assert all(p["factor"] in (2, -2) for p in products)
    assert any("레버리지" in p["name"] for p in products)


# ------------------------------------------------------------- frgn 파싱
def test_parse_frgn_rows_fixture():
    html = (FIXTURES / "naver_frgn_0193T0.html").read_bytes().decode("euc-kr")
    rows = stock_flow.parse_frgn_rows(html)
    assert len(rows) == 20  # 페이지당 거래일 20개
    r = next(x for x in rows if x["date"] == "2026-07-16")
    # 실측: 종가 14,585 / 기관 -15,879,535 / 외국인 -2,320,462
    assert r["close"] == 14585.0
    assert r["inst_qty"] == -15879535
    assert r["frgn_qty"] == -2320462


# ------------------------------------------------------------- 보정 계산
def test_adjusted_individual():
    base = [100.0, -50.0, 0.0]
    extra = [20.0, 30.0, -10.0]
    assert stock_flow.adjusted_individual(base, extra) == [120.0, -20.0, -10.0]


# --------------------------------------------- krx 캐시 키 (투자자별 분리)
def test_daily_netbuy_cache_key_per_investor(tmp_path):
    """연기금(기본)은 기존 파일명, 다른 투자자는 접미사 분리."""
    (tmp_path / "20260713_STK.json").write_text('{"005930": 1}', encoding="utf-8")
    (tmp_path / "20260713_STK_8000.json").write_text('{"005930": 2}', encoding="utf-8")

    pension = krx_flow.fetch_daily_netbuy("kospi", date(2026, 7, 13),
                                          session=None, cache_dir=tmp_path)
    indiv = krx_flow.fetch_daily_netbuy("kospi", date(2026, 7, 13),
                                        session=None, cache_dir=tmp_path, invst="8000")
    assert pension == {"005930": 1}   # 기존 캐시 그대로 사용
    assert indiv == {"005930": 2}     # 투자자별 분리 캐시
