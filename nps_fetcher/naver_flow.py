"""네이버 금융 — 투자자별 매매동향에서 '연기금등' 일별 순매수 수집 (간접 지표).

페이지: https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=YYYYMMDD&sosok=01&page=N
- sosok: 01=코스피, 02=코스닥. 페이지당 거래일 10개, EUC-KR 인코딩.
- 행(11셀): 날짜, 개인, 외국인, 기관계,
  [기관 세부] 금융투자, 보험, 투신(사모), 은행, 기타금융기관, 연기금등, 기타법인
- 검증: 기관 세부 6개 합 ≈ 기관계 (반올림 ±5억)

주의: '연기금등'은 국민연금 외 연기금을 포함하고, 국민연금 위탁운용분은
투신·사모로 집계되어 빠진다 — 방향성 프록시로만 쓴다.
"""

import re
import time
from datetime import date, datetime

from bs4 import BeautifulSoup

from .http_util import make_session, request_with_retry

URL = "https://finance.naver.com/sise/investorDealTrendDay.naver"
MARKETS = {"kospi": "01", "kosdaq": "02"}
PAGE_DELAY = 0.3  # 요청 간 지연(초)

_ROW_DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})$")


def _num(s: str) -> int | None:
    s = s.replace(",", "").replace("+", "").strip()
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return None


def parse_day_page(html: str) -> list[dict]:
    """한 페이지의 일별 행들 → [{date, pension, individual, foreign, inst_total}] (단위: 억원)"""
    soup = BeautifulSoup(html, "lxml")
    out = []
    for tr in soup.find_all("tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) != 11:
            continue
        m = _ROW_DATE_RE.match(cells[0])
        if not m:
            continue
        nums = [_num(c) for c in cells[1:]]
        if any(n is None for n in nums):
            continue
        indiv, foreign, inst_total = nums[0], nums[1], nums[2]
        details, etc_corp = nums[3:9], nums[9]
        pension = details[5]  # 연기금등
        # 기관 세부 합 ≈ 기관계 검증 (반올림 오차 허용)
        if abs(sum(details) - inst_total) > 5:
            continue
        out.append(
            {
                "date": f"20{m.group(1)}-{m.group(2)}-{m.group(3)}",
                "pension": pension,
                "individual": indiv,
                "foreign": foreign,
                "inst_total": inst_total,
            }
        )
    return out


def fetch_pension_flow(session=None, days: int = 60) -> dict:
    """코스피·코스닥의 최근 N거래일 '연기금등' 순매수 (억원)."""
    session = session or make_session()
    bizdate = date.today().strftime("%Y%m%d")
    max_pages = days // 10 + 2

    markets: dict[str, list] = {}
    for market, sosok in MARKETS.items():
        by_date: dict[str, dict] = {}
        for page in range(1, max_pages + 1):
            time.sleep(PAGE_DELAY)
            resp = request_with_retry(
                session, "GET", URL,
                params={"bizdate": bizdate, "sosok": sosok, "page": str(page)},
            )
            resp.encoding = "euc-kr"
            rows = parse_day_page(resp.text)
            if not rows:
                break
            for r in rows:
                by_date[r["date"]] = r
            if len(by_date) >= days:
                break
        if not by_date:
            raise ValueError(f"연기금 매매동향 파싱 실패 ({market}) — 페이지 구조 변경 가능성")
        markets[market] = sorted(by_date.values(), key=lambda r: r["date"])[-days:]

    return {
        "source": "KRX 투자자별 매매동향 (네이버 금융 집계)",
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "unit": "억원",
        "markets": markets,
    }
