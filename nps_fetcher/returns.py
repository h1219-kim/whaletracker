"""연기금 따라 투자 수익률 — 스냅샷/연속(TWR) + 벤치마크.

설계: docs/superpowers/specs/2026-07-14-pension-copy-returns-design.md

핵심 규칙
- 대상: 기간 시작일(T0) **직전 1개월**의 순매수 상위 5개 (T0 이전 정보만 → look-ahead 제거)
- **롱온리**: 보유 없는 종목의 순매도는 무시, 보유 한도 내에서만 매도 (공매도 없음)
- 스냅샷: T0에 사서 그대로 보유(buy-and-hold)
- 연속: 매일 순매수/매도를 따라가되 **시간가중수익률(TWR)** 로 자본유입 효과 제거
"""

from datetime import date, timedelta

from . import krx_flow, prices, store

TOP_N = 5
WINDOWS = [("1m", "1개월", 30), ("3m", "3개월", 91), ("6m", "6개월", 182)]
BASKET_LOOKBACK_DAYS = 30  # T0 직전 1개월로 바스켓 선정
INDEX_SYMBOL = {"kospi": prices.KOSPI, "kosdaq": prices.KOSDAQ}


# ---------------------------------------------------------------- 대상 선정
def select_basket(rows: list[dict], top_n: int = TOP_N) -> list[dict]:
    """순매수 상위 top_n 종목 + 비중(그 안에서 정규화). 순매도 종목은 제외."""
    buys = sorted(
        (r for r in rows if r.get("net_value", 0) > 0),
        key=lambda r: -r["net_value"],
    )[:top_n]
    total = sum(r["net_value"] for r in buys)
    if not buys or total <= 0:
        return []
    return [
        {
            "code": r["code"],
            "name": r["name"],
            "weight": r["net_value"] / total,
            "buy_value": r["net_value"],
        }
        for r in buys
    ]


# ---------------------------------------------------------------- 스냅샷
def snapshot_curve(basket: list[dict], closes: dict, dates: list[str]) -> list[float]:
    """T0 종가로 비중대로 매수 후 보유. 누적수익률(%) 곡선."""
    if not basket or not dates:
        return []
    t0 = dates[0]
    # 보유주수 s_i = w_i / P_i(T0) (초기 투자금 1로 정규화)
    shares = {}
    for b in basket:
        p0 = prices.last_close_on_or_before(closes.get(b["code"], {}), t0)
        shares[b["code"]] = (b["weight"] / p0) if p0 else 0.0

    curve = []
    for t in dates:
        v = 0.0
        for b in basket:
            p = prices.last_close_on_or_before(closes.get(b["code"], {}), t)
            if p:
                v += shares[b["code"]] * p
        curve.append((v - 1.0) * 100.0)
    return curve


# ---------------------------------------------------------------- 연속 (롱온리)
def simulate_positions(basket, flows: dict, closes: dict, dates: list[str]) -> dict:
    """일별 보유주수를 시뮬레이션 (롱온리).

    반환: {날짜: {종목코드: 보유주수}}
    """
    held = {b["code"]: 0.0 for b in basket}
    result = {}
    for t in dates:
        day_flow = flows.get(t, {})
        for b in basket:
            code = b["code"]
            f = day_flow.get(code, 0)
            p = prices.last_close_on_or_before(closes.get(code, {}), t)
            if not p or not f:
                continue
            if f > 0:  # 순매수 → 매수
                held[code] += f / p
            else:  # 순매도 → 보유 한도 내에서만 매도 (보유 0이면 무시)
                sell_shares = min(held[code], abs(f) / p)
                held[code] -= sell_shares
        result[t] = dict(held)
    return result


def continuous_curve(basket, flows: dict, closes: dict, dates: list[str]) -> list[float]:
    """매일 연기금 매매를 따라감 (롱온리) → 시간가중수익률(TWR) 곡선(%)."""
    if not basket or not dates:
        return []

    held = {b["code"]: 0.0 for b in basket}
    prev_value = 0.0
    cumulative = 1.0
    curve = []

    for t in dates:
        day_flow = flows.get(t, {})
        cash_flow = 0.0  # 매수대금 − 매도회수 (당일 종가 기준)

        for b in basket:
            code = b["code"]
            f = day_flow.get(code, 0)
            p = prices.last_close_on_or_before(closes.get(code, {}), t)
            if not p or not f:
                continue
            if f > 0:
                held[code] += f / p
                cash_flow += f
            else:
                sell_shares = min(held[code], abs(f) / p)
                held[code] -= sell_shares
                cash_flow -= sell_shares * p

        # 당일 종가 평가액
        value = 0.0
        for b in basket:
            p = prices.last_close_on_or_before(closes.get(b["code"], {}), t)
            if p:
                value += held[b["code"]] * p

        # 일간 수익률: 자본유입(cash_flow)을 뺀 순수 가치 변동
        if prev_value > 0:
            r = (value - cash_flow) / prev_value - 1.0
            cumulative *= (1.0 + r)
        # prev_value == 0 (최초 유입일)은 수익률 0으로 시작

        curve.append((cumulative - 1.0) * 100.0)
        prev_value = value

    return curve


# ------------------------------------- 일별 Top-N 리밸런싱 (프로그램 매매 가정)
def _cumulative_flows(flows: dict, dates: list[str], i: int, lookback: int) -> dict[str, int]:
    """dates[i]까지 최근 lookback 거래일의 종목별 누적 순매수."""
    window = dates[max(0, i - lookback + 1): i + 1]
    cum: dict[str, int] = {}
    for d in window:
        for code, f in (flows.get(d) or {}).items():
            cum[code] = cum.get(code, 0) + f
    return cum


def _target_weights(cum: dict[str, int], top_n: int) -> dict[str, float]:
    """누적 순매수 상위 top_n의 목표 비중(순매도 종목 제외, 합=1)."""
    buys = sorted(((c, v) for c, v in cum.items() if v > 0), key=lambda x: -x[1])[:top_n]
    total = sum(v for _, v in buys)
    if not buys or total <= 0:
        return {}
    return {c: v / total for c, v in buys}


def daily_topn_positions(flows, closes, dates, lookback=5, rebalance=1, top_n=10):
    """일별 보유주수 {날짜: {코드: 주수}}. 초기자본 1을 재배분(자본 유입 없음)."""
    value = 1.0
    shares: dict[str, float] = {}
    result = {}

    for i, t in enumerate(dates):
        # 1) 오늘 종가로 현재 포트폴리오 평가 (보유가 있으면)
        if shares:
            v = 0.0
            for code, s in shares.items():
                p = prices.last_close_on_or_before(closes.get(code, {}), t)
                if p:
                    v += s * p
            if v > 0:
                value = v

        # 2) 리밸런싱일이면 목표 비중으로 재구성 (종가 매매)
        if i % rebalance == 0:
            weights = _target_weights(_cumulative_flows(flows, dates, i, lookback), top_n)
            if weights:
                new_shares = {}
                for code, w in weights.items():
                    p = prices.last_close_on_or_before(closes.get(code, {}), t)
                    if p:
                        new_shares[code] = value * w / p
                if new_shares:
                    shares = new_shares  # 롱온리: 목표 비중은 모두 양수

        result[t] = dict(shares)
    return result


def daily_topn_curve(flows, closes, dates, lookback=5, rebalance=1, top_n=10) -> list[float]:
    """매 rebalance 거래일마다 최근 lookback일 누적 순매수 상위 top_n으로 갈아타기.

    자본 유입 없이 초기자본 1을 재배분하므로 누적수익률 = 평가액 − 1.
    """
    if not dates:
        return []
    positions = daily_topn_positions(flows, closes, dates, lookback, rebalance, top_n)

    curve = []
    prev = 1.0
    for t in dates:
        shares = positions[t]
        v = 0.0
        for code, s in shares.items():
            p = prices.last_close_on_or_before(closes.get(code, {}), t)
            if p:
                v += s * p
        if v <= 0:
            v = prev  # 아직 편입 전이면 현금 보유로 간주
        curve.append((v - 1.0) * 100.0)
        prev = v
    return curve


def universe_from_flows(flows: dict, dates: list[str], lookback: int, rebalance: int,
                        top_n: int) -> set[str]:
    """백테스트에 필요한 종목 집합 (리밸런싱 시점마다 상위 top_n에 든 종목들)."""
    codes: set[str] = set()
    for i in range(len(dates)):
        if i % rebalance != 0:
            continue
        codes.update(_target_weights(_cumulative_flows(flows, dates, i, lookback), top_n))
    return codes


# ---------------------------------------------------------------- 벤치마크
def benchmark_curve(index_closes: dict, dates: list[str]) -> list[float]:
    """지수 누적수익률(%) 곡선."""
    if not dates:
        return []
    base = prices.last_close_on_or_before(index_closes, dates[0])
    if not base:
        return [0.0] * len(dates)
    curve = []
    for t in dates:
        p = prices.last_close_on_or_before(index_closes, t)
        curve.append(((p / base) - 1.0) * 100.0 if p else 0.0)
    return curve


# -------------------------------------- 전략 그리드 + 강건성 검증 (매일 재계산)
# UI에서 고를 수 있는 파라미터. (신호 누적일 L, 리밸런싱 주기 R)
LOOKBACKS = [1, 3, 5, 20]
REBALANCES = [1, 5]          # 1=매일, 5=주1회
TOPNS = [5, 10]

ROBUST_WINDOW_DAYS = 91      # 검증 구간 길이(3개월)
ROBUST_STEP_DAYS = 30        # 1개월씩 이동
ROBUST_HISTORY_DAYS = 365    # 1년치로 검증


def _rolling_windows(all_dates: list[str], window_days: int, step_days: int) -> list[list[str]]:
    """겹치는 rolling window 목록. (독립 표본은 아니지만 일관성 판단에 쓴다)"""
    if not all_dates:
        return []
    windows, i = [], 0
    while i < len(all_dates):
        start_d = prices.to_date(all_dates[i])
        end_iso = (start_d + timedelta(days=window_days)).isoformat()
        seg = [d for d in all_dates if all_dates[i] <= d <= end_iso]
        if len(seg) < 30:  # 너무 짧은 꼬리 구간은 버린다
            break
        windows.append(seg)
        nxt_iso = (start_d + timedelta(days=step_days)).isoformat()
        nxt = [k for k, d in enumerate(all_dates) if d >= nxt_iso]
        if not nxt or nxt[0] == i:
            break
        i = nxt[0]
    return windows


def compute_robustness(flows, closes, index_closes, all_dates, top_n=10) -> list[dict]:
    """조합별로 여러 구간에서 지수 대비 초과수익을 재서 일관성을 판정한다.

    승률 70%+ & 평균 초과 양수 → consistent=True (과적합이 아닐 가능성).
    """
    windows = _rolling_windows(all_dates, ROBUST_WINDOW_DAYS, ROBUST_STEP_DAYS)
    if not windows:
        return []

    out = []
    for L in LOOKBACKS:
        for R in REBALANCES:
            alphas = []
            for seg in windows:
                bench = benchmark_curve(index_closes, seg)
                curve = daily_topn_curve(flows, closes, seg, lookback=L, rebalance=R, top_n=top_n)
                if curve and bench:
                    alphas.append(curve[-1] - bench[-1])
            if not alphas:
                continue
            mean = sum(alphas) / len(alphas)
            var = sum((a - mean) ** 2 for a in alphas) / len(alphas)
            wins = sum(1 for a in alphas if a > 0)
            winrate = wins / len(alphas) * 100
            out.append({
                "lookback": L,
                "rebalance": R,
                "mean_alpha": round(mean, 2),
                "stdev": round(var ** 0.5, 2),
                "win_rate": round(winrate, 1),
                "windows": len(alphas),
                "alphas": [round(a, 1) for a in alphas],
                "consistent": winrate >= 70 and mean > 0,
            })
    out.sort(key=lambda r: -r["mean_alpha"])
    return out


# ---------------------------------------------------------------- 전체 계산
def _now_iso() -> str:
    return store.now_kst_iso()


def strategy_key(L: int, R: int, N: int) -> str:
    return f"L{L}_R{R}_N{N}"


def compute_returns(session=None, today: date | None = None, top_n: int = TOP_N,
                    progress=None) -> dict:
    """returns.json 전체를 계산한다.

    - 기간별(1/3/6개월): 스냅샷 · 연속 · 지수 곡선 + **일별 Top-N 전략 그리드**
    - 시장별: **강건성 검증**(1년치를 3개월 rolling window로 잘라 조합별 일관성 판정)
    매 실행마다 최신 데이터로 다시 계산하므로, 시간이 지나면 결과도 갱신된다.
    """
    session = session or krx_flow.make_session()
    today = today or date.today()

    def note(msg):
        if progress:
            progress(msg)

    markets = {}
    for market in ("kospi", "kosdaq"):
        hist_start = today - timedelta(days=ROBUST_HISTORY_DAYS)
        index_closes = prices.fetch_index_closes(
            INDEX_SYMBOL[market], hist_start - timedelta(days=40), today, session
        )
        all_dates = prices.trading_days(index_closes, hist_start.isoformat(), today.isoformat())
        if not all_dates:
            markets[market] = {"windows": {}, "robustness": []}
            continue

        # 1) 1년치 일별 순매수 (날짜별 디스크 캐시 — 매일 1일치만 추가됨)
        note(f"{market}: 일별 순매수 {len(all_dates)}일")
        flows = {}
        for d in all_dates:
            try:
                flows[d] = krx_flow.fetch_daily_netbuy(market, prices.to_date(d), session)
            except Exception:
                flows[d] = {}

        # 2) 기간별 바스켓 (기존 스냅샷/연속 방식용, T0 이전 정보만 사용)
        baskets = {}
        for key, _label, days_back in WINDOWS:
            t0 = today - timedelta(days=days_back)
            try:
                rows = krx_flow._fetch_window(
                    session, krx_flow.MARKETS[market],
                    t0 - timedelta(days=BASKET_LOOKBACK_DAYS), t0,
                )
                baskets[key] = select_basket(rows, top_n)
            except Exception:
                baskets[key] = []

        # 3) 필요한 모든 종목의 주가 (전략 그리드 + 바스켓의 합집합, 증분 캐시)
        universe: set[str] = set()
        for L in LOOKBACKS:
            for R in REBALANCES:
                for N in TOPNS:
                    universe |= universe_from_flows(flows, all_dates, L, R, N)
        for b in baskets.values():
            universe |= {x["code"] for x in b}

        note(f"{market}: 종목 주가 {len(universe)}개")
        closes = {}
        for code in universe:
            try:
                closes[code] = prices.fetch_closes_cached(
                    code, hist_start - timedelta(days=10), today, session
                )
            except Exception:
                pass

        # 4) 강건성 검증 (1년, rolling window) — 매 실행 재계산
        note(f"{market}: 강건성 검증")
        robustness = compute_robustness(flows, closes, index_closes, all_dates, top_n=10)

        # 5) 기간별 곡선
        windows_out = {}
        for key, _label, days_back in WINDOWS:
            t0 = today - timedelta(days=days_back)
            dates = [d for d in all_dates if d >= t0.isoformat()]
            if len(dates) < 5:
                continue
            basket = baskets.get(key) or []
            bench = benchmark_curve(index_closes, dates)
            snap = snapshot_curve(basket, closes, dates) if basket else []
            cont = continuous_curve(basket, flows, closes, dates) if basket else []

            # 일별 Top-N 전략 그리드 (UI에서 파라미터를 바꿔가며 비교)
            strategies = {}
            for L in LOOKBACKS:
                for R in REBALANCES:
                    for N in TOPNS:
                        curve = daily_topn_curve(flows, closes, dates, L, R, N)
                        if curve:
                            strategies[strategy_key(L, R, N)] = [round(v, 2) for v in curve]

            windows_out[key] = {
                "start": dates[0],
                "basket": [
                    {
                        "code": b["code"], "name": b["name"],
                        "weight": round(b["weight"], 4),
                        "buy_value_100m": round(b["buy_value"] / 1e8, 1),
                    }
                    for b in basket
                ],
                "dates": dates,
                "snapshot": [round(v, 2) for v in snap],
                "continuous": [round(v, 2) for v in cont],
                "benchmark": [round(v, 2) for v in bench],
                "strategies": strategies,
                "summary": {
                    "snapshot_return": round(snap[-1], 2) if snap else 0.0,
                    "continuous_return": round(cont[-1], 2) if cont else 0.0,
                    "benchmark_return": round(bench[-1], 2) if bench else 0.0,
                    "snapshot_alpha": round(snap[-1] - bench[-1], 2) if snap and bench else 0.0,
                    "continuous_alpha": round(cont[-1] - bench[-1], 2) if cont and bench else 0.0,
                },
            }

        markets[market] = {"windows": windows_out, "robustness": robustness}

    return {
        "source": "KRX 연기금 순매수 + 네이버 일별 종가",
        "fetched_at": _now_iso(),
        "as_of": today.isoformat(),
        "top_n": top_n,
        "params": {"lookbacks": LOOKBACKS, "rebalances": REBALANCES, "topns": TOPNS},
        "robust_config": {
            "history_days": ROBUST_HISTORY_DAYS,
            "window_days": ROBUST_WINDOW_DAYS,
            "step_days": ROBUST_STEP_DAYS,
        },
        "markets": markets,
    }
