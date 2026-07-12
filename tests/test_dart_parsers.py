"""DART 파서 테스트 — 실제 응답 저장본(tests/fixtures)과 실측 기대값으로 검증."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import dart  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------- 목록 파서
def test_search_page_parses_100_rows():
    rows = dart.parse_search_page(_read("dart_list_2026.html"))
    assert len(rows) == 100


def test_search_page_exec_row_fields():
    rows = dart.parse_search_page(_read("dart_list_2026.html"))
    by_rcp = {r["rcp_no"]: r for r in rows}
    r = by_rcp["20260707000347"]
    assert r["company"] == "코리아써키트"
    assert r["corp_code"] == "00152686"
    assert r["report_type"] == "exec"
    assert r["filed_date"] == "2026-07-07"
    assert r["is_correction"] is False


def test_search_page_contains_bulk_row():
    rows = dart.parse_search_page(_read("dart_list_2026.html"))
    by_rcp = {r["rcp_no"]: r for r in rows}
    assert by_rcp["20260701000599"]["report_type"] == "bulk"


# ---------------------------------------------------------------- 목차 파서
def test_toc_exec_document():
    toc = dart.parse_toc(_read("dart_main_doc.html"))
    node = dart.find_section(toc, "특정증권등의 소유상황")
    assert node is not None
    assert node["dcmNo"] == "11466737"
    assert node["eleId"] == "4"
    assert node["offset"] == "11089"
    assert node["length"] == "16643"


def test_toc_bulk_document():
    toc = dart.parse_toc(_read("dart_bulk_main.html"))
    node = dart.find_section(toc, "보유주식등의 수 및 보유비율")
    assert node is not None
    assert node["dcmNo"] == "11458976"
    assert node["eleId"] == "9"
    assert node["offset"] == "31455"
    assert node["length"] == "4915"


# ------------------------------------------------------------ exec 본문 파서
def test_parse_exec_section_ratios_and_trades():
    parsed = dart.parse_exec_section(_read("dart_sec4.html"))

    assert parsed["prev"] == {"date": "2026-06-30", "shares": 2521629, "ratio": 9.09}
    assert parsed["curr"] == {"date": "2026-07-02", "shares": 2383828, "ratio": 8.6}
    assert parsed["delta"] == {"shares": -137801, "ratio": -0.49}

    trades = parsed["trades"]
    assert len(trades) == 3
    assert trades[0] == {
        "reason": "장내매도(-)", "date": "2026-07-01",
        "delta_shares": -113075, "price": 85753.0,
    }
    assert trades[1] == {
        "reason": "장내매수(+)", "date": "2026-07-02",
        "delta_shares": 5274, "price": 95515.0,
    }
    assert trades[2] == {
        "reason": "장내매도(-)", "date": "2026-07-02",
        "delta_shares": -30000, "price": 91880.0,
    }
    # 합계행이 거래로 잘못 잡히지 않아야 함
    assert sum(t["delta_shares"] for t in trades) == -137801


# ------------------------------------------------------------ bulk 본문 파서
def test_parse_bulk_section_ratios():
    parsed = dart.parse_bulk_section(_read("dart_bulk_sec9.html"))
    assert parsed["prev"] == {"date": "2026-03-10", "shares": 702254, "ratio": 5.04}
    assert parsed["curr"] == {"date": "2026-05-13", "shares": 552380, "ratio": 3.96}
    assert parsed["delta"] == {"shares": -149874, "ratio": -1.08}
    assert parsed["trades"] == []


# ------------------------------------------------------- 경계 사례 (실데이터)
def test_parse_exec_initial_report():
    """최초 보고 — 직전보고서 행이 전부 '-'. prev 없음, 증감 미상."""
    parsed = dart.parse_exec_section(_read("dart_sec_initial.html"))
    assert parsed["prev"] is None
    assert parsed["is_initial"] is True
    assert parsed["curr"]["date"] == "2026-07-06"
    assert parsed["curr"]["shares"] == 1170516
    assert parsed["curr"]["ratio"] == 10.10
    assert parsed["delta"] == {"shares": None, "ratio": None}


def test_parse_bulk_zero_holdings():
    """전량 처분 — 이번보고서가 0주/0%도 유효값으로 파싱돼야 한다."""
    parsed = dart.parse_bulk_section(_read("dart_bulk_zero.html"))
    assert parsed["prev"] == {"date": "2025-08-11", "shares": 25733062, "ratio": 13.63}
    assert parsed["curr"] == {"date": "2026-01-02", "shares": 0, "ratio": 0.0}
    assert parsed["delta"] == {"shares": -25733062, "ratio": -13.63}


# ---------------------------------------------------------------- 분류 규칙
def test_classify_report():
    assert dart.classify_report("주식등의대량보유상황보고서(약식)") == ("bulk", False)
    assert dart.classify_report("임원ㆍ주요주주특정증권등소유상황보고서") == ("exec", False)
    assert dart.classify_report("[기재정정]주식등의대량보유상황보고서(약식)") == ("bulk", True)
    assert dart.classify_report("기타공시") == ("other", False)
