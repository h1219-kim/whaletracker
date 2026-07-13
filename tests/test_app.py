# -*- coding: utf-8 -*-
"""Flask 앱 라우트 테스트 — 네트워크·nps_fetcher 실물 없이 동작한다.

- 패스스루 3종: JSON 형태, 파일 없을 때 empty 상태
- trends: _get_fetcher 심 monkeypatch로 가짜 집계 결과 주입, days 검증
- refresh: 이중 실행 409, 진행 상태 갱신
- GET /: 200 + HTML
"""

import json
import sys
import threading
import types
from pathlib import Path

import pytest

# 프로젝트 루트를 임포트 경로에 추가 (tests/ 하위에서 실행되므로)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402


@pytest.fixture
def client():
    """Flask 테스트 클라이언트 + 갱신 상태 초기화."""
    app_module.app.config["TESTING"] = True
    _reset_refresh_state()
    with app_module.app.test_client() as c:
        yield c
    _reset_refresh_state()


def _reset_refresh_state():
    app_module._refresh_state.update(
        running=False, step=None, done=0, total=0, error=None, last_finished=None
    )
    app_module._refresh_thread = None


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """DATA_DIR을 임시 폴더로 바꿔 테스트를 격리한다."""
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    return tmp_path


def _write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# GET /
# ---------------------------------------------------------------------------

def test_index_returns_html(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.content_type
    html = res.get_data(as_text=True)
    assert "국민연금" in html


# ---------------------------------------------------------------------------
# 패스스루 3종
# ---------------------------------------------------------------------------

def test_holdings_passthrough(client, data_dir):
    sample = {
        "as_of": "2024-12-31",
        "total_value_100m": 424475.0,
        "stocks": [
            {"rank": 1, "name": "삼성전자", "value_100m": 230421.0,
             "weight_pct": 16.7, "ownership_pct": 7.26}
        ],
    }
    _write_json(data_dir / "holdings.json", sample)
    res = client.get("/api/holdings")
    assert res.status_code == 200
    assert res.get_json() == sample


def test_allocation_passthrough(client, data_dir):
    sample = {
        "as_of": "2026-04",
        "total_trillion": 1670.7,
        "assets": [{"name": "해외주식", "value_trillion": 604.5, "weight_pct": 36.2}],
    }
    _write_json(data_dir / "allocation.json", sample)
    res = client.get("/api/allocation")
    assert res.status_code == 200
    assert res.get_json() == sample


def test_major_stakes_passthrough(client, data_dir):
    sample = {
        "as_of": "2026-03-31",
        "stakes": [{"name": "(주)KB금융지주", "report_date": "2026-01-29",
                    "ownership_pct": 8.94}],
    }
    _write_json(data_dir / "major_stakes.json", sample)
    res = client.get("/api/major-stakes")
    assert res.status_code == 200
    assert res.get_json() == sample


@pytest.mark.parametrize("route", ["/api/holdings", "/api/allocation", "/api/major-stakes"])
def test_passthrough_empty_when_file_missing(client, data_dir, route):
    res = client.get(route)
    assert res.status_code == 200
    assert res.get_json() == {"empty": True}


# ---------------------------------------------------------------------------
# build-meta (신선도 판정 근거)
# ---------------------------------------------------------------------------

def test_build_meta_collects_fetched_at_and_errors(client, data_dir):
    _write_json(data_dir / "pension_flow.json",
                {"fetched_at": "2026-07-14T03:00:00+09:00", "markets": {}})
    _write_json(data_dir / "us_holdings.json",
                {"fetched_at": "2026-04-01T00:00:00+09:00", "holdings": []})
    cache = data_dir / ".cache"
    cache.mkdir()
    _write_json(cache / "last_refresh.json",
                {"refreshed_at": "2026-07-14T03:00:00+09:00",
                 "errors": {"pension_stock_flow": "KRX 접근 실패"}})

    res = client.get("/api/build-meta")
    assert res.status_code == 200
    body = res.get_json()
    assert body["built_at"] is None  # 로컬 서버는 항상 실시간 → built_at 없음
    assert body["sources"]["pension_flow"] == "2026-07-14T03:00:00+09:00"
    assert body["sources"]["us_holdings"] == "2026-04-01T00:00:00+09:00"
    assert body["sources"]["holdings"] is None  # 파일 없으면 None
    assert body["errors"] == {"pension_stock_flow": "KRX 접근 실패"}
    assert body["refreshed_at"] == "2026-07-14T03:00:00+09:00"


def test_build_meta_without_last_refresh(client, data_dir):
    res = client.get("/api/build-meta")
    assert res.status_code == 200
    body = res.get_json()
    assert body["errors"] == {}
    assert body["refreshed_at"] is None


# ---------------------------------------------------------------------------
# trends — 심 monkeypatch
# ---------------------------------------------------------------------------

def _fake_fetcher_with_trends(calls):
    def compute_trends(days):
        calls.append(days)
        return {"days": days, "top_buys": [], "top_sells": [], "recent_filings": []}
    return types.SimpleNamespace(compute_trends=compute_trends)


def test_trends_uses_seam_and_days_param(client, data_dir, monkeypatch):
    _write_json(data_dir / "filings.json", {"filings": []})
    calls = []
    monkeypatch.setattr(app_module, "_get_fetcher",
                        lambda: _fake_fetcher_with_trends(calls))
    res = client.get("/api/trends?days=30")
    assert res.status_code == 200
    body = res.get_json()
    assert body["days"] == 30
    assert body["top_buys"] == []
    assert calls == [30]


@pytest.mark.parametrize("query", ["?days=45", "?days=abc", "?days=", ""])
def test_trends_invalid_days_falls_back_to_90(client, data_dir, monkeypatch, query):
    _write_json(data_dir / "filings.json", {"filings": []})
    calls = []
    monkeypatch.setattr(app_module, "_get_fetcher",
                        lambda: _fake_fetcher_with_trends(calls))
    res = client.get("/api/trends" + query)
    assert res.status_code == 200
    assert calls == [90]


def test_trends_503_when_fetcher_missing(client, data_dir, monkeypatch):
    _write_json(data_dir / "filings.json", {"filings": []})

    def raise_import_error():
        raise ImportError("nps_fetcher 없음")

    monkeypatch.setattr(app_module, "_get_fetcher", raise_import_error)
    res = client.get("/api/trends")
    assert res.status_code == 503
    assert "error" in res.get_json()


def test_trends_empty_when_no_filings(client, data_dir, monkeypatch):
    """filings.json이 없으면 nps_fetcher를 부르지 않고 empty를 반환한다."""
    def must_not_be_called():
        raise AssertionError("filings.json 없을 때 심이 호출되면 안 됨")

    monkeypatch.setattr(app_module, "_get_fetcher", must_not_be_called)
    res = client.get("/api/trends?days=180")
    assert res.status_code == 200
    assert res.get_json() == {"empty": True, "days": 180}


# ---------------------------------------------------------------------------
# refresh — 이중 실행 409 + 상태 갱신
# ---------------------------------------------------------------------------

def test_refresh_double_start_returns_409(client, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def refresh_all(progress=None):
        started.set()
        release.wait(timeout=10)

    fake = types.SimpleNamespace(refresh_all=refresh_all)
    monkeypatch.setattr(app_module, "_get_fetcher", lambda: fake)

    try:
        res1 = client.post("/api/refresh")
        assert res1.status_code == 200
        assert res1.get_json() == {"started": True}
        assert started.wait(timeout=5), "갱신 스레드가 시작되지 않음"

        # 실행 중 재요청 → 409
        res2 = client.post("/api/refresh")
        assert res2.status_code == 409
        assert res2.get_json()["started"] is False

        status = client.get("/api/refresh/status").get_json()
        assert status["running"] is True
    finally:
        release.set()
        thread = app_module._refresh_thread
        if thread is not None:
            thread.join(timeout=5)

    status = client.get("/api/refresh/status").get_json()
    assert status["running"] is False
    assert status["error"] is None
    assert status["last_finished"] is not None


def test_refresh_progress_callback_updates_status(client, monkeypatch):
    def refresh_all(progress=None):
        if progress is not None:
            progress("공시 수집", 2, 5)

    fake = types.SimpleNamespace(refresh_all=refresh_all)
    monkeypatch.setattr(app_module, "_get_fetcher", lambda: fake)

    res = client.post("/api/refresh")
    assert res.status_code == 200
    thread = app_module._refresh_thread
    assert thread is not None
    thread.join(timeout=5)

    status = client.get("/api/refresh/status").get_json()
    assert status["running"] is False
    assert status["step"] == "공시 수집"
    assert status["done"] == 2
    assert status["total"] == 5
    # 설계 문서 표기도 함께 제공
    assert status["done_steps"] == 2
    assert status["total_steps"] == 5


def test_refresh_503_when_fetcher_missing(client, monkeypatch):
    def raise_import_error():
        raise ImportError("nps_fetcher 없음")

    monkeypatch.setattr(app_module, "_get_fetcher", raise_import_error)
    res = client.post("/api/refresh")
    assert res.status_code == 503
    status = client.get("/api/refresh/status").get_json()
    assert status["running"] is False


def test_data_is_stale_logic(data_dir):
    """자동 갱신의 신선도 판정 — 파일 없음/오래됨/신선함."""
    from datetime import datetime, timedelta, timezone

    kst = timezone(timedelta(hours=9))
    now = datetime(2026, 7, 12, 12, 0, 0, tzinfo=kst)

    # 파일이 없으면 수집 필요
    assert app_module._data_is_stale(24, now=now) is True

    # 25시간 전 수집 → 오래됨
    old = (now - timedelta(hours=25)).isoformat(timespec="seconds")
    _write_json(data_dir / "filings.json", {"fetched_at": old, "filings": []})
    assert app_module._data_is_stale(24, now=now) is True

    # 1시간 전 수집 → 신선함
    fresh = (now - timedelta(hours=1)).isoformat(timespec="seconds")
    _write_json(data_dir / "filings.json", {"fetched_at": fresh, "filings": []})
    assert app_module._data_is_stale(24, now=now) is False

    # 타임스탬프가 깨져 있으면 수집 필요
    _write_json(data_dir / "filings.json", {"fetched_at": "not-a-date", "filings": []})
    assert app_module._data_is_stale(24, now=now) is True


def test_refresh_error_is_reported_in_status(client, monkeypatch):
    def refresh_all(progress=None):
        raise RuntimeError("수집 실패 테스트")

    fake = types.SimpleNamespace(refresh_all=refresh_all)
    monkeypatch.setattr(app_module, "_get_fetcher", lambda: fake)

    res = client.post("/api/refresh")
    assert res.status_code == 200
    thread = app_module._refresh_thread
    assert thread is not None
    thread.join(timeout=5)

    status = client.get("/api/refresh/status").get_json()
    assert status["running"] is False
    assert "수집 실패 테스트" in status["error"]
