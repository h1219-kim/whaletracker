"""data/*.json 저장소 계층.

- 로컬 JSON 캐시 읽기/쓰기 (ensure_ascii=False, 들여쓰기 저장)
- filings 증분 머지 (rcp_no 키 union, 새 것 우선)
- 매매 동향 집계 compute_trends (설계 문서 4절 /api/trends 계약)
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# 프로젝트 루트의 data/ 디렉터리 (설계 문서 3절)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# 관리 대상 데이터셋 이름
VALID_NAMES = ("holdings", "allocation", "major_stakes", "filings")

# 한국 표준시
KST = timezone(timedelta(hours=9))


def now_kst_iso() -> str:
    """한국 표준시 기준 ISO 8601 타임스탬프 문자열."""
    return datetime.now(KST).isoformat(timespec="seconds")


def _resolve_dir(data_dir) -> Path:
    return Path(data_dir) if data_dir is not None else DATA_DIR


def _path(name: str, data_dir=None) -> Path:
    if name not in VALID_NAMES:
        raise ValueError(
            f"알 수 없는 데이터셋 이름: {name!r} (가능한 값: {', '.join(VALID_NAMES)})"
        )
    return _resolve_dir(data_dir) / f"{name}.json"


def load_data(name: str, data_dir=None):
    """data/<name>.json 을 읽어 dict 로 반환. 파일이 없으면 None."""
    path = _path(name, data_dir)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_data(name: str, payload: dict, data_dir=None) -> Path:
    """data/<name>.json 에 저장. 저장한 경로를 반환."""
    path = _path(name, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def merge_filings(
    existing,
    new_filings,
    range_start: str | None = None,
    range_end: str | None = None,
    fetched_at: str | None = None,
) -> dict:
    """filings 증분 머지.

    - rcp_no 를 키로 union. 같은 rcp_no 는 새로 수집한 항목이 우선.
    - 조회 범위(range_start/range_end)는 기존 값과 합쳐 확장.
    - 결과 filings 는 접수일 내림차순(동일 접수일은 rcp_no 내림차순) 정렬.
    """
    merged: dict[str, dict] = {}
    if existing:
        for filing in existing.get("filings", []):
            rcp_no = filing.get("rcp_no")
            if rcp_no:
                merged[rcp_no] = filing
    for filing in new_filings or []:
        rcp_no = filing.get("rcp_no")
        if rcp_no:
            merged[rcp_no] = filing  # 새 것 우선

    filings = sorted(
        merged.values(),
        key=lambda f: (f.get("filed_date") or "", f.get("rcp_no") or ""),
        reverse=True,
    )

    old_start = (existing or {}).get("range_start")
    old_end = (existing or {}).get("range_end")
    starts = [s for s in (old_start, range_start) if s]
    ends = [e for e in (old_end, range_end) if e]

    return {
        "fetched_at": fetched_at or now_kst_iso(),
        "range_start": min(starts) if starts else None,
        "range_end": max(ends) if ends else None,
        "filings": filings,
    }


def compute_trends(days: int = 90, data_dir=None, today: date | None = None) -> dict:
    """최근 매매 동향 집계 (설계 문서 4절 /api/trends 응답 형태).

    집계 규칙:
    - 기간: 접수일(filed_date) >= 오늘 - days
    - 합산 제외: parse_ok=false, is_correction=true (recent_filings 에는 포함)
    - corp_code 별로 delta.ratio / delta.shares 합산(순변동)
    - delta_ratio 절대값 내림차순 상위 12개씩 top_buys / top_sells
    - recent_filings: 기간 내 최신순 최대 100건 (parse_ok=false 포함)
    """
    today = today or datetime.now(KST).date()
    since = today - timedelta(days=days)
    since_str = since.isoformat()

    data = load_data("filings", data_dir)
    filings = (data or {}).get("filings", [])

    in_range = [
        f for f in filings if (f.get("filed_date") or "") >= since_str
    ]

    # 회사별 순변동 집계
    agg: dict[str, dict] = {}
    for filing in in_range:
        if not filing.get("parse_ok"):
            continue
        if filing.get("is_correction"):
            continue
        delta = filing.get("delta") or {}
        key = filing.get("corp_code") or filing.get("company") or ""
        entry = agg.setdefault(
            key,
            {
                "company": filing.get("company"),
                "corp_code": filing.get("corp_code"),
                "delta_ratio": 0.0,
                "delta_shares": 0,
                "last_date": "",
                "filings": 0,
            },
        )
        entry["delta_ratio"] += delta.get("ratio") or 0.0
        entry["delta_shares"] += delta.get("shares") or 0
        entry["filings"] += 1
        filed = filing.get("filed_date") or ""
        if filed >= entry["last_date"]:
            entry["last_date"] = filed
            entry["company"] = filing.get("company")

    for entry in agg.values():
        entry["delta_ratio"] = round(entry["delta_ratio"], 2)

    buys = sorted(
        (e for e in agg.values() if e["delta_ratio"] > 0),
        key=lambda e: (-e["delta_ratio"], -abs(e["delta_shares"])),
    )[:12]
    sells = sorted(
        (e for e in agg.values() if e["delta_ratio"] < 0),
        key=lambda e: (e["delta_ratio"], -abs(e["delta_shares"])),
    )[:12]

    recent = sorted(
        in_range,
        key=lambda f: (f.get("filed_date") or "", f.get("rcp_no") or ""),
        reverse=True,
    )[:100]

    return {
        "days": days,
        "since": since_str,
        "top_buys": buys,
        "top_sells": sells,
        "recent_filings": recent,
    }
