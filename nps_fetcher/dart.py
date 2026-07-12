"""DART 전자공시 — 국민연금공단 제출 공시의 목록 조회와 본문 파싱.

목록: POST /dsab007/detailSearch.ax (textPresenterNm=국민연금공단)
본문: GET /dsaf001/main.do?rcpNo=... 에서 JS 목차(node['dcmNo'/'eleId'/'offset'/'length'])
      추출 후 GET /report/viewer.do 로 필요한 섹션만 요청.

보고서 2종을 파싱한다:
- exec: 임원ㆍ주요주주특정증권등소유상황보고서 — 직전/이번 보고 지분 + 세부변동내역(개별 매매)
- bulk: 주식등의대량보유상황보고서(약식 포함) — 직전/이번 보고 지분
"""

import re
from datetime import date

from bs4 import BeautifulSoup

from .http_util import make_session, request_with_retry

BASE = "https://dart.fss.or.kr"
SEARCH_URL = f"{BASE}/dsab007/detailSearch.ax"
VIEWER_MAIN_URL = f"{BASE}/dsaf001/main.do"
VIEWER_DOC_URL = f"{BASE}/report/viewer.do"
PRESENTER = "국민연금공단"
DART_DELAY = 0.4  # 요청 간 지연(초) — 서버 예의

_SEARCH_HEADERS = {
    "Referer": f"{BASE}/dsab007/main.do",
    "X-Requested-With": "XMLHttpRequest",
}
_CORP_CODE_RE = re.compile(r"openCorpInfoNew\('(\d+)'")
_RCP_NO_RE = re.compile(r"rcpNo=(\d+)")
_TOC_NODE_RE = re.compile(r"node\d+\['(\w+)'\]\s*=\s*\"([^\"]*)\"")
_KDATE_RE = re.compile(r"(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일")


# ---------------------------------------------------------------- 공통 유틸
def _cell_text(el) -> str:
    return re.sub(r"[\s ]+", " ", el.get_text(" ", strip=True)).strip()


def _norm_label(s: str) -> str:
    """'증    감' → '증감' 처럼 공백 제거한 라벨."""
    return re.sub(r"[\s ]+", "", s)


def _kdate(s: str) -> str | None:
    m = _KDATE_RE.search(s)
    if not m:
        return None
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def _int_or_none(s: str) -> int | None:
    s = s.replace(",", "").replace("+", "").strip()
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return None


def _float_or_none(s: str) -> float | None:
    # 단가의 괄호 표기 "(85,753)"도 금액으로 취급 (공시 표기 관행)
    s = s.replace(",", "").replace("+", "").strip().strip("()")
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return float(s)
    return None


def classify_report(report_name: str) -> tuple[str, bool]:
    """보고서명 → (report_type, is_correction)."""
    is_corr = "정정" in report_name
    if "대량보유" in report_name:
        return "bulk", is_corr
    if "임원" in report_name or "주요주주" in report_name:
        return "exec", is_corr
    return "other", is_corr


# ---------------------------------------------------------------- 목록 검색
def search_filings(start: date, end: date, session=None, max_pages=30) -> list[dict]:
    """국민연금공단이 제출한 공시 목록 (최신순)."""
    session = session or make_session()
    filings, page = [], 1
    while page <= max_pages:
        data = {
            "currentPage": str(page),
            "maxResults": "100",
            "maxLinks": "10",
            "sort": "date",
            "series": "desc",
            "textPresenterNm": PRESENTER,
            "startDate": start.strftime("%Y%m%d"),
            "endDate": end.strftime("%Y%m%d"),
        }
        resp = request_with_retry(
            session, "POST", SEARCH_URL, data=data, headers=_SEARCH_HEADERS, delay=DART_DELAY
        )
        rows = parse_search_page(resp.text)
        filings.extend(rows)
        if len(rows) < 100:
            break
        page += 1
    return filings


def parse_search_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    out = []
    for tr in soup.select("table.tbList tbody tr"):
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue  # "조회 결과가 없습니다" 등
        corp_a = tds[1].find("a")
        rpt_a = tds[2].find("a")
        if not rpt_a:
            continue
        m_rcp = _RCP_NO_RE.search(rpt_a.get("href", "") + rpt_a.get("onclick", ""))
        if not m_rcp:
            continue
        corp_code = None
        if corp_a:
            m_corp = _CORP_CODE_RE.search(corp_a.get("href", "") + corp_a.get("onclick", ""))
            if m_corp:
                corp_code = m_corp.group(1)
        report_name = _cell_text(rpt_a)
        rtype, is_corr = classify_report(report_name)
        filed = _cell_text(tds[4]).replace(".", "-")
        out.append(
            {
                "rcp_no": m_rcp.group(1),
                "filed_date": filed,
                "company": _cell_text(corp_a) if corp_a else _cell_text(tds[1]),
                "corp_code": corp_code,
                "report_type": rtype,
                "report_name": report_name,
                "is_correction": is_corr,
            }
        )
    return out


# ---------------------------------------------------------------- 문서 목차
def fetch_toc(rcp_no: str, session=None) -> list[dict]:
    session = session or make_session()
    resp = request_with_retry(
        session, "GET", VIEWER_MAIN_URL, params={"rcpNo": rcp_no}, delay=DART_DELAY
    )
    return parse_toc(resp.text)


def parse_toc(html: str) -> list[dict]:
    """JS의 node['text'/'dcmNo'/'eleId'/'offset'/'length'] 대입문을 순서대로 그룹핑."""
    nodes, cur = [], None
    for key, val in _TOC_NODE_RE.findall(html):
        if key == "text":
            cur = {"text": val}
            nodes.append(cur)
        elif cur is not None and key in ("dcmNo", "eleId", "offset", "length"):
            cur[key] = val
    return [n for n in nodes if all(k in n for k in ("dcmNo", "eleId", "offset", "length"))]


def find_section(toc: list[dict], keyword: str) -> dict | None:
    for node in toc:
        if keyword in node["text"]:
            return node
    return None


def fetch_section(rcp_no: str, node: dict, session=None) -> str:
    session = session or make_session()
    params = {
        "rcpNo": rcp_no,
        "dcmNo": node["dcmNo"],
        "eleId": node["eleId"],
        "offset": node["offset"],
        "length": node["length"],
        "dtd": "dart4.xsd",
    }
    resp = request_with_retry(session, "GET", VIEWER_DOC_URL, params=params, delay=DART_DELAY)
    if not resp.text.strip():
        raise ValueError(f"빈 섹션 응답 (rcpNo={rcp_no}, eleId={node['eleId']})")
    return resp.text


# ------------------------------------------------------- 직전/이번 보고 행 파싱
# 표준 서식의 고정 컬럼: (주식수 인덱스, 비율 인덱스)
_ROW_INDEX = {"exec": (2, 3), "bulk": (4, 5)}


def _parse_prev_curr_rows(soup, report_type: str) -> tuple[dict | None, dict | None]:
    """'직전보고서'/'이번보고서' 행에서 (날짜, 주식수, 비율)을 뽑는다.

    exec: [직전보고서, 날짜, 주식수, 비율, 주식수, 비율]
    bulk: [직전보고서, 날짜, 보고자명, 특별관계자수, 주식등의 수, 비율, ...]

    최초 보고는 직전보고서 행이 전부 "-" → None 유지.
    전량 처분은 이번보고서가 0주/0% → 0도 유효값으로 취급.
    """
    prev = curr = None
    for tr in soup.find_all("tr"):
        cells = [_cell_text(td) for td in tr.find_all(["td", "th"])]
        if not cells:
            continue
        label = _norm_label(cells[0])
        if label not in ("직전보고서", "이번보고서"):
            continue
        d = None
        for c in cells[1:]:
            d = _kdate(c)
            if d:
                break
        # 1) 표준 서식 고정 인덱스
        shares = ratio = None
        idx = _ROW_INDEX.get(report_type)
        if idx and len(cells) > idx[1]:
            n = _int_or_none(cells[idx[0]])
            r = _float_or_none(cells[idx[1]])
            if n is not None and r is not None and 0 <= r <= 100:
                shares, ratio = n, r
        # 2) 폴백: (큰 정수, 0~100 소수) 첫 쌍 스캔 — 컬럼이 변형된 문서용
        if shares is None:
            i = 1
            while i < len(cells) - 1:
                n = _int_or_none(cells[i])
                r = _float_or_none(cells[i + 1])
                if n is not None and r is not None and 0 <= r <= 100 and n > 100:
                    shares, ratio = n, r
                    break
                i += 1
        if shares is None:
            continue
        rec = {"date": d, "shares": shares, "ratio": ratio}
        if label == "직전보고서":
            prev = rec
        else:
            curr = rec
    return prev, curr


# ------------------------------------------------------------ exec 본문 파싱
def parse_exec_section(html: str) -> dict:
    """임원ㆍ주요주주 보고서의 '특정증권등의 소유상황' 섹션."""
    soup = BeautifulSoup(html, "lxml")
    prev, curr = _parse_prev_curr_rows(soup, "exec")
    if not curr:  # 최초 보고는 prev가 없을 수 있다
        raise ValueError("이번보고서 행을 찾지 못함 (exec)")

    trades = []
    for tr in soup.find_all("tr"):
        cells = [_cell_text(td) for td in tr.find_all(["td", "th"])]
        if len(cells) < 5:
            continue
        reason = cells[0]
        # 세부변동내역 행: 첫 셀이 '장내매수(+)' 같은 사유, 둘째 셀이 날짜
        if _norm_label(reason) in ("합계", "총계") or "보고사유" in reason:
            continue
        tdate = _kdate(cells[1]) if len(cells) > 1 else None
        if not tdate:
            continue
        # (기초, 증감, 기말) 연속 삼중쌍을 찾아 자기검증: 기초+증감=기말
        nums = [(i, _int_or_none(c)) for i, c in enumerate(cells)]
        delta_idx = None
        for j in range(len(nums) - 2):
            i0, a = nums[j]
            i1, b = nums[j + 1]
            i2, c = nums[j + 2]
            if (
                a is not None and b is not None and c is not None
                and i1 == i0 + 1 and i2 == i1 + 1 and a + b == c
            ):
                delta_idx = i1
                break
        if delta_idx is None:
            continue
        price = None
        for c in cells[delta_idx + 2 :]:
            p = _float_or_none(c)
            if p is not None and p > 0:
                price = p
                break
        trades.append(
            {
                "reason": reason,
                "date": tdate,
                "delta_shares": nums[delta_idx][1],
                "price": price,
            }
        )

    return _assemble(prev, curr, trades)


# ------------------------------------------------------------ bulk 본문 파싱
def parse_bulk_section(html: str) -> dict:
    """대량보유 보고서의 '보유주식등의 수 및 보유비율' 섹션."""
    soup = BeautifulSoup(html, "lxml")
    prev, curr = _parse_prev_curr_rows(soup, "bulk")
    if not curr:
        raise ValueError("이번보고서 행을 찾지 못함 (bulk)")
    return _assemble(prev, curr, [])


def _assemble(prev: dict | None, curr: dict, trades: list) -> dict:
    """prev가 없으면(최초 보고) 증감은 미상(None)으로 둔다."""
    delta_shares = delta_ratio = None
    if prev:
        delta_shares = curr["shares"] - prev["shares"]
        if prev["ratio"] is not None and curr["ratio"] is not None:
            delta_ratio = round(curr["ratio"] - prev["ratio"], 2)
    return {
        "prev": prev,
        "curr": curr,
        "delta": {"shares": delta_shares, "ratio": delta_ratio},
        "trades": trades,
        "is_initial": prev is None,
    }


# ------------------------------------------------------------ 공시 1건 처리
SECTION_KEYWORD = {"exec": "특정증권등의 소유상황", "bulk": "보유주식등의 수 및 보유비율"}


def fetch_filing_detail(meta: dict, session=None) -> dict:
    """목록 메타(rcp_no/report_type 포함)에 본문 파싱 결과를 붙여 반환.

    파싱 불가 시 parse_ok=False 로 메타만 유지한다.
    """
    session = session or make_session()
    filing = dict(meta)
    filing.setdefault("prev", None)
    filing.setdefault("curr", None)
    filing.setdefault("delta", None)
    filing.setdefault("trades", [])
    filing["parse_ok"] = False

    keyword = SECTION_KEYWORD.get(meta.get("report_type"))
    if not keyword:
        return filing
    try:
        toc = fetch_toc(meta["rcp_no"], session)
        node = find_section(toc, keyword)
        if not node:
            return filing
        html = fetch_section(meta["rcp_no"], node, session)
        parsed = (
            parse_exec_section(html)
            if meta["report_type"] == "exec"
            else parse_bulk_section(html)
        )
        filing.update(parsed)
        filing["parse_ok"] = True
    except Exception:
        filing["parse_ok"] = False
    return filing
