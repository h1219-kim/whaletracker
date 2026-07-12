"""공공데이터포털 CSV 파서 테스트 — 실제 다운로드 저장본으로 검증."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import datago  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _read_csv(name: str) -> str:
    raw = (FIXTURES / name).read_bytes()
    try:
        return raw.decode("cp949")
    except UnicodeDecodeError:
        return raw.decode("utf-8-sig")


def test_parse_holdings_csv():
    stocks = datago.parse_holdings_csv(_read_csv("nps_holdings.csv"))
    assert len(stocks) == 1200
    top = stocks[0]
    assert top == {
        "rank": 1, "name": "삼성전자",
        "value_100m": 230421.0, "weight_pct": 16.7, "ownership_pct": 7.26,
    }


def test_parse_major_stakes_csv():
    stakes = datago.parse_major_stakes_csv(_read_csv("nps_5pct.csv"))
    assert len(stakes) == 142
    assert stakes[0] == {
        "name": "(주)KB금융지주", "report_date": "2026-01-29", "ownership_pct": 8.94,
    }


def test_content_url_regex():
    html = (
        'foo "contentUrl": "https://www.data.go.kr/cmm/cmm/fileDownload.do'
        '?atchFileId=FILE_000000003558824&fileDetailSn=1&insertDataPrcus=N" bar'
    )
    m = datago._CONTENT_URL_RE.search(html)
    assert m
    assert "atchFileId=FILE_000000003558824" in m.group(1)


def test_as_of_regex():
    assert datago._AS_OF_RE.search("국민연금공단_국내주식 투자정보_20241231").group(1) == "20241231"
    assert datago._AS_OF_RE.search("국민연금공단_대량보유주식 보고내역_20260331").group(1) == "20260331"


def test_parse_holdings_rejects_bad_header():
    with pytest.raises(ValueError):
        datago.parse_holdings_csv("엉뚱한,헤더\n1,2")
