"""KRX 연기금 종목별 수급 파서 테스트 — 실제 응답 저장본(코스피 2026-07-09~10)."""

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import krx_flow  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _rows():
    d = json.loads((FIXTURES / "krx_pension_rank.json").read_text(encoding="utf-8"))
    return krx_flow.parse_rank_rows(d["output"])


def test_parse_rank_rows():
    rows = _rows()
    assert len(rows) == 430
    top = rows[0]
    # 실측값: SK하이닉스 이틀 순매수 +77,821주 / +1,768.6억원
    assert top == {
        "code": "000660", "name": "SK하이닉스",
        "net_shares": 77821, "net_value": 176860112500,
    }


def test_split_buys_sells():
    result = krx_flow.split_buys_sells(_rows(), top_n=20)
    assert len(result["buys"]) == 20
    assert len(result["sells"]) == 20
    assert result["buys"][0]["name"] == "SK하이닉스"
    # 순매도 1위는 절대값 최대 음수 (실측: SK스퀘어 -650.9억원)
    assert result["sells"][0]["name"] == "SK스퀘어"
    assert result["sells"][0]["net_value"] == -65093119500
    # 매수 내림차순 / 매도는 음수 절대값 내림차순
    buys_v = [r["net_value"] for r in result["buys"]]
    sells_v = [r["net_value"] for r in result["sells"]]
    assert buys_v == sorted(buys_v, reverse=True)
    assert sells_v == sorted(sells_v)
    assert all(v > 0 for v in buys_v) and all(v < 0 for v in sells_v)


# ------------------------------------------- 일별 종목별 순매수 (연속 방식용)
def test_rows_to_netbuy_maps_code_to_value():
    """행 목록 → {종목코드: 순매수대금} 매핑."""
    m = krx_flow.rows_to_netbuy(_rows())
    # 실측: SK하이닉스(000660) 순매수 176,860,112,500원
    assert m["000660"] == 176860112500
    assert all(isinstance(k, str) and len(k) == 6 for k in m)
    assert all(isinstance(v, int) for v in m.values())


def test_fetch_daily_netbuy_uses_disk_cache(tmp_path):
    """캐시 파일이 있으면 네트워크를 타지 않는다 (재수집 방지)."""
    cache = tmp_path / "krx_daily"
    cache.mkdir()
    (cache / "20260713_STK.json").write_text(
        '{"005930": 12345, "000660": -6789}', encoding="utf-8"
    )
    # session=None인데도 성공해야 한다 = 네트워크 미사용
    result = krx_flow.fetch_daily_netbuy(
        "kospi", date(2026, 7, 13), session=None, cache_dir=cache
    )
    assert result == {"005930": 12345, "000660": -6789}
