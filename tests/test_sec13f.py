"""SEC 13F information table 파서 테스트."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import sec13f  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_info_table_aggregates_by_cusip():
    xml = (FIXTURES / "sec13f_sample.xml").read_text(encoding="utf-8")
    holdings = sec13f.parse_info_table(xml)

    # SLB는 2개 행(SOLE+DFND)이 cusip으로 합산돼야 한다
    slb = holdings["806857108"]
    assert slb["issuer"] == "SLB LIMITED"
    assert slb["shares"] == 2576371 + 20000
    assert slb["value_usd"] == 132399706 + 1000000

    arch = holdings["G0450A105"]
    assert arch["shares"] == 694582

    # PRN(채권류)과 putCall(옵션)은 제외
    assert "999999999" not in holdings
    assert "888888888" not in holdings
    assert len(holdings) == 2


def test_parse_info_table_empty_raises():
    with pytest.raises(ValueError):
        sec13f.parse_info_table("<informationTable xmlns='http://www.sec.gov/edgar/document/thirteenf/informationtable'></informationTable>")
