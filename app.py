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


@app.route("/api/pension-flow")
def api_pension_flow():
    """연기금 일별 순매수(pension_flow.json) 패스스루 — 간접 지표."""
    data = _read_json("pension_flow.json")
    return jsonify(data if data is not None else {"empty": True})


@app.route("/api/pension-stock-flow")
def api_pension_stock_flow():
    """연기금 종목별 순매수/매도(pension_stock_flow.json) 패스스루 — 간접 지표."""
    data = _read_json("pension_stock_flow.json")
    return jsonify(data if data is not None else {"empty": True})


@app.route("/api/returns")
def api_returns():
    """연기금 따라 투자 수익률(returns.json) 패스스루."""
    data = _read_json("returns.json")
    return jsonify(data if data is not None else {"empty": True})


@app.route("/api/stock-flow")
def api_stock_flow():
    """종목 수급 현미경(stock_flow.json) 패스스루 — 본주×레버리지."""
    data = _read_json("stock_flow.json")
    return jsonify(data if data is not None else {"empty": True})


# 신선도 판정용 데이터셋 파일 매핑 (정적 빌드의 DATASET_FILES와 동일)
_DATASET_FILES = {
    "allocation": "allocation.json",
    "holdings": "holdings.json",
    "major_stakes": "major_stakes.json",
    "pension_flow": "pension_flow.json",
    "pension_stock_flow": "pension_stock_flow.json",
    "us_holdings": "us_holdings.json",
    "filings": "filings.json",
    "returns": "returns.json",
    "stock_flow": "stock_flow.json",
}


@app.route("/api/build-meta")
def api_build_meta():
    """각 소스의 수집 시각과 마지막 수집 실패 내역 — 신선도 경고의 근거.

    로컬 서버는 built_at이 없다(항상 실시간). 프론트는 built_at이 없으면
    클라이언트 현재 시각을 기준으로 신선도를 계산한다.
    """
    sources = {}
    for name, fname in _DATASET_FILES.items():
        d = _read_json(fname)
        sources[name] = (d or {}).get("fetched_at")
    last_refresh = _read_json(".cache/last_refresh.json") or {}
    return jsonify({
        "built_at": None,
        "sources": sources,
        "errors": last_refresh.get("errors", {}),
        "refreshed_at": last_refresh.get("refreshed_at"),
    })


@app.route("/api/us-holdings")
def api_us_holdings():
    """미국 주식 13F 보유(us_holdings.json) 패스스루."""
    data = _read_json("us_holdings.json")
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


def _start_refresh():
    """갱신 스레드를 시작한다. 반환: "started" | "running" | "no_fetcher"."""
    global _refresh_thread
    with _refresh_lock:
        if _refresh_state["running"]:
            return "running"
        try:
            _get_fetcher()
        except ImportError:
            return "no_fetcher"
        _refresh_state.update(running=True, step="준비 중", done=0, total=0, error=None)
        _refresh_thread = threading.Thread(
            target=_run_refresh_job, name="whaletracker-refresh", daemon=True
        )
        _refresh_thread.start()
    return "started"


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """데이터 갱신 시작. 이미 실행 중이면 409."""
    result = _start_refresh()
    if result == "running":
        return jsonify({"started": False, "error": "이미 갱신이 실행 중입니다"}), 409
    if result == "no_fetcher":
        return jsonify(
            {"started": False,
             "error": "nps_fetcher 패키지를 찾을 수 없습니다 (수집 모듈 미설치)"}
        ), 503
    return jsonify({"started": True})


@app.route("/api/refresh/status")
def api_refresh_status():
    """갱신 진행 상태. done/total과 설계 문서 표기(done_steps/total_steps)를 함께 제공."""
    state = dict(_refresh_state)
    state["done_steps"] = state["done"]
    state["total_steps"] = state["total"]
    return jsonify(state)


# ---------------------------------------------------------------------------
# 자동 갱신 — 서버가 떠 있는 동안 데이터가 오래되면 알아서 수집한다
# ---------------------------------------------------------------------------

AUTO_CHECK_SECONDS = 15 * 60  # 신선도 점검 주기


def _data_is_stale(max_age_hours, now=None):
    """filings.json의 fetched_at이 max_age_hours보다 오래됐으면 True.

    파일이 없거나 타임스탬프를 읽을 수 없어도 True (수집이 필요한 상태).
    """
    data = _read_json("filings.json")
    fetched_at = (data or {}).get("fetched_at")
    if not fetched_at:
        return True
    try:
        fetched = datetime.fromisoformat(fetched_at)
    except ValueError:
        return True
    now = now or datetime.now().astimezone()
    if fetched.tzinfo is None:
        fetched = fetched.astimezone()
    return (now - fetched).total_seconds() > max_age_hours * 3600


def _auto_refresh_loop(max_age_hours):
    """백그라운드 데몬 — 주기적으로 신선도를 점검해 오래되면 갱신을 시작한다."""
    import time

    while True:
        try:
            if _data_is_stale(max_age_hours):
                _start_refresh()  # 이미 실행 중이면 아무 일도 하지 않는다
        except Exception:
            pass  # 자동 갱신 실패가 서버를 죽여서는 안 된다
        time.sleep(AUTO_CHECK_SECONDS)


def start_auto_refresh(max_age_hours):
    thread = threading.Thread(
        target=_auto_refresh_loop, args=(max_age_hours,),
        name="whaletracker-auto-refresh", daemon=True,
    )
    thread.start()
    return thread


# ---------------------------------------------------------------------------
# 실행 진입점
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WhaleTracker 대시보드 서버")
    parser.add_argument("--port", type=int, default=5000, help="포트 (기본 5000)")
    parser.add_argument("--debug", action="store_true", help="Flask 디버그 모드")
    parser.add_argument(
        "--auto-refresh", type=float, default=24, metavar="HOURS",
        help="데이터가 이 시간(시)보다 오래되면 자동 수집 (기본 24, 0=끄기)",
    )
    parser.add_argument(
        "--open", action="store_true",
        help="서버 시작 후 기본 브라우저로 대시보드를 자동으로 연다",
    )
    args = parser.parse_args()
    if args.auto_refresh > 0:
        start_auto_refresh(args.auto_refresh)
    if args.open and not args.debug:
        # 서버가 뜬 직후 브라우저를 연다 (디버그 모드의 리로더 중복 실행은 회피)
        import webbrowser

        url = f"http://127.0.0.1:{args.port}/"
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    # threaded: 갱신 폴링과 데이터 요청이 동시에 와도 직렬화되지 않도록
    app.run(host="127.0.0.1", port=args.port, debug=args.debug, threaded=True)
