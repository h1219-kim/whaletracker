/* WhaleTracker 대시보드 렌더러 (바닐라 JS, 외부 의존성 없음)
   dataviz 규칙: 얇은 마크·2px 표면 갭·헤어라인 그리드·선별적 직접 라벨·
   호버 툴팁 기본 제공·모든 차트에 테이블 대체 뷰·텍스트는 텍스트 토큰. */
"use strict";

const state = {
  holdings: null,
  allocation: null,
  majorStakes: null,
  trends: null,
  days: 90,
  holdingsView: { query: "", sortKey: "rank", sortAsc: true, page: 1, perPage: 25 },
  filingsShown: 30,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------- DOM 헬퍼 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------------------------------------------------- 숫자 표기 */
const fmtInt = (n) => Math.round(n).toLocaleString("ko-KR");

function fmtTrillion(v, digits = 1) {
  return `${v.toLocaleString("ko-KR", { maximumFractionDigits: digits })}조 원`;
}

// 억 원 값 → 1조 이상이면 조 단위로
function fmtValue100m(v) {
  if (Math.abs(v) >= 10000) {
    return `${(v / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조 원`;
  }
  return `${fmtInt(v)}억 원`;
}

function fmtDeltaRatio(r) {
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  return `${sign}${Math.abs(r).toFixed(2)}%p`;
}

function fmtDeltaShares(n) {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${fmtInt(Math.abs(n))}주`;
}

function fmtDate(d) {
  return d || "—";
}

// "2024-12-31" → "2024년 말", "2026-04" → "2026년 4월 말"
function fmtAsOf(asOf) {
  if (!asOf) return "기준일 미상";
  const parts = asOf.split("-");
  if (parts.length === 3 && parts[1] === "12" && parts[2] === "31") {
    return `${parts[0]}년 말`;
  }
  if (parts.length >= 2) return `${parts[0]}년 ${Number(parts[1])}월 말`;
  return asOf;
}

function deltaClass(r) {
  if (r > 0) return "delta-buy";
  if (r < 0) return "delta-sell";
  return "delta-flat";
}

/* ---------------------------------------------------------- 툴팁 */
const tooltip = $("tooltip");

function tooltipRow(label, value, keyColor) {
  const key = el("span", { class: "tt-key" });
  if (keyColor) key.append(el("span", { class: "key-line", style: `background:${keyColor}` }));
  key.append(document.createTextNode(label));
  return el("div", { class: "tt-row" }, key, el("span", { class: "tt-val" }, value));
}

function showTooltip(evt, title, rows) {
  clear(tooltip);
  tooltip.append(el("div", { class: "tt-title" }, title));
  rows.forEach((r) => tooltip.append(r));
  tooltip.hidden = false;
  moveTooltip(evt);
}

function moveTooltip(evt) {
  if (tooltip.hidden) return;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

// 마우스·키보드 포커스 모두 같은 툴팁을 보여준다
function bindTooltip(node, buildFn) {
  node.addEventListener("pointerenter", (e) => buildFn(e));
  node.addEventListener("pointermove", moveTooltip);
  node.addEventListener("pointerleave", hideTooltip);
  node.setAttribute("tabindex", "0");
  node.addEventListener("focus", () => {
    const r = node.getBoundingClientRect();
    buildFn({ clientX: r.right, clientY: r.top });
  });
  node.addEventListener("blur", hideTooltip);
}

/* ---------------------------------------------------------- 축 눈금 */
function niceScale(maxValue, targetTicks = 4) {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  const rough = maxValue / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  let step = steps.find((s) => s * mag >= rough) * mag || mag * 10;
  // 헤어라인 여유: 최댓값이 눈금 최댓값의 92%를 넘으면 한 칸 더
  let max = Math.ceil(maxValue / step) * step;
  if (maxValue / max > 0.92) max += step;
  const ticks = [];
  for (let t = step; t <= max + 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  return { max, ticks };
}

/* ---------------------------------------------------------- API */
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/* ============================================================ 렌더 */

function renderBadges() {
  const box = clear($("date-badges"));
  const badge = (label, value) => el("span", { class: "badge" }, `${label} `, el("b", {}, value));
  if (state.allocation && !state.allocation.empty) {
    box.append(badge("자산배분", `${fmtAsOf(state.allocation.as_of)} 기준`));
  }
  if (state.holdings && !state.holdings.empty) {
    box.append(badge("보유종목", `${fmtAsOf(state.holdings.as_of)} 기준 (연 1회 공시)`));
  }
  if (state.trends && !state.trends.empty && state.trends.recent_filings) {
    box.append(badge("공시", `최근 ${state.days}일 ${state.trends.recent_filings.length}건`));
  }
}

function renderKPIs() {
  const box = clear($("kpi-section"));
  const tile = (label, valueNode, sub) =>
    el("div", { class: "stat-tile" },
      el("div", { class: "stat-label" }, label),
      el("div", { class: "stat-value" }, valueNode),
      sub ? el("div", { class: "stat-sub" }, sub) : null);
  const value = (num, unit) => [num, el("span", { class: "unit" }, unit)];

  const a = state.allocation;
  if (a && !a.empty) {
    tileBoxAppend(box, tile("기금 전체 자산", value(a.total_trillion.toLocaleString("ko-KR"), "조 원"),
      `${fmtAsOf(a.as_of)} 기준`));
    const dom = (a.assets || []).find((x) => x.name === "국내주식");
    if (dom) {
      tileBoxAppend(box, tile("국내주식", value(dom.value_trillion.toLocaleString("ko-KR"), "조 원"),
        `기금 내 비중 ${dom.weight_pct}%`));
    }
  } else {
    tileBoxAppend(box, tile("기금 전체 자산", "—", "데이터 없음"));
  }

  const t = state.trends;
  if (t && !t.empty) {
    tileBoxAppend(box, tile("순매수 종목", value(String(t.buy_count ?? t.top_buys.length), "개"),
      `최근 ${state.days}일 · 지분 공시 기준`));
    tileBoxAppend(box, tile("순매도 종목", value(String(t.sell_count ?? t.top_sells.length), "개"),
      `최근 ${state.days}일 · 지분 공시 기준`));
  } else {
    tileBoxAppend(box, tile("순매수 종목", "—", "공시 데이터 없음"));
    tileBoxAppend(box, tile("순매도 종목", "—", "공시 데이터 없음"));
  }
}

function tileBoxAppend(box, node) { box.append(node); }

/* ------------------------------------------------------ 자산배분 */
// 카테고리 슬롯 고정 배정 — 필터/정렬과 무관하게 자산군마다 같은 색
const ALLOC_COLORS = {
  해외주식: "var(--s1)",
  국내주식: "var(--s2)",
  국내채권: "var(--s3)",
  대체투자: "var(--s5)",
  해외채권: "var(--s4)",
  기타: "var(--other)",
};

function luminanceInk(cssVar) {
  // 세그먼트 안 라벨 잉크: 밝은 슬롯(yellow/aqua)은 검정, 나머지는 흰색
  return cssVar === "var(--s3)" || cssVar === "var(--s2)" ? "#0b0b0b" : "#ffffff";
}

function foldedAssets() {
  const assets = state.allocation.assets || [];
  const main = assets.filter((x) => x.weight_pct >= 0.5);
  const rest = assets.filter((x) => x.weight_pct < 0.5);
  const out = [...main];
  if (rest.length) {
    out.push({
      name: "기타",
      value_trillion: Number(rest.reduce((s, x) => s + x.value_trillion, 0).toFixed(1)),
      weight_pct: Number(rest.reduce((s, x) => s + x.weight_pct, 0).toFixed(1)),
      _folded: rest,
    });
  }
  return out;
}

function renderAllocation() {
  const chartBox = clear($("allocation-chart"));
  const tableBox = clear($("allocation-table"));
  const caption = $("allocation-caption");

  const a = state.allocation;
  if (!a || a.empty) {
    caption.textContent = "";
    chartBox.append(el("div", { class: "placeholder" }, "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }
  caption.textContent = `전체 ${fmtTrillion(a.total_trillion)} · ${fmtAsOf(a.as_of)} 기준 · 자산군별 비중(%)`;

  const assets = foldedAssets();
  const bar = el("div", { class: "stackbar", role: "img", "aria-label": "자산배분 스택 바" });

  assets.forEach((asset) => {
    const color = ALLOC_COLORS[asset.name] || "var(--s8)";
    const seg = el("div", {
      class: "seg",
      style: `flex:${asset.weight_pct} 1 0; background:${color}`,
    });
    bindTooltip(seg, (e) =>
      showTooltip(e, asset.name, [
        tooltipRow("금액", fmtTrillion(asset.value_trillion), color),
        tooltipRow("비중", `${asset.weight_pct}%`),
        ...(asset._folded || []).map((f) =>
          tooltipRow(f.name, `${fmtTrillion(f.value_trillion)} · ${f.weight_pct}%`)),
      ]));
    // 직접 라벨: 5% 이상 세그먼트만, 렌더 후 실측해서 넘치면 제거 (클리핑 금지)
    if (asset.weight_pct >= 5) {
      seg.append(el("span", { class: "seg-label", style: `color:${luminanceInk(color)}` },
        `${asset.name} ${asset.weight_pct}%`));
    }
    bar.append(seg);
  });
  chartBox.append(bar);

  // 라벨 실측: 세그먼트보다 라벨이 넓으면 떼어낸다 (범례·툴팁·테이블이 대신한다)
  requestAnimationFrame(() => {
    bar.querySelectorAll(".seg").forEach((seg) => {
      const label = seg.querySelector(".seg-label");
      if (label && label.scrollWidth > seg.clientWidth - 8) label.remove();
    });
  });

  // 범례 (시리즈 ≥ 2 — 항상 표시)
  const legend = el("div", { class: "legend" });
  assets.forEach((asset) => {
    legend.append(el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: `background:${ALLOC_COLORS[asset.name] || "var(--s8)"}` }),
      `${asset.name} `, el("b", {}, `${asset.weight_pct}%`)));
  });
  chartBox.append(legend);

  // 테이블 대체 뷰
  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "자산군"), el("th", { class: "num" }, "금액(조 원)"), el("th", { class: "num" }, "비중(%)"))),
    el("tbody", {}, (a.assets || []).map((x) =>
      el("tr", {},
        el("td", {}, x.name),
        el("td", { class: "num" }, x.value_trillion.toLocaleString("ko-KR")),
        el("td", { class: "num" }, x.weight_pct.toFixed(1))))));
  tableBox.append(el("div", { class: "table-wrap" }, table));
}

/* ------------------------------------------------------ 매매 동향 */
function renderTrends() {
  renderDiverging();
  renderFilingsTable();
  const t = state.trends;
  const caption = $("trends-caption");
  if (!t || t.empty) {
    caption.textContent = "";
    return;
  }
  caption.textContent =
    `DART 지분 공시의 보고 전→후 지분율 순변동(Δ%p) · ${t.since} 이후 접수분 · ` +
    "정정공시와 본문 미해석 공시는 집계에서 제외";
}

function renderDiverging() {
  const chartBox = clear($("diverging-chart"));
  const tableBox = clear($("diverging-table"));
  const t = state.trends;

  if (!t || t.empty || (!t.top_buys.length && !t.top_sells.length)) {
    chartBox.append(el("div", { class: "placeholder" },
      t && !t.empty ? "이 기간에 집계된 지분 변동 공시가 없습니다."
                    : "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  // 위→아래: 순매수 큰 순 → 순매도 큰 순(맨 아래가 최대 매도)
  const rows = [...t.top_buys, ...[...t.top_sells].sort((a, b) => b.delta_ratio - a.delta_ratio)];
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta_ratio)));
  const { max: xmax, ticks } = niceScale(maxAbs, 3);

  const names = el("div", { class: "hchart-names" });
  const plot = el("div", { class: "hchart-plot" });

  // 그리드: 0 기준선(진하게) + 좌우 대칭 눈금 (실선 헤어라인)
  const xpos = (v) => 50 + (v / xmax) * 50; // % (−xmax…+xmax → 0…100)
  plot.append(el("div", { class: "gridline zero", style: `left:${xpos(0)}%` }));
  ticks.forEach((tk) => {
    plot.append(el("div", { class: "gridline", style: `left:${xpos(tk)}%` }));
    plot.append(el("div", { class: "gridline", style: `left:${xpos(-tk)}%` }));
  });

  rows.forEach((r) => {
    names.append(el("div", { class: "hchart-name", title: r.company }, r.company));
    const row = el("div", { class: "hchart-row" });
    const positive = r.delta_ratio >= 0;
    const w = (Math.abs(r.delta_ratio) / xmax) * 50;
    const left = positive ? 50 : 50 - w;
    const color = positive ? "var(--buy)" : "var(--sell)";
    row.append(el("div", {
      class: `hbar${positive ? "" : " neg"}`,
      style: `left:${left}%; width:${w}%; background:${color}`,
    }));
    // 값 라벨: 바 끝 바깥쪽
    row.append(el("div", {
      class: "hbar-value",
      style: positive
        ? `left:calc(${50 + w}% + 6px)`
        : `right:calc(${50 + w}% + 6px); left:auto`,
    }, fmtDeltaRatio(r.delta_ratio)));
    // 히트 타깃(행 전체) + 툴팁
    const hit = el("div", { class: "hbar-hit" });
    bindTooltip(hit, (e) =>
      showTooltip(e, r.company, [
        tooltipRow("Δ지분율", fmtDeltaRatio(r.delta_ratio), color),
        tooltipRow("Δ주식수", fmtDeltaShares(r.delta_shares)),
        tooltipRow("공시", `${r.filings}건`),
        tooltipRow("최근 접수일", fmtDate(r.last_date)),
      ]));
    row.append(hit);
    plot.append(row);
  });

  // x축 눈금 라벨
  const axis = el("div", { class: "hchart-axis" });
  axis.append(el("span", { style: `left:${xpos(0)}%` }, "0"));
  ticks.forEach((tk) => {
    axis.append(el("span", { style: `left:${xpos(tk)}%` }, `+${tk}`));
    axis.append(el("span", { style: `left:${xpos(-tk)}%` }, `−${tk}`));
  });

  chartBox.append(
    el("div", { class: "hchart" },
      el("div", { class: "hchart-grid" }, names, plot),
      el("div", { class: "hchart-grid" }, el("div"), axis)));

  // 범례 (매수/매도 두 시리즈)
  chartBox.append(el("div", { class: "legend" },
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--buy)" }), "순매수(지분 확대)"),
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--sell)" }), "순매도(지분 축소)")));

  // 테이블 대체 뷰
  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "종목"), el("th", { class: "num" }, "Δ지분율(%p)"),
      el("th", { class: "num" }, "Δ주식수"), el("th", { class: "num" }, "공시 수"),
      el("th", {}, "최근 접수일"))),
    el("tbody", {}, rows.map((r) =>
      el("tr", {},
        el("td", {}, r.company),
        el("td", { class: `num ${deltaClass(r.delta_ratio)}` }, fmtDeltaRatio(r.delta_ratio)),
        el("td", { class: "num" }, fmtDeltaShares(r.delta_shares)),
        el("td", { class: "num" }, String(r.filings)),
        el("td", {}, fmtDate(r.last_date))))));
  tableBox.append(el("div", { class: "table-wrap" }, table));
}

const REPORT_TYPE_LABEL = { exec: "주요주주 소유상황", bulk: "대량보유(5%)", other: "기타" };

function renderFilingsTable() {
  const box = clear($("filings-table"));
  const t = state.trends;
  if (!t || t.empty || !t.recent_filings || !t.recent_filings.length) {
    box.append(el("div", { class: "placeholder" },
      t && !t.empty ? "이 기간의 공시가 없습니다." : "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  const tbody = el("tbody");
  const filings = t.recent_filings.slice(0, state.filingsShown);

  filings.forEach((f) => {
    const delta = f.delta || {};
    const ratioCell = el("td", { class: "num" });
    if (f.parse_ok && delta.ratio !== null && delta.ratio !== undefined) {
      const prev = f.prev?.ratio, curr = f.curr?.ratio;
      ratioCell.append(
        el("span", {}, `${prev != null ? prev.toFixed(2) : "?"}% → ${curr != null ? curr.toFixed(2) : "?"}% `),
        el("span", { class: deltaClass(delta.ratio) }, `(${fmtDeltaRatio(delta.ratio)})`));
    } else {
      ratioCell.append(el("span", { class: "no-parse" }, "본문 미해석"));
    }

    const detailCell = el("td");
    if (f.trades && f.trades.length) {
      const btn = el("button", { class: "trades-btn" }, `매매 ${f.trades.length}건 ▾`);
      btn.addEventListener("click", () => toggleTradeDetail(tr, f, btn));
      detailCell.append(btn);
    } else {
      detailCell.append(el("span", { class: "no-parse" }, "—"));
    }

    const tr = el("tr", {},
      el("td", {}, fmtDate(f.filed_date)),
      el("td", {}, f.company || "—"),
      el("td", {},
        el("span", { class: "type-badge" }, REPORT_TYPE_LABEL[f.report_type] || "기타"),
        f.is_correction ? el("span", { class: "amend-badge" }, "정정") : null),
      ratioCell,
      detailCell,
      el("td", {}, el("a", {
        href: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(f.rcp_no)}`,
        target: "_blank", rel: "noopener noreferrer",
      }, "원문")));
    tbody.append(tr);
  });

  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "접수일"), el("th", {}, "회사"), el("th", {}, "보고서"),
      el("th", { class: "num" }, "지분율 변화"), el("th", {}, "매매 상세"), el("th", {}, "링크"))),
    tbody);
  box.append(el("div", { class: "table-wrap" }, table));

  if (t.recent_filings.length > state.filingsShown) {
    const more = el("button", { class: "more-btn" },
      `더 보기 (${state.filingsShown}/${t.recent_filings.length})`);
    more.addEventListener("click", () => {
      state.filingsShown += 30;
      renderFilingsTable();
    });
    box.append(more);
  }
}

function toggleTradeDetail(tr, filing, btn) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("trades-detail-row")) {
    next.remove();
    btn.textContent = `매매 ${filing.trades.length}건 ▾`;
    return;
  }
  btn.textContent = `매매 ${filing.trades.length}건 ▴`;
  const inner = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "일자"), el("th", {}, "사유"),
      el("th", { class: "num" }, "증감 주식수"), el("th", { class: "num" }, "단가(원)"))),
    el("tbody", {}, filing.trades.map((trade) =>
      el("tr", {},
        el("td", {}, fmtDate(trade.date)),
        el("td", {}, trade.reason || "—"),
        el("td", { class: `num ${deltaClass(trade.delta_shares)}` }, fmtDeltaShares(trade.delta_shares)),
        el("td", { class: "num" }, trade.price != null ? fmtInt(trade.price) : "—")))));
  const detail = el("tr", { class: "trades-detail-row" },
    el("td", { colspan: "6" }, inner));
  tr.after(detail);
}

/* ------------------------------------------------------ 보유 종목 */
function normalizeName(name) {
  return (name || "").replace(/\(주\)|㈜|주식회사/g, "").replace(/\s+/g, "");
}

function stakesByName() {
  const map = new Map();
  const s = state.majorStakes;
  if (s && !s.empty) {
    (s.stakes || []).forEach((x) => map.set(normalizeName(x.name), x));
  }
  return map;
}

function renderHoldings() {
  renderTop20();
  renderHoldingsTable();
  const caption = $("holdings-caption");
  const h = state.holdings;
  if (!h || h.empty) {
    caption.textContent = "";
    return;
  }
  caption.textContent =
    `${fmtAsOf(h.as_of)} 기준 (연 1회 공시) · ${fmtInt(h.stocks.length)}종목 · ` +
    `평가액 합계 ${fmtValue100m(h.total_value_100m)}`;
}

function renderTop20() {
  const box = clear($("top20-chart"));
  const h = state.holdings;
  if (!h || h.empty) {
    box.append(el("div", { class: "placeholder" }, "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  const top = h.stocks.slice(0, 20);
  const maxVal = Math.max(...top.map((s) => s.value_100m));
  const { max: xmax, ticks } = niceScale(maxVal / 10000, 4); // 조 단위 눈금

  const names = el("div", { class: "hchart-names" });
  const plot = el("div", { class: "hchart-plot" });

  ticks.forEach((tk) => plot.append(el("div", { class: "gridline", style: `left:${(tk / xmax) * 100}%` })));
  plot.append(el("div", { class: "gridline zero", style: "left:0%" }));

  top.forEach((s, i) => {
    names.append(el("div", { class: "hchart-name", title: s.name }, s.name));
    const w = (s.value_100m / 10000 / xmax) * 100;
    const row = el("div", { class: "hchart-row" });
    // 명목 카테고리 — 값-램프 금지, 전 종목 시퀀셜 대표색 한 가지
    row.append(el("div", { class: "hbar", style: `left:0%; width:${w}%; background:var(--seq)` }));
    if (i < 5) {
      // 직접 라벨은 상위 5개만 — 나머지는 축·툴팁·테이블이 담당
      row.append(el("div", { class: "hbar-value", style: `left:calc(${w}% + 6px)` },
        fmtValue100m(s.value_100m)));
    }
    const hit = el("div", { class: "hbar-hit" });
    bindTooltip(hit, (e) =>
      showTooltip(e, s.name, [
        tooltipRow("평가액", fmtValue100m(s.value_100m), "var(--seq)"),
        tooltipRow("국내주식 내 비중", `${s.weight_pct}%`),
        tooltipRow("지분율", `${s.ownership_pct}%`),
      ]));
    row.append(hit);
    plot.append(row);
  });

  const axis = el("div", { class: "hchart-axis" });
  axis.append(el("span", { style: "left:0%" }, "0"));
  ticks.forEach((tk) => axis.append(el("span", { style: `left:${(tk / xmax) * 100}%` }, `${tk}조`)));

  box.append(el("div", { class: "hchart" },
    el("div", { class: "hchart-grid" }, names, plot),
    el("div", { class: "hchart-grid" }, el("div"), axis)));
}

const HOLDING_COLUMNS = [
  { key: "rank", label: "순위", num: true },
  { key: "name", label: "종목명", num: false },
  { key: "value_100m", label: "평가액", num: true },
  { key: "weight_pct", label: "비중(%)", num: true },
  { key: "ownership_pct", label: "지분율(%)", num: true },
];

function filteredSortedHoldings() {
  const h = state.holdings;
  const v = state.holdingsView;
  let rows = h.stocks;
  if (v.query) {
    const q = v.query.toLowerCase();
    rows = rows.filter((s) => s.name.toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => {
    const x = a[v.sortKey], y = b[v.sortKey];
    const cmp = typeof x === "string" ? x.localeCompare(y, "ko") : x - y;
    return v.sortAsc ? cmp : -cmp;
  });
  return rows;
}

function renderHoldingsTable() {
  const box = clear($("holdings-table"));
  const pag = clear($("holdings-pagination"));
  const h = state.holdings;
  if (!h || h.empty) {
    box.append(el("div", { class: "placeholder" }, "데이터가 없습니다."));
    return;
  }

  const v = state.holdingsView;
  const stakes = stakesByName();
  const rows = filteredSortedHoldings();
  const pages = Math.max(1, Math.ceil(rows.length / v.perPage));
  if (v.page > pages) v.page = pages;
  const pageRows = rows.slice((v.page - 1) * v.perPage, v.page * v.perPage);

  const headCells = HOLDING_COLUMNS.map((c) => {
    const th = el("th", { class: `sortable${c.num ? " num" : ""}` }, c.label);
    if (v.sortKey === c.key) th.append(el("span", { class: "sort-arrow" }, v.sortAsc ? "▲" : "▼"));
    th.addEventListener("click", () => {
      if (v.sortKey === c.key) v.sortAsc = !v.sortAsc;
      else { v.sortKey = c.key; v.sortAsc = c.key === "name" || c.key === "rank"; }
      v.page = 1;
      renderHoldingsTable();
    });
    return th;
  });
  headCells.push(el("th", { class: "num", title: "5% 이상 대량보유 보고 스냅샷 기준" }, "최근 보고 지분율"));

  const tbody = el("tbody");
  pageRows.forEach((s) => {
    const stake = stakes.get(normalizeName(s.name));
    tbody.append(el("tr", {},
      el("td", { class: "num" }, String(s.rank)),
      el("td", {}, s.name),
      el("td", { class: "num" }, fmtValue100m(s.value_100m)),
      el("td", { class: "num" }, s.weight_pct.toFixed(2)),
      el("td", { class: "num" }, s.ownership_pct.toFixed(2)),
      el("td", { class: "num" },
        stake ? `${stake.ownership_pct.toFixed(2)}% (${stake.report_date})` : "—")));
  });

  box.append(el("div", { class: "table-wrap" },
    el("table", { class: "data-table" }, el("thead", {}, el("tr", {}, headCells)), tbody)));

  // 페이지네이션
  const prev = el("button", { disabled: v.page <= 1 ? "" : null }, "이전");
  prev.addEventListener("click", () => { v.page -= 1; renderHoldingsTable(); });
  const next = el("button", { disabled: v.page >= pages ? "" : null }, "다음");
  next.addEventListener("click", () => { v.page += 1; renderHoldingsTable(); });
  pag.append(prev,
    el("span", {}, `${v.page} / ${pages} 페이지 · ${fmtInt(rows.length)}종목`),
    next);
}

/* ------------------------------------------------------ 푸터 */
function renderFooterDates() {
  const node = $("footer-dates");
  const parts = [];
  if (state.allocation && !state.allocation.empty) {
    parts.push(`자산배분 ${fmtAsOf(state.allocation.as_of)} 기준`);
  }
  if (state.holdings && !state.holdings.empty) {
    parts.push(`보유종목 ${state.holdings.as_of || "기준일 미상"} 기준`);
  }
  if (state.majorStakes && !state.majorStakes.empty) {
    parts.push(`대량보유 스냅샷 ${state.majorStakes.as_of || "기준일 미상"} 기준`);
  }
  node.textContent = parts.length ? `데이터 기준일 — ${parts.join(" · ")}` : "";
}

/* ============================================================ 상호작용 */

function bindViewToggles() {
  document.querySelectorAll(".view-toggle").forEach((toggle) => {
    const target = toggle.dataset.target;
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        const showChart = btn.dataset.view === "chart";
        $(`${target}-chart`).hidden = !showChart;
        $(`${target}-table`).hidden = showChart;
      });
    });
  });
}

function bindDaysToggle() {
  const toggle = $("days-toggle");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (days === state.days) return;
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.days = days;
      state.filingsShown = 30;
      // 재조회 중 이전 렌더를 낮은 불투명도로 유지
      const body = $("trends-body");
      body.classList.add("is-loading");
      try {
        const { body: data } = await fetchJSON(`/api/trends?days=${days}`);
        state.trends = data;
      } finally {
        body.classList.remove("is-loading");
      }
      renderTrends();
      renderKPIs();
      renderBadges();
    });
  });
}

/* ------------------------------------------------------ 데이터 갱신 */
let pollTimer = null;

function setProgress(status) {
  const bar = $("refresh-progress");
  bar.hidden = false;
  $("refresh-step").textContent = status.step || "진행 중";
  const fill = $("progress-fill");
  if (status.total > 0) {
    fill.classList.remove("indeterminate");
    fill.style.width = `${Math.round((status.done / status.total) * 100)}%`;
    $("refresh-count").textContent = `${status.done}/${status.total}`;
  } else {
    fill.classList.add("indeterminate");
    $("refresh-count").textContent = "";
  }
}

function endProgress() {
  $("refresh-progress").hidden = true;
  $("refresh-btn").disabled = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function showToast(msg, ms = 3500) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, ms);
}

function setLastFinished(iso) {
  if (!iso) return;
  $("last-finished").hidden = false;
  $("last-finished").textContent = `마지막 갱신 ${iso.replace("T", " ").slice(0, 16)}`;
}

async function pollRefreshStatus() {
  const { body: status } = await fetchJSON("/api/refresh/status");
  if (status.running) {
    setProgress(status);
    return;
  }
  endProgress();
  setLastFinished(status.last_finished);
  if (status.error) showToast(`갱신 중 오류: ${status.error}`, 6000);
  else showToast("데이터 갱신 완료");
  await loadAll();
}

function bindRefresh() {
  $("refresh-btn").addEventListener("click", async () => {
    const btn = $("refresh-btn");
    btn.disabled = true;
    const { status, body } = await fetchJSON("/api/refresh", { method: "POST" });
    if (status === 409) {
      showToast("이미 갱신이 실행 중입니다");
      // 진행 중인 갱신을 따라간다
    } else if (status !== 200) {
      showToast(body.error || "갱신을 시작하지 못했습니다", 5000);
      btn.disabled = false;
      return;
    }
    setProgress({ step: "준비 중", done: 0, total: 0 });
    pollTimer = setInterval(pollRefreshStatus, 1000);
  });
}

/* ============================================================ 초기화 */
async function loadAll() {
  const [h, a, m, t] = await Promise.all([
    fetchJSON("/api/holdings"),
    fetchJSON("/api/allocation"),
    fetchJSON("/api/major-stakes"),
    fetchJSON(`/api/trends?days=${state.days}`),
  ]);
  state.holdings = h.body;
  state.allocation = a.body;
  state.majorStakes = m.body;
  state.trends = t.body;

  renderBadges();
  renderKPIs();
  renderAllocation();
  renderTrends();
  renderHoldings();
  renderFooterDates();
}

async function init() {
  bindViewToggles();
  bindDaysToggle();
  bindRefresh();
  await loadAll();
  // 페이지 로드 시 이미 갱신이 돌고 있으면 따라간다
  const { body: status } = await fetchJSON("/api/refresh/status");
  if (status.running) {
    $("refresh-btn").disabled = true;
    setProgress(status);
    pollTimer = setInterval(pollRefreshStatus, 1000);
  } else {
    setLastFinished(status.last_finished);
  }
}

const searchInput = $("holdings-search");
searchInput.addEventListener("input", () => {
  state.holdingsView.query = searchInput.value.trim();
  state.holdingsView.page = 1;
  renderHoldingsTable();
});

init();
