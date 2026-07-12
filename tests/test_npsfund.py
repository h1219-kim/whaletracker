"""기금운용본부 자산배분 파서 테스트 — 실제 페이지 저장본으로 검증."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import npsfund  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_portfolio_html():
    html = (FIXTURES / "npsfund_portfolio.html").read_text(encoding="utf-8")
    result = npsfund.parse_portfolio_html(html)

    assert result["as_of"] == "2026-04"
    assert result["total_trillion"] == 1670.7

    by_name = {a["name"]: a for a in result["assets"]}
    assert "금융부문" not in by_name  # 합계 행은 제외
    assert by_name["해외주식"] == {"name": "해외주식", "value_trillion": 604.5, "weight_pct": 36.2}
    assert by_name["국내주식"]["value_trillion"] == 419.5
    assert by_name["복지·기타"]["weight_pct"] == 0.1
    assert len(result["assets"]) == 7
    # 금액 내림차순 정렬
    values = [a["value_trillion"] for a in result["assets"]]
    assert values == sorted(values, reverse=True)
