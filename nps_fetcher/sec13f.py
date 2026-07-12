"""SEC EDGAR — 국민연금(NPS)의 미국 주식 분기 보유 공시(13F-HR) 수집.

- 제출 목록: https://data.sec.gov/submissions/CIK0001608046.json
- 각 공시의 information table XML을 파싱해 종목별 보유(주식수·평가액 USD)를 집계.
- 최신 분기와 직전 분기를 비교해 증감·신규·청산을 계산.

SEC 요청 정책: 연락처가 포함된 User-Agent 필수, 초당 10요청 이하.
"""

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime

import requests

CIK = "1608046"
SUBMISSIONS_URL = f"https://data.sec.gov/submissions/CIK{int(CIK):010d}.json"
ARCHIVE_BASE = f"https://www.sec.gov/Archives/edgar/data/{CIK}"
SEC_UA = "WhaleTracker/1.0 (personal research; ihyuntae95@gmail.com)"
SEC_DELAY = 0.3  # 요청 간 지연(초)

_NS = "{http://www.sec.gov/edgar/document/thirteenf/informationtable}"


def _get(session, url):
    time.sleep(SEC_DELAY)
    resp = session.get(url, headers={"User-Agent": SEC_UA}, timeout=20)
    resp.raise_for_status()
    return resp


def list_13f_filings(session) -> list[dict]:
    """13F-HR 제출 목록 (최신순). [{accession, filed_date, period}]"""
    data = _get(session, SUBMISSIONS_URL).json()
    recent = data["filings"]["recent"]
    out = []
    for form, acc, filed, period in zip(
        recent["form"], recent["accessionNumber"],
        recent["filingDate"], recent["reportDate"],
    ):
        if form == "13F-HR":  # 정정(/A)은 v1에서 제외
            out.append({"accession": acc, "filed_date": filed, "period": period})
    return out


def fetch_info_table_xml(session, accession: str) -> str:
    """공시 디렉터리에서 information table XML 본문을 찾아 반환."""
    acc_nodash = accession.replace("-", "")
    index = _get(session, f"{ARCHIVE_BASE}/{acc_nodash}/index.json").json()
    names = [item["name"] for item in index["directory"]["item"]]
    xml_names = [n for n in names if n.endswith(".xml") and n != "primary_doc.xml"]
    if not xml_names:
        raise ValueError(f"information table XML을 찾지 못함 ({accession})")
    return _get(session, f"{ARCHIVE_BASE}/{acc_nodash}/{xml_names[0]}").text


def parse_info_table(xml_text: str) -> dict:
    """information table XML → cusip 기준 집계 {cusip: {issuer, cls, shares, value_usd}}"""
    root = ET.fromstring(xml_text)
    holdings: dict[str, dict] = {}
    for it in root.iter(f"{_NS}infoTable"):
        def field(tag, parent=it):
            el = parent.find(f"{_NS}{tag}")
            return el.text if el is not None and el.text else ""

        if field("putCall"):  # 옵션 제외
            continue
        shrs = it.find(f"{_NS}shrsOrPrnAmt")
        if shrs is None or field("sshPrnamtType", shrs) != "SH":  # 주식만
            continue
        cusip = field("cusip").strip()
        if not cusip:
            continue
        h = holdings.setdefault(
            cusip,
            {"issuer": re.sub(r"\s+", " ", field("nameOfIssuer")).strip(),
             "cls": re.sub(r"\s+", " ", field("titleOfClass")).strip(),
             "shares": 0, "value_usd": 0},
        )
        h["shares"] += int(field("sshPrnamt", shrs) or 0)
        h["value_usd"] += int(field("value") or 0)
    if not holdings:
        raise ValueError("information table에서 보유 종목을 찾지 못함")
    return holdings


def fetch_us_holdings(session=None) -> dict:
    """최신 13F와 직전 13F를 비교한 미국 주식 보유 현황."""
    session = session or requests.Session()
    filings = list_13f_filings(session)
    if not filings:
        raise ValueError("13F-HR 공시를 찾지 못함")
    latest = filings[0]
    prev = filings[1] if len(filings) > 1 else None

    cur = parse_info_table(fetch_info_table_xml(session, latest["accession"]))
    old = (
        parse_info_table(fetch_info_table_xml(session, prev["accession"]))
        if prev else {}
    )

    total_value = sum(h["value_usd"] for h in cur.values())
    holdings = []
    for cusip, h in cur.items():
        p = old.get(cusip)
        holdings.append(
            {
                "cusip": cusip,
                "issuer": h["issuer"],
                "cls": h["cls"],
                "shares": h["shares"],
                "value_usd": h["value_usd"],
                "weight_pct": round(h["value_usd"] / total_value * 100, 2) if total_value else 0,
                "prev_shares": p["shares"] if p else None,  # None = 신규 편입
                "delta_shares": h["shares"] - p["shares"] if p else None,
            }
        )
    holdings.sort(key=lambda h: -h["value_usd"])

    exited = [
        {"cusip": c, "issuer": h["issuer"], "prev_shares": h["shares"],
         "prev_value_usd": h["value_usd"]}
        for c, h in old.items() if c not in cur
    ]
    exited.sort(key=lambda h: -h["prev_value_usd"])

    return {
        "source": "SEC EDGAR 13F-HR (National Pension Service)",
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "as_of": latest["period"],
        "filed_date": latest["filed_date"],
        "prev_as_of": prev["period"] if prev else None,
        "total_value_usd": total_value,
        "count": len(holdings),
        "new_count": sum(1 for h in holdings if h["prev_shares"] is None),
        "exited_count": len(exited),
        "holdings": holdings,
        "exited": exited[:30],
    }
