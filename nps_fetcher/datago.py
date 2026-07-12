"""공공데이터포털(data.go.kr) 파일 데이터 수집.

- 소스 A: 국민연금공단 국내주식 투자정보 (연 1회, 연말 기준) → holdings
- 소스 B: 국민연금공단 대량보유주식 보고내역 (분기) → major_stakes

다운로드 URL의 atchFileId는 데이터셋 갱신 시 바뀌므로
매번 데이터셋 페이지에서 contentUrl을 추출한 뒤 내려받는다.
"""

import csv
import io
import re
from datetime import datetime

from .http_util import make_session, request_with_retry

HOLDINGS_PAGE = "https://www.data.go.kr/data/3070507/fileData.do"
MAJOR_STAKES_PAGE = "https://www.data.go.kr/data/15106890/fileData.do"

_CONTENT_URL_RE = re.compile(
    r'"contentUrl"\s*:\s*"(https://www\.data\.go\.kr/cmm/cmm/fileDownload\.do[^"]+)"'
)
_AS_OF_RE = re.compile(r"(?:투자정보|보고내역)_(\d{8})")


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _get_page_and_csv(session, page_url):
    """데이터셋 페이지에서 contentUrl 추출 후 CSV 텍스트와 기준일자를 반환."""
    page = request_with_retry(session, "GET", page_url).text
    m = _CONTENT_URL_RE.search(page)
    if not m:
        raise ValueError(f"contentUrl을 찾지 못함: {page_url}")
    csv_resp = request_with_retry(session, "GET", m.group(1).replace("\\/", "/"))
    raw = csv_resp.content
    try:
        text = raw.decode("cp949")
    except UnicodeDecodeError:
        text = raw.decode("utf-8-sig")

    as_of = None
    m2 = _AS_OF_RE.search(page)
    if m2:
        d = m2.group(1)
        as_of = f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return text, as_of


def _num(s: str) -> float:
    return float(s.replace(",", "").strip())


def parse_holdings_csv(text: str) -> list[dict]:
    """헤더: 번호,종목명,평가액(억 원),자산군 내 비중(퍼센트),지분율(퍼센트)"""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or "종목명" not in "".join(rows[0]):
        raise ValueError("보유종목 CSV 헤더가 예상과 다름")
    stocks = []
    for row in rows[1:]:
        if len(row) < 5 or not row[1].strip():
            continue
        stocks.append(
            {
                "rank": int(_num(row[0])),
                "name": row[1].strip(),
                "value_100m": _num(row[2]),
                "weight_pct": _num(row[3]),
                "ownership_pct": _num(row[4]),
            }
        )
    if not stocks:
        raise ValueError("보유종목 CSV에서 데이터 행을 찾지 못함")
    return stocks


def parse_major_stakes_csv(text: str) -> list[dict]:
    """헤더: 번호,발행기관명 ,보고서 작성기준일,지분율(퍼센트) — 컬럼명 뒤 공백 존재."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or "발행기관명" not in "".join(rows[0]):
        raise ValueError("대량보유 CSV 헤더가 예상과 다름")
    stakes = []
    for row in rows[1:]:
        if len(row) < 4 or not row[1].strip():
            continue
        stakes.append(
            {
                "name": row[1].strip(),
                "report_date": row[2].strip(),
                "ownership_pct": _num(row[3]),
            }
        )
    if not stakes:
        raise ValueError("대량보유 CSV에서 데이터 행을 찾지 못함")
    return stakes


def fetch_holdings(session=None) -> dict:
    session = session or make_session()
    text, as_of = _get_page_and_csv(session, HOLDINGS_PAGE)
    stocks = parse_holdings_csv(text)
    return {
        "as_of": as_of,
        "source": "공공데이터포털 · 국민연금공단 국내주식 투자정보",
        "fetched_at": _now_iso(),
        "total_value_100m": round(sum(s["value_100m"] for s in stocks), 1),
        "stocks": stocks,
    }


def fetch_major_stakes(session=None) -> dict:
    session = session or make_session()
    text, as_of = _get_page_and_csv(session, MAJOR_STAKES_PAGE)
    stakes = parse_major_stakes_csv(text)
    return {
        "as_of": as_of,
        "source": "공공데이터포털 · 국민연금공단 대량보유주식 보고내역",
        "fetched_at": _now_iso(),
        "stakes": stakes,
    }
