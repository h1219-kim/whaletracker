"""네이버 투자자별 매매동향 파서 테스트 — 실제 페이지 저장본(코스피 2026-07-10)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import naver_flow  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _read():
    return (FIXTURES / "naver_investor_day.html").read_bytes().decode("euc-kr")


def test_parse_day_page_rows():
    rows = naver_flow.parse_day_page(_read())
    assert len(rows) == 10  # 페이지당 거래일 10개
    by_date = {r["date"]: r for r in rows}
    r = by_date["2026-07-10"]
    # 실측값: 개인 -7,805 / 외국인 -3,228 / 기관계 11,314 / 연기금등 355
    assert r["individual"] == -7805
    assert r["foreign"] == -3228
    assert r["inst_total"] == 11314
    assert r["pension"] == 355


def test_parse_day_page_sorted_and_consistent():
    rows = naver_flow.parse_day_page(_read())
    for r in rows:
        assert r["date"].startswith("2026-")
        assert isinstance(r["pension"], int)


def test_parse_rejects_garbage():
    assert naver_flow.parse_day_page("<html><body>없음</body></html>") == []
