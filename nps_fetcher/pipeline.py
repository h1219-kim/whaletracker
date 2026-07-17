"""전체 데이터 갱신 파이프라인.

순서: 자산배분 → 보유종목 → 대량보유 스냅샷 → DART 목록 → 신규 공시 본문 파싱 → 저장.
각 소스는 독립적으로 try/except — 하나가 실패해도 나머지는 저장하고,
실패한 소스는 기존 캐시 파일을 그대로 유지한다.
"""

import json
from datetime import date, timedelta

from . import dart, datago, krx_flow, naver_flow, npsfund, returns, sec13f, stock_flow, store
from .http_util import make_session


def _write_last_refresh(errors: dict, counts: dict) -> None:
    """마지막 수집 결과를 data/.cache/last_refresh.json에 남긴다.

    build_static과 웹앱이 '어느 소스가 언제 실패했는지'를 알아 신선도 경고를
    띄우는 근거로 쓴다. (.cache는 gitignore — 같은 실행 내에서만 참조)
    """
    cache = store.DATA_DIR / ".cache"
    cache.mkdir(parents=True, exist_ok=True)
    meta = {
        "refreshed_at": store.now_kst_iso(),
        "ok": not errors,
        "errors": errors,
        "counts": counts,
    }
    (cache / "last_refresh.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def run_refresh(days: int = 180, max_new: int = 300, progress=None) -> dict:
    """모든 소스를 갱신한다.

    progress(step_label, done, total) 콜백으로 진행 상황을 알린다.
    반환: {"ok": bool, "errors": {소스: 메시지}, "counts": {...}}
    """

    def report(step, done=0, total=0):
        if progress:
            progress(step, done, total)

    session = make_session()
    errors: dict[str, str] = {}
    counts: dict[str, int] = {}

    TOTAL = 9

    # 1) 자산배분 (기금운용본부)
    report("자산배분 수집", 0, TOTAL)
    try:
        allocation = npsfund.fetch_allocation(session)
        store.save_data("allocation", allocation)
        counts["allocation_assets"] = len(allocation["assets"])
    except Exception as e:
        errors["allocation"] = str(e)

    # 2) 국내주식 보유종목 (공공데이터포털)
    report("보유종목 수집", 1, TOTAL)
    try:
        holdings = datago.fetch_holdings(session)
        store.save_data("holdings", holdings)
        counts["holdings_stocks"] = len(holdings["stocks"])
    except Exception as e:
        errors["holdings"] = str(e)

    # 3) 대량보유 스냅샷 (공공데이터포털)
    report("대량보유 스냅샷 수집", 2, TOTAL)
    try:
        stakes = datago.fetch_major_stakes(session)
        store.save_data("major_stakes", stakes)
        counts["major_stakes"] = len(stakes["stakes"])
    except Exception as e:
        errors["major_stakes"] = str(e)

    # 4) 연기금 일별 순매수 (네이버 금융 — 간접 지표)
    report("연기금 매매동향 수집", 3, TOTAL)
    try:
        flow = naver_flow.fetch_pension_flow(session)
        store.save_data("pension_flow", flow)
        counts["pension_flow_days"] = len(flow["markets"]["kospi"])
    except Exception as e:
        errors["pension_flow"] = str(e)

    # 5) 연기금 종목별 순매수 (KRX — 간접 지표)
    report("연기금 종목별 수급 수집", 4, TOTAL)
    try:
        psf = krx_flow.fetch_pension_stock_flow(session)
        store.save_data("pension_stock_flow", psf)
        counts["pension_stock_windows"] = len(psf["windows"])
    except Exception as e:
        errors["pension_stock_flow"] = str(e)

    # 5.5) 연기금 따라 투자 수익률 (주가 수집이 무거우므로 독립 처리)
    report("따라투자 수익률 계산", 5, TOTAL)
    try:
        ret = returns.compute_returns(
            session, progress=lambda m: report(f"따라투자 수익률: {m}", 5, TOTAL)
        )
        store.save_data("returns", ret)
        counts["returns_windows"] = sum(
            len(m["windows"]) for m in ret["markets"].values()
        )
    except Exception as e:
        errors["returns"] = str(e)

    # 5.7) 종목 수급 현미경 (본주 투자자별 + 레버리지 경유 개인 수요)
    report("종목 수급 현미경 수집", 6, TOTAL)
    try:
        sf = stock_flow.compute_stock_flow(session)
        store.save_data("stock_flow", sf)
        counts["stock_flow_stocks"] = len(sf["stocks"])
    except Exception as e:
        errors["stock_flow"] = str(e)

    # 6) 미국 주식 보유 (SEC 13F)
    report("미국 주식 13F 수집", 7, TOTAL)
    try:
        us = sec13f.fetch_us_holdings()
        store.save_data("us_holdings", us)
        counts["us_holdings"] = us["count"]
    except Exception as e:
        errors["us_holdings"] = str(e)

    # 7) DART 공시 — 목록 후 신규 건만 본문 파싱 (증분)
    report("DART 공시 목록 조회", 8, TOTAL)
    try:
        end = date.today()
        start = end - timedelta(days=days)
        listed = dart.search_filings(start, end, session)
        counts["dart_listed"] = len(listed)

        existing = store.load_data("filings")
        # 파싱에 실패했던 exec/bulk 공시는 다음 갱신 때 재시도한다
        known = {
            f["rcp_no"]
            for f in (existing or {}).get("filings", [])
            if f.get("parse_ok") or f.get("report_type") == "other"
        }
        new_metas = [m for m in listed if m["rcp_no"] not in known][:max_new]
        counts["dart_new"] = len(new_metas)

        detailed = []
        total = len(new_metas)
        for i, meta in enumerate(new_metas, 1):
            report(f"DART 공시 본문 파싱 ({meta['company']})", i, total)
            detailed.append(dart.fetch_filing_detail(meta, session))
        report("저장", 8, TOTAL)

        merged = store.merge_filings(
            existing,
            detailed,
            range_start=start.isoformat(),
            range_end=end.isoformat(),
        )
        store.save_data("filings", merged)
        counts["filings_total"] = len(merged["filings"])
    except Exception as e:
        errors["dart"] = str(e)

    report("완료", TOTAL, TOTAL)
    _write_last_refresh(errors, counts)
    return {"ok": not errors, "errors": errors, "counts": counts}
