"""data/*.json 저장소 계층.

- 로컬 JSON 캐시 읽기/쓰기 (ensure_ascii=False, 들여쓰기 저장)
- filings 증분 머지 (rcp_no 키 union, 새 것 우선)
- 매매 동향 집계 compute_trends (설계 문서 4절 /api/trends 계약)
"""
from __future__ import annotations

import json
import os
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
    """data/<name>.json 에 저장. 저장한 경로를 반환.

    임시 파일에 쓴 뒤 os.replace 로 원자 교체 — 갱신 도중
    웹앱이 쓰다 만 파일을 읽는 일을 막는다.
    """
    path = _path(name, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
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

    # 회사별 × 보고유형별 순변동을 따로 모은다.
    # 같은 매매가 대량보유(bulk)와 주요주주(exec) 공시로 이중 보고되는 일이
    # 흔하므로(10%+ 보유 종목), 유형을 합산하면 변동이 과대 계상된다.
    # → 유형별 체인 합계를 구한 뒤 절대값이 큰 쪽(더 넓게 포착한 쪽)만 채택.
    by_key_type: dict[tuple, dict] = {}
    for filing in in_range:
        if not filing.get("parse_ok"):
            continue
        if filing.get("is_correction"):
            continue
        delta = filing.get("delta") or {}
        if delta.get("ratio") is None:
            continue  # 최초 보고 등 — 증감 미상은 합산 불가
        key = filing.get("corp_code") or filing.get("company") or ""
        rtype = filing.get("report_type") or "?"
        entry = by_key_type.setdefault(
            (key, rtype),
            {
                "company": filing.get("company"),
                "corp_code": filing.get("corp_code"),
                "delta_ratio": 0.0,
                "delta_shares": 0,
                "last_date": "",
                "filings": 0,
                "basis": rtype,
            },
        )
        entry["delta_ratio"] += delta.get("ratio") or 0.0
        entry["delta_shares"] += delta.get("shares") or 0
        entry["filings"] += 1
        filed = filing.get("filed_date") or ""
        if filed >= entry["last_date"]:
            entry["last_date"] = filed
            entry["company"] = filing.get("company")

    # 회사별로 대표 유형 채택 (|순변동| 큰 쪽, 동률이면 bulk 우선)
    agg: dict[str, dict] = {}
    for (key, rtype), entry in by_key_type.items():
        entry["delta_ratio"] = round(entry["delta_ratio"], 2)
        cur = agg.get(key)
        if cur is None:
            agg[key] = entry
            continue
        better = abs(entry["delta_ratio"]) > abs(cur["delta_ratio"]) or (
            abs(entry["delta_ratio"]) == abs(cur["delta_ratio"]) and rtype == "bulk"
        )
        picked = entry if better else cur
        other = cur if better else entry
        # 공시 수·최근 접수일은 두 유형을 합쳐 보여준다 (변동값은 대표 유형만)
        picked = dict(picked)
        picked["filings"] += other["filings"]
        if other["last_date"] > picked["last_date"]:
            picked["last_date"] = other["last_date"]
            picked["company"] = other["company"]
        agg[key] = picked

    all_buys = sorted(
        (e for e in agg.values() if e["delta_ratio"] > 0),
        key=lambda e: (-e["delta_ratio"], -abs(e["delta_shares"])),
    )
    all_sells = sorted(
        (e for e in agg.values() if e["delta_ratio"] < 0),
        key=lambda e: (e["delta_ratio"], -abs(e["delta_shares"])),
    )
    buys, sells = all_buys[:12], all_sells[:12]

    recent = sorted(
        in_range,
        key=lambda f: (f.get("filed_date") or "", f.get("rcp_no") or ""),
        reverse=True,
    )[:100]

    return {
        "days": days,
        "since": since_str,
        "buy_count": len(all_buys),
        "sell_count": len(all_sells),
        "top_buys": buys,
        "top_sells": sells,
        "recent_filings": recent,
    }
