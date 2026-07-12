# -*- coding: utf-8 -*-
"""WhaleTracker — 국민연금 투자 동향 대시보드 Flask 서버.

- 패스스루 API(holdings/allocation/major-stakes): data/*.json을 그대로 반환.
  파일이 없으면 {"empty": true}.
- trends/refresh 라우트만 nps_fetcher 패키지가 필요하며, 병렬 빌드 중
  패키지가 아직 없을 수 있으므로 모듈 상단이 아닌 함수 내부에서
  지연 임포트한다(_get_fetcher 심). ImportError 시 503 JSON.

실행: python app.py [--port 5000] [--debug]
"""

import argparse
import importlib
import inspect
import json
import threading
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
app.json.ensure_ascii = False  # 한국어 JSON을 그대로 반환

# data 디렉터리는 app.py 위치 기준 ./data (테스트에서 monkeypatch 가능)
DATA_DIR = Path(__file__).resolve().parent / "data"

ALLOWED_TREND_DAYS = (30, 90, 180)
DEFAULT_TREND_DAYS = 90


# ---------------------------------------------------------------------------
# 공용 헬퍼
# ---------------------------------------------------------------------------

def _read_json(filename):
    """data/*.json 파일을 읽어 파이썬 객체로 반환. 없거나 손상 시 None."""
    path = DATA_DIR / filename
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as fp:
            return json.load(fp)
    except (OSError, ValueError):
        return None


def _get_fetcher():
    """nps_fetcher 패키지 지연 임포트 심(seam).

    병렬 빌드 중이라 패키지가 아직 없을 수 있으므로 호출 시점에
    임포트한다. 테스트에서는 이 함수를 monkeypatch 하여 가짜 모듈을
    주입한다.
    """
    import nps_fetcher
    return nps_fetcher


def _resolve_callable(module, names):
    """모듈에서 후보 이름 순서대로 호출 가능한 속성을 찾는다."""
    for name in names:
        fn = getattr(module, name, None)
        if callable(fn):
            return fn
    return None


# ---------------------------------------------------------------------------
# 패스스루 라우트
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """대시보드 단일 페이지."""
    return render_template("index.html")


@app.route("/api/holdings")
def api_holdings():
    """국내주식 종목별 투자현황(holdings.json) 패스스루."""
    data = _read_json("holdings.json")
    return jsonify(data if data is not None else {"empty": True})


@app.route("/api/allocation")
def api_allocation():
    """기금 전체 자산배분(allocation.json) 패스스루."""
    data = _read_json("allocation.json")
    return jsonify(data if data is not None else {"empty": True})


@app.route("/api/major-stakes")
def api_major_stakes():
    """대량보유(5%+) 보고내역(major_stakes.json) 패스스루."""
    data = _read_json("major_stakes.json")
    return jsonify(data if data is not None else {"empty": True})


# ---------------------------------------------------------------------------
# trends — nps_fetcher.store 집계 사용 (지연 임포트)
# ---------------------------------------------------------------------------

_TRENDS_FN_NAMES = ("compute_trends", "get_trends", "trends", "aggregate_trends")


def _call_trends(fetcher, days):
    """nps_fetcher(또는 하위 store 모듈)의 trends 집계 함수를 찾아 호출한다."""
    modules = [fetcher]
    store = getattr(fetcher, "store", None)
    if store is None and getattr(fetcher, "__name__", None):
        try:
            store = importlib.import_module(fetcher.__name__ + ".store")
        except ImportError:
            store = None
    if store is not None:
        modules.append(store)
    for module in modules:
        fn = _resolve_callable(module, _TRENDS_FN_NAMES)
        if fn is not None:
            return fn(days)
    raise AttributeError("nps_fetcher에서 trends 집계 함수를 찾지 못했습니다")


@app.route("/api/trends")
def api_trends():
    """최근 매매 동향 집계. days ∈ 30/90/180 (그 외 값은 기본 90)."""
    raw = request.args.get("days", DEFAULT_TREND_DAYS)
    try:
        days = int(raw)
    except (TypeError, ValueError):
        days = DEFAULT_TREND_DAYS
    if days not in ALLOWED_TREND_DAYS:
        days = DEFAULT_TREND_DAYS

    # 수집된 공시 데이터가 아예 없으면 수집 모듈 없이도 빈 상태를 알린다
    if not (DATA_DIR / "filings.json").exists():
        return jsonify({"empty": True, "days": days})

    try:
        fetcher = _get_fetcher()
    except ImportError:
        return jsonify({"error": "nps_fetcher 패키지를 찾을 수 없습니다 (수집 모듈 미설치)"}), 503
    try:
        result = _call_trends(fetcher, days)
    except AttributeError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify(result)


# ---------------------------------------------------------------------------
# refresh — 백그라운드 수집 (스레드 1개만 허용)
# ---------------------------------------------------------------------------

_refresh_lock = threading.Lock()
_refresh_thread = None
_refresh_state = {
    "running": False,
    "step": None,
    "done": 0,
    "total": 0,
    "error": None,
    "last_finished": None,
}

_REFRESH_FN_NAMES = (
    "refresh_all", "run_refresh", "refresh", "run_all", "fetch_all", "run", "main",
)


def _resolve_refresh_fn(fetcher):
    """nps_fetcher의 전체 갱신 진입점을 찾는다."""
    fn = _resolve_callable(fetcher, _REFRESH_FN_NAMES)
    if fn is None:
        raise AttributeError("nps_fetcher에서 갱신 실행 함수를 찾지 못했습니다")
    return fn


def _accepts_kwarg(fn, name):
    """함수가 해당 키워드 인자(또는 **kwargs)를 받는지 검사."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    if name in sig.parameters:
        return True
    return any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())


def _progress(step, done=0, total=0):
    """수집 스레드가 진행 상황을 알리는 콜백 — 상태 dict를 갱신한다."""
    _refresh_state["step"] = step
    _refresh_state["done"] = done
    _refresh_state["total"] = total


def _run_refresh_job():
    """백그라운드 스레드 본체 — 수집 실행 후 상태를 마무리한다."""
    try:
        fetcher = _get_fetcher()
        fn = _resolve_refresh_fn(fetcher)
        if _accepts_kwarg(fn, "progress"):
            fn(progress=_progress)
        else:
            fn()
        _refresh_state["error"] = None
    except Exception as exc:  # 수집 실패는 상태로 보고하고 서버는 유지한다
        _refresh_state["error"] = str(exc)
    finally:
        _refresh_state["running"] = False
        _refresh_state["last_finished"] = (
            datetime.now().astimezone().isoformat(timespec="seconds")
        )


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """데이터 갱신 시작. 이미 실행 중이면 409."""
    global _refresh_thread
    with _refresh_lock:
        if _refresh_state["running"]:
            return jsonify({"started": False, "error": "이미 갱신이 실행 중입니다"}), 409
        try:
            _get_fetcher()
        except ImportError:
            return jsonify(
                {"started": False,
                 "error": "nps_fetcher 패키지를 찾을 수 없습니다 (수집 모듈 미설치)"}
            ), 503
        _refresh_state.update(running=True, step="준비 중", done=0, total=0, error=None)
        _refresh_thread = threading.Thread(
            target=_run_refresh_job, name="whaletracker-refresh", daemon=True
        )
        _refresh_thread.start()
    return jsonify({"started": True})


@app.route("/api/refresh/status")
def api_refresh_status():
    """갱신 진행 상태. done/total과 설계 문서 표기(done_steps/total_steps)를 함께 제공."""
    state = dict(_refresh_state)
    state["done_steps"] = state["done"]
    state["total_steps"] = state["total"]
    return jsonify(state)


# ---------------------------------------------------------------------------
# 실행 진입점
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WhaleTracker 대시보드 서버")
    parser.add_argument("--port", type=int, default=5000, help="포트 (기본 5000)")
    parser.add_argument("--debug", action="store_true", help="Flask 디버그 모드")
    args = parser.parse_args()
    # threaded: 갱신 폴링과 데이터 요청이 동시에 와도 직렬화되지 않도록
    app.run(host="127.0.0.1", port=args.port, debug=args.debug, threaded=True)
