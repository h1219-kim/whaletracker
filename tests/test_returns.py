"""따라투자 수익률 계산 테스트 — 손계산으로 검증 가능한 합성 데이터."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nps_fetcher import returns  # noqa: E402


# ---------------------------------------------------------------- 대상 선정
def test_select_basket_top5_and_weights():
    rows = [
        {"code": f"00000{i}", "name": f"종목{i}", "net_value": v}
        for i, v in enumerate([1000, 900, 800, 700, 600, 500, 400], start=1)
    ]
    basket = returns.select_basket(rows, top_n=5)

    assert len(basket) == 5
    assert [b["code"] for b in basket] == ["000001", "000002", "000003", "000004", "000005"]
    # 비중은 상위 5개 안에서 정규화 (1000+900+800+700+600 = 4000)
    assert basket[0]["weight"] == pytest.approx(1000 / 4000)
    assert sum(b["weight"] for b in basket) == pytest.approx(1.0)


def test_select_basket_excludes_net_sellers():
    """순매도(음수) 종목은 '따라 살' 대상이 아니다."""
    rows = [
        {"code": "000001", "name": "A", "net_value": 1000},
        {"code": "000002", "name": "B", "net_value": -500},
    ]
    basket = returns.select_basket(rows, top_n=5)
    assert [b["code"] for b in basket] == ["000001"]


# ---------------------------------------------------------------- 스냅샷
def test_snapshot_curve_hand_calculation():
    """A 60% @100, B 40% @50 → T1 +2%, T2 +16% (손계산)."""
    basket = [
        {"code": "A", "name": "A", "weight": 0.6},
        {"code": "B", "name": "B", "weight": 0.4},
    ]
    closes = {
        "A": {"2026-01-01": 100.0, "2026-01-02": 110.0, "2026-01-03": 120.0},
        "B": {"2026-01-01": 50.0, "2026-01-02": 45.0, "2026-01-03": 55.0},
    }
    dates = ["2026-01-01", "2026-01-02", "2026-01-03"]

    curve = returns.snapshot_curve(basket, closes, dates)

    # s_A = 0.6/100 = 0.006, s_B = 0.4/50 = 0.008
    # V(T1) = .006*110 + .008*45 = 1.02 → +2%
    # V(T2) = .006*120 + .008*55 = 1.16 → +16%
    assert curve[0] == pytest.approx(0.0)
    assert curve[1] == pytest.approx(2.0)
    assert curve[2] == pytest.approx(16.0)


# ---------------------------------------------------------------- 연속(TWR)
def test_continuous_curve_twr_hand_calculation():
    """매수 후 주가 +10%, 이후 일부 매도(주가 불변) → TWR은 10% 유지.

    매도로 돈이 빠져나가도 '수익률'은 변하지 않아야 한다(자본흐름 효과 제거).
    """
    basket = [{"code": "A", "name": "A", "weight": 1.0}]
    closes = {"A": {"2026-01-01": 100.0, "2026-01-02": 110.0, "2026-01-03": 110.0}}
    dates = ["2026-01-01", "2026-01-02", "2026-01-03"]
    flows = {
        "2026-01-01": {"A": 1000},    # 매수 1000원 → 10주
        "2026-01-02": {},             # 흐름 없음, 주가 110 → +10%
        "2026-01-03": {"A": -500},    # 500원어치 매도 (주가 불변)
    }

    curve = returns.continuous_curve(basket, flows, closes, dates)

    assert curve[0] == pytest.approx(0.0)
    assert curve[1] == pytest.approx(10.0)
    assert curve[2] == pytest.approx(10.0)  # 매도해도 수익률 불변


def test_continuous_long_only_ignores_sell_without_holding():
    """보유가 없는 종목의 순매도는 무시한다 (공매도 없음)."""
    basket = [{"code": "A", "name": "A", "weight": 1.0}]
    closes = {"A": {"2026-01-01": 100.0, "2026-01-02": 120.0}}
    dates = ["2026-01-01", "2026-01-02"]
    flows = {
        "2026-01-01": {"A": -1000},   # 보유 0인데 매도 → 무시
        "2026-01-02": {"A": 1000},    # 여기서 처음 매수
    }

    curve = returns.continuous_curve(basket, flows, closes, dates)

    # 첫날 아무 포지션도 없어야 하고(무시), 둘째날 매수 → 수익률 0
    assert curve[0] == pytest.approx(0.0)
    assert curve[1] == pytest.approx(0.0)


def test_continuous_sell_clipped_to_holding():
    """보유량을 초과하는 매도는 보유량까지만 (마이너스 포지션 금지)."""
    basket = [{"code": "A", "name": "A", "weight": 1.0}]
    closes = {"A": {"2026-01-01": 100.0, "2026-01-02": 100.0, "2026-01-03": 100.0}}
    dates = ["2026-01-01", "2026-01-02", "2026-01-03"]
    flows = {
        "2026-01-01": {"A": 200},      # 2주 매수
        "2026-01-02": {"A": -1000},    # 10주어치 매도 요청 → 보유 2주까지만
        "2026-01-03": {},
    }

    shares = returns.simulate_positions(basket, flows, closes, dates)
    assert shares["2026-01-02"]["A"] == pytest.approx(0.0)  # 전량 청산, 음수 아님
    assert shares["2026-01-03"]["A"] == pytest.approx(0.0)


# ---------------------------------------------------------------- 벤치마크
def test_benchmark_curve():
    idx = {"2026-01-01": 100.0, "2026-01-02": 105.0, "2026-01-03": 95.0}
    dates = ["2026-01-01", "2026-01-02", "2026-01-03"]
    curve = returns.benchmark_curve(idx, dates)
    assert curve == [pytest.approx(0.0), pytest.approx(5.0), pytest.approx(-5.0)]


# ------------------------------------------- 일별 Top-N 리밸런싱 (신규 전략)
def test_daily_topn_rebalance_hand_calculation():
    """매일 상위 1종목으로 갈아타기 — 초기자본 1을 재배분(자본 유입 없음).

    d1: A 매수(100) → V=1.0        (수익률 0%)
    d2: A가 110으로 +10% → V=1.1, 그날 신호는 B → B로 전량 교체 (V 유지 1.1)
    d3: B는 50 그대로 → V=1.1, 신호는 A → A로 교체 (V 유지)
    """
    closes = {
        "A": {"d1": 100.0, "d2": 110.0, "d3": 120.0},
        "B": {"d1": 50.0, "d2": 50.0, "d3": 50.0},
    }
    dates = ["d1", "d2", "d3"]
    flows = {
        "d1": {"A": 1000},
        "d2": {"B": 1000},
        "d3": {"A": 1000},
    }
    curve = returns.daily_topn_curve(flows, closes, dates, lookback=1, rebalance=1, top_n=1)

    assert curve[0] == pytest.approx(0.0)
    assert curve[1] == pytest.approx(10.0)   # A가 오른 만큼만
    assert curve[2] == pytest.approx(10.0)   # 교체해도 가치는 유지(재배분)


def test_daily_topn_lookback_accumulates_signal():
    """lookback=2면 최근 2일 누적 순매수로 상위를 뽑는다."""
    closes = {"A": {"d1": 100.0, "d2": 100.0}, "B": {"d1": 100.0, "d2": 100.0}}
    dates = ["d1", "d2"]
    # d1은 A가 크고, d2는 B가 크지만 2일 누적은 A(600) > B(500)
    flows = {"d1": {"A": 500, "B": 100}, "d2": {"A": 100, "B": 400}}

    held = returns.daily_topn_positions(flows, closes, dates, lookback=2, rebalance=1, top_n=1)
    assert list(held["d2"].keys()) == ["A"]  # 누적 기준이라 A 유지


def test_daily_topn_ignores_net_sellers():
    """순매도(음수) 종목은 후보에서 제외 (공매도 없음)."""
    closes = {"A": {"d1": 100.0}, "B": {"d1": 100.0}}
    dates = ["d1"]
    flows = {"d1": {"A": -500, "B": 300}}
    held = returns.daily_topn_positions(flows, closes, dates, lookback=1, rebalance=1, top_n=2)
    assert list(held["d1"].keys()) == ["B"]
