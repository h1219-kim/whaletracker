"""store 계층 테스트 — 증분 머지와 매매 동향 집계 규칙."""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import store  # noqa: E402


def _filing(rcp, company, filed, ratio, shares=1000, *, corp=None,
            parse_ok=True, correction=False, rtype="bulk"):
    return {
        "rcp_no": rcp, "filed_date": filed, "company": company,
        "corp_code": corp or f"code-{company}", "report_type": rtype,
        "report_name": "테스트", "is_correction": correction,
        "prev": None, "curr": None,
        "delta": {"shares": shares, "ratio": ratio},
        "trades": [], "parse_ok": parse_ok,
    }


# ---------------------------------------------------------------- 저장/로드
def test_load_missing_returns_none(tmp_path):
    assert store.load_data("filings", tmp_path) is None


def test_save_and_load_roundtrip(tmp_path):
    store.save_data("holdings", {"stocks": [{"name": "삼성전자"}]}, tmp_path)
    loaded = store.load_data("holdings", tmp_path)
    assert loaded["stocks"][0]["name"] == "삼성전자"


def test_unknown_name_raises():
    with pytest.raises(ValueError):
        store.load_data("nope")


# ---------------------------------------------------------------- 증분 머지
def test_merge_unions_by_rcp_no_new_wins():
    existing = {
        "range_start": "2026-01-01", "range_end": "2026-03-01",
        "filings": [_filing("A", "회사1", "2026-02-01", 1.0),
                    _filing("B", "회사2", "2026-02-15", -0.5)],
    }
    new = [_filing("B", "회사2", "2026-02-15", -0.7),  # 같은 rcp_no → 교체
           _filing("C", "회사3", "2026-04-01", 0.3)]
    merged = store.merge_filings(existing, new,
                                 range_start="2026-02-01", range_end="2026-04-10")
    by_rcp = {f["rcp_no"]: f for f in merged["filings"]}
    assert set(by_rcp) == {"A", "B", "C"}
    assert by_rcp["B"]["delta"]["ratio"] == -0.7
    # 범위는 합집합으로 확장
    assert merged["range_start"] == "2026-01-01"
    assert merged["range_end"] == "2026-04-10"
    # 최신 접수일 우선 정렬
    assert merged["filings"][0]["rcp_no"] == "C"


# ---------------------------------------------------------------- trends 집계
@pytest.fixture
def filings_dir(tmp_path):
    filings = [
        # 같은 회사 2건 합산: +1.0 -0.3 = +0.7
        _filing("R1", "매수사", "2026-06-01", 1.0, 5000, corp="C1"),
        _filing("R2", "매수사", "2026-06-20", -0.3, -1500, corp="C1"),
        # 순매도
        _filing("R3", "매도사", "2026-06-10", -1.08, -149874, corp="C2"),
        # 기간 밖 (90일 기준)
        _filing("R4", "옛날사", "2026-01-01", 9.9, 99999, corp="C3"),
        # 집계 제외: 파싱 실패 / 정정
        _filing("R5", "실패사", "2026-06-15", 5.0, 1, corp="C4", parse_ok=False),
        _filing("R6", "정정사", "2026-06-16", 5.0, 1, corp="C5", correction=True),
    ]
    store.save_data("filings", {"fetched_at": "t", "filings": filings}, tmp_path)
    return tmp_path


def test_compute_trends_aggregation(filings_dir):
    t = store.compute_trends(days=90, data_dir=filings_dir, today=date(2026, 7, 12))

    assert t["days"] == 90
    assert t["since"] == "2026-04-13"

    buys = {b["company"]: b for b in t["top_buys"]}
    sells = {s["company"]: s for s in t["top_sells"]}

    assert buys["매수사"]["delta_ratio"] == pytest.approx(0.7)
    assert buys["매수사"]["delta_shares"] == 3500
    assert buys["매수사"]["filings"] == 2
    assert buys["매수사"]["last_date"] == "2026-06-20"

    assert sells["매도사"]["delta_ratio"] == pytest.approx(-1.08)

    # 기간 밖/파싱 실패/정정은 집계 제외
    assert "옛날사" not in buys
    assert "실패사" not in buys and "실패사" not in sells
    assert "정정사" not in buys and "정정사" not in sells


def test_compute_trends_recent_includes_unparsed(filings_dir):
    t = store.compute_trends(days=90, data_dir=filings_dir, today=date(2026, 7, 12))
    rcps = [f["rcp_no"] for f in t["recent_filings"]]
    assert "R5" in rcps  # 공시 목록에는 파싱 실패도 표시
    assert "R4" not in rcps  # 기간 밖은 제외
    # 최신순
    dates = [f["filed_date"] for f in t["recent_filings"]]
    assert dates == sorted(dates, reverse=True)


def test_compute_trends_no_data(tmp_path):
    t = store.compute_trends(days=30, data_dir=tmp_path, today=date(2026, 7, 12))
    assert t["top_buys"] == [] and t["top_sells"] == [] and t["recent_filings"] == []


def test_compute_trends_top12_cap(tmp_path):
    filings = [_filing(f"R{i}", f"회사{i}", "2026-07-01", 0.1 + i * 0.01, corp=f"C{i}")
               for i in range(20)]
    store.save_data("filings", {"filings": filings}, tmp_path)
    t = store.compute_trends(days=30, data_dir=tmp_path, today=date(2026, 7, 12))
    assert len(t["top_buys"]) == 12
    # 절대값 큰 순
    ratios = [b["delta_ratio"] for b in t["top_buys"]]
    assert ratios == sorted(ratios, reverse=True)
