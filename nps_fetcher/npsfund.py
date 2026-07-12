"""국민연금기금운용본부 — 기금 전체 자산배분(포트폴리오 개요) 수집.

페이지: https://fund.nps.or.kr/oprtprcn/ivsmprcn/getOHED0016M0.do
구조: h4.con-title 안에 "( 2026년 4월 말 기준)", .pf-total em 에 전체자산(조원),
.pf-data table 의 tr(th=자산군, td=조원, td=%). '금융부문'은 상위 합계라 제외.
"""

import re
from datetime import datetime

from bs4 import BeautifulSoup

from .http_util import make_session, request_with_retry

PORTFOLIO_URL = "https://fund.nps.or.kr/oprtprcn/ivsmprcn/getOHED0016M0.do"

_AS_OF_RE = re.compile(r"(\d{4})\s*년\s*(\d{1,2})\s*월")


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _leading_number(s: str) -> float | None:
    m = re.match(r"[\d,]+(?:\.\d+)?", s.strip())
    return float(m.group(0).replace(",", "")) if m else None


def _clean_label(s: str) -> str:
    # "복지 ·기타 부문" → "복지·기타" 처럼 공백 정리
    s = re.sub(r"\s*·\s*", "·", s.strip())
    s = re.sub(r"\s+부문$", "", s)
    return s


def parse_portfolio_html(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")

    total_el = soup.select_one(".pf-total em")
    if not total_el:
        raise ValueError("전체자산(.pf-total em)을 찾지 못함")
    total = float(total_el.get_text(strip=True).replace(",", ""))

    # 기준연월: "포트폴리오 개요 ( 2026년 4월 말 기준)" — h4 안의 <p>가
    # 파서에 따라 분리되므로 원시 HTML에서 제목 근처를 직접 찾는다.
    as_of = None
    m = re.search(r"포트폴리오 개요.{0,200}?(\d{4})\s*년\s*(\d{1,2})\s*월", html, re.S)
    if m:
        as_of = f"{m.group(1)}-{int(m.group(2)):02d}"

    assets = []
    for tr in soup.select(".pf-data table tbody tr"):
        th, tds = tr.find("th"), tr.find_all("td")
        if not th or len(tds) < 2:
            continue
        name = _clean_label(th.get_text(strip=True))
        if name == "금융부문":  # 하위 자산군의 합계 행
            continue
        # 셀 형태: "<span>419.5</span> 조 원" → 앞머리 숫자만 추출
        value = _leading_number(tds[0].get_text(" ", strip=True))
        weight = _leading_number(tds[1].get_text(" ", strip=True))
        if value is None or weight is None:
            continue
        assets.append({"name": name, "value_trillion": value, "weight_pct": weight})

    if not assets:
        raise ValueError("자산배분 표를 찾지 못함 (페이지 구조 변경 가능성)")
    assets.sort(key=lambda a: -a["value_trillion"])
    return {
        "as_of": as_of,
        "source": "국민연금기금운용본부 포트폴리오 현황",
        "fetched_at": _now_iso(),
        "total_trillion": total,
        "assets": assets,
    }


def fetch_allocation(session=None) -> dict:
    session = session or make_session()
    resp = request_with_retry(session, "GET", PORTFOLIO_URL)
    return parse_portfolio_html(resp.text)
