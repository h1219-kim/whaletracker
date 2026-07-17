/* WhaleTracker 대시보드 렌더러 (바닐라 JS, 외부 의존성 없음)
   dataviz 규칙: 얇은 마크·2px 표면 갭·헤어라인 그리드·선별적 직접 라벨·
   호버 툴팁 기본 제공·모든 차트에 테이블 대체 뷰·텍스트는 텍스트 토큰. */
"use strict";

const state = {
  holdings: null,
  allocation: null,
  majorStakes: null,
  trends: null,
  pensionFlow: null,
  pensionStockFlow: null,
  usHoldings: null,
  returns: null,
  returnsMarket: "kospi",
  stockFlow: null,
  microStock: "000660",
  microMode: "raw",
  microScale: "daily", // daily=일별 막대, cum=누적 선
  returnsL: 3,   // 신호 누적일 (강건성 검증 상위 조합 기본값)
  returnsR: 5,   // 리밸런싱 주기 (5 = 주 1회)
  returnsN: 10,  // 종목 수
  returnsWindow: "3m",
  buildMeta: null,
  days: 90,
  pensionMarket: "kospi",
  pensionWindow: "1m",
  holdingsView: { query: "", sortKey: "rank", sortAsc: true, page: 1, perPage: 25 },
  usView: { query: "", sortKey: "value_usd", sortAsc: false, page: 1, perPage: 25 },
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

// USD: $131.7B / $942M / $12K
function fmtUsd(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

// 억원 순매수: +2,118억 / −950억
function fmtEok(v) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${fmtInt(Math.abs(v))}억`;
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
// 정적 사이트(GitHub Pages 등)로 구울 때는 서버 API가 없으므로
// 빌드 시 index.html에 window.WHALE_STATIC=true 를 주입하고,
// API 경로를 미리 구운 JSON 파일 경로로 바꾼다.
const STATIC_MODE = window.WHALE_STATIC === true;

const STATIC_MAP = {
  "/api/holdings": "data/holdings.json",
  "/api/allocation": "data/allocation.json",
  "/api/major-stakes": "data/major_stakes.json",
  "/api/pension-flow": "data/pension_flow.json",
  "/api/pension-stock-flow": "data/pension_stock_flow.json",
  "/api/us-holdings": "data/us_holdings.json",
  "/api/returns": "data/returns.json",
  "/api/build-meta": "data/build_meta.json",
  "/api/stock-flow": "data/stock_flow.json",
};

function apiPath(url) {
  if (!STATIC_MODE) return url;
  if (url.startsWith("/api/trends")) {
    const q = url.split("?")[1] || "";
    const days = new URLSearchParams(q).get("days") || "90";
    return `data/trends_${days}.json`;
  }
  return STATIC_MAP[url] || url;
}

async function fetchJSON(url, opts) {
  try {
    const res = await fetch(apiPath(url), opts);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    // 서버 미기동/네트워크 오류 — 빈 상태로 렌더하고 죽지 않는다
    return { status: 0, body: { empty: true, error: String(e) } };
  }
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
  // 차트가 숨겨져 있으면(테이블 뷰) 폭이 0이므로 측정하지 않는다
  requestAnimationFrame(() => {
    bar.querySelectorAll(".seg").forEach((seg) => {
      if (seg.clientWidth === 0) return;
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
    "같은 매매가 대량보유·주요주주 공시로 겹치면 더 넓게 포착한 쪽만 집계(이중 계상 방지)";
}

function renderDiverging() {
  const chartBox = clear($("diverging-chart"));
  const tableBox = clear($("diverging-table"));
  const t = state.trends;

  const buys = (t && t.top_buys) || [];
  const sells = (t && t.top_sells) || [];
  if (!t || t.empty || (!buys.length && !sells.length)) {
    chartBox.append(el("div", { class: "placeholder" },
      t && !t.empty ? "이 기간에 집계된 지분 변동 공시가 없습니다."
                    : "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  // 위→아래: 순매수 큰 순 → 순매도 큰 순(맨 아래가 최대 매도)
  const rows = [...buys, ...[...sells].sort((a, b) => b.delta_ratio - a.delta_ratio)];
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
        tooltipRow("집계 기준", r.basis === "exec" ? "주요주주 공시" : "대량보유 공시"),
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
    } else if (f.parse_ok && f.curr && f.curr.ratio !== null && f.curr.ratio !== undefined) {
      // 최초 보고 — 직전 보고가 없어 증감은 미상
      ratioCell.append(el("span", {}, `신규 보고 → ${f.curr.ratio.toFixed(2)}%`));
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
    `평가액 합계 ${fmtValue100m(h.total_value_100m)}` +
    (h.as_of === "2024-12-31" ? " · 2025년 말 데이터는 2026년 9월 공개 예정" : "");
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

/* ------------------------------------------------- 연기금 일별 순매수 */
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderPensionFlow() {
  const chartBox = clear($("pension-flow-chart"));
  const tableBox = clear($("pension-flow-table"));
  const caption = $("pension-flow-caption");

  const pf = state.pensionFlow;
  const rows = pf && !pf.empty && pf.markets ? pf.markets[state.pensionMarket] || [] : [];
  if (!rows.length) {
    caption.textContent = "";
    chartBox.append(el("div", { class: "placeholder" }, "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  const sum = (n) => rows.slice(-n).reduce((s, r) => s + r.pension, 0);
  caption.textContent =
    `연기금등 순매수 (억원) · 최근 ${rows.length}거래일 · ` +
    `5일 누적 ${fmtEok(sum(5))} · 20일 누적 ${fmtEok(sum(20))}`;

  // SVG 컬럼 차트 — 양수(매수)=빨강, 음수(매도)=파랑, 0 기준선
  const W = 960, plotH = 190, axisH = 24, padL = 56, padR = 8, padT = 8;
  const H = padT + plotH + axisH;
  const plotW = W - padL - padR;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pension)), 1);
  const { max: ymax, ticks } = niceScale(maxAbs, 2);
  const y = (v) => padT + plotH / 2 - (v / ymax) * (plotH / 2);
  const slot = plotW / rows.length;
  const barW = Math.min(24, Math.max(2, slot - 2)); // 2px 표면 갭

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "연기금 일별 순매수 차트" });

  // 그리드 (헤어라인 실선) + y 눈금
  for (const t of [...ticks.map((v) => -v), 0, ...ticks]) {
    const line = svgEl("line", {
      x1: padL, x2: W - padR, y1: y(t), y2: y(t),
      stroke: t === 0 ? "var(--baseline)" : "var(--grid)", "stroke-width": 1,
    });
    svg.append(line);
    const label = svgEl("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end", class: "svg-tick" });
    label.textContent = t === 0 ? "0" : `${t > 0 ? "+" : "−"}${fmtInt(Math.abs(t))}`;
    svg.append(label);
  }

  rows.forEach((r, i) => {
    const cx = padL + slot * i + slot / 2;
    const positive = r.pension >= 0;
    const h = Math.abs(r.pension) / ymax * (plotH / 2);
    const bar = svgEl("rect", {
      x: cx - barW / 2,
      y: positive ? y(r.pension) : y(0),
      width: barW,
      height: Math.max(h, r.pension === 0 ? 0 : 1),
      fill: positive ? "var(--buy)" : "var(--sell)",
      rx: 2,
    });
    svg.append(bar);
    // x 라벨: 대략 10일 간격
    if (i % 10 === 0 || i === rows.length - 1) {
      const label = svgEl("text", { x: cx, y: padT + plotH + 16, "text-anchor": "middle", class: "svg-tick" });
      label.textContent = r.date.slice(5).replace("-", ".");
      svg.append(label);
    }
    // 히트 타깃(슬롯 전체 높이) + 툴팁
    const hit = svgEl("rect", {
      x: padL + slot * i, y: padT, width: slot, height: plotH, fill: "transparent",
    });
    hit.style.cursor = "default";
    bindTooltip(hit, (e) =>
      showTooltip(e, r.date, [
        tooltipRow("연기금등", fmtEok(r.pension) + "원", positive ? "var(--buy)" : "var(--sell)"),
        tooltipRow("개인", fmtEok(r.individual) + "원"),
        tooltipRow("외국인", fmtEok(r.foreign) + "원"),
        tooltipRow("기관계", fmtEok(r.inst_total) + "원"),
      ]));
    svg.append(hit);
  });

  chartBox.append(svg);
  chartBox.append(el("div", { class: "legend" },
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--buy)" }), "순매수"),
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--sell)" }), "순매도")));

  // 테이블 대체 뷰 (최신순)
  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "날짜"), el("th", { class: "num" }, "연기금등(억)"),
      el("th", { class: "num" }, "개인(억)"), el("th", { class: "num" }, "외국인(억)"),
      el("th", { class: "num" }, "기관계(억)"))),
    el("tbody", {}, [...rows].reverse().map((r) =>
      el("tr", {},
        el("td", {}, r.date),
        el("td", { class: `num ${deltaClass(r.pension)}` }, fmtEok(r.pension)),
        el("td", { class: "num" }, fmtEok(r.individual)),
        el("td", { class: "num" }, fmtEok(r.foreign)),
        el("td", { class: "num" }, fmtEok(r.inst_total))))));
  tableBox.append(el("div", { class: "table-wrap" }, table));
}

function bindPensionMarketToggle() {
  const toggle = $("pension-market-toggle");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.market === state.pensionMarket) return;
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.pensionMarket = btn.dataset.market;
      renderPensionFlow();
      renderPensionStock();
      renderStalenessBanner();
    });
  });
}

/* --------------------------------------- 연기금 종목별 순매수·매도 */
function bindPensionWindowToggle() {
  const toggle = $("pension-window-toggle");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.window === state.pensionWindow) return;
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.pensionWindow = btn.dataset.window;
      renderPensionStock();
      renderStalenessBanner();
    });
  });
}

function renderPensionStock() {
  const chartBox = clear($("pension-stock-chart"));
  const tableBox = clear($("pension-stock-table"));
  const caption = $("pension-stock-caption");

  const psf = state.pensionStockFlow;
  const win = psf && !psf.empty && psf.windows
    ? psf.windows.find((w) => w.key === state.pensionWindow) : null;
  const mkt = win ? win.markets[state.pensionMarket] : null;
  if (!mkt || (!mkt.buys.length && !mkt.sells.length)) {
    caption.textContent = "";
    chartBox.append(el("div", { class: "placeholder" }, "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }
  caption.textContent = `${win.start} ~ ${win.end} 누적 순매수 대금 기준 · 출처: KRX`;

  // 다이버징 가로 바 — 순매수 상위 10 / 순매도 상위 10 (억원)
  const rows = [
    ...mkt.buys.slice(0, 10),
    ...mkt.sells.slice(0, 10).reverse(), // 아래로 갈수록 매도 규모 확대
  ].map((r) => ({ ...r, eok: r.net_value / 1e8 }));
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.eok)));
  const { max: xmax, ticks } = niceScale(maxAbs, 3);

  const names = el("div", { class: "hchart-names" });
  const plot = el("div", { class: "hchart-plot" });
  const xpos = (v) => 50 + (v / xmax) * 50;
  plot.append(el("div", { class: "gridline zero", style: "left:50%" }));
  ticks.forEach((tk) => {
    plot.append(el("div", { class: "gridline", style: `left:${xpos(tk)}%` }));
    plot.append(el("div", { class: "gridline", style: `left:${xpos(-tk)}%` }));
  });

  rows.forEach((r) => {
    names.append(el("div", { class: "hchart-name", title: r.name }, r.name));
    const positive = r.eok >= 0;
    const w = (Math.abs(r.eok) / xmax) * 50;
    const row = el("div", { class: "hchart-row" });
    row.append(el("div", {
      class: `hbar${positive ? "" : " neg"}`,
      style: `left:${positive ? 50 : 50 - w}%; width:${w}%; background:${positive ? "var(--buy)" : "var(--sell)"}`,
    }));
    row.append(el("div", {
      class: "hbar-value",
      style: positive ? `left:calc(${50 + w}% + 6px)` : `right:calc(${50 + w}% + 6px); left:auto`,
    }, fmtEok(Math.round(r.eok))));
    const hit = el("div", { class: "hbar-hit" });
    bindTooltip(hit, (e) =>
      showTooltip(e, r.name, [
        tooltipRow("순매수 대금", fmtEok(Math.round(r.eok)) + "원",
          positive ? "var(--buy)" : "var(--sell)"),
        tooltipRow("순매수 수량", fmtDeltaShares(r.net_shares)),
        tooltipRow("기간", `${win.label} (${win.start}~${win.end})`),
      ]));
    row.append(hit);
    plot.append(row);
  });

  const axis = el("div", { class: "hchart-axis" });
  axis.append(el("span", { style: "left:50%" }, "0"));
  ticks.forEach((tk) => {
    axis.append(el("span", { style: `left:${xpos(tk)}%` }, `+${fmtInt(tk)}억`));
    axis.append(el("span", { style: `left:${xpos(-tk)}%` }, `−${fmtInt(tk)}억`));
  });
  chartBox.append(el("div", { class: "hchart" },
    el("div", { class: "hchart-grid" }, names, plot),
    el("div", { class: "hchart-grid" }, el("div"), axis)));
  chartBox.append(el("div", { class: "legend" },
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--buy)" }), "순매수"),
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--sell)" }), "순매도")));

  // 테이블 대체 뷰 — 상위 20 + 20 전체
  const mkRows = (list) => list.map((r) =>
    el("tr", {},
      el("td", {}, r.name),
      el("td", { class: "num" }, r.code),
      el("td", { class: `num ${deltaClass(r.net_value)}` }, fmtEok(Math.round(r.net_value / 1e8))),
      el("td", { class: "num" }, fmtDeltaShares(r.net_shares))));
  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "종목"), el("th", { class: "num" }, "코드"),
      el("th", { class: "num" }, "순매수 대금(억)"), el("th", { class: "num" }, "순매수 수량"))),
    el("tbody", {}, [...mkt.buys, ...mkt.sells].map((r) => mkRows([r])[0])));
  tableBox.append(el("div", { class: "table-wrap" }, table));
}

/* --------------------------------------- 연기금 따라 투자 수익률 */
const RETURN_SERIES = [
  { key: "strategy", label: "일별 추종 전략", color: "var(--s5)",
    desc: "N일 신호로 상위 종목을 골라 주기적으로 갈아탐 (파라미터 조절 가능)" },
  { key: "snapshot", label: "스냅샷 (사서 보유)", color: "var(--s1)",
    desc: "시작일에 사서 그대로 보유" },
  { key: "continuous", label: "연속 (매일 따라매매)", color: "var(--s2)",
    desc: "매일 연기금 매매를 따라감(보유 없는 종목 매도는 무시)" },
  { key: "benchmark", label: "지수 (벤치마크)", color: "var(--muted)",
    desc: "그냥 지수를 샀다면" },
];

// 선택된 파라미터의 전략 곡선을 window 객체에 얹어준다
function strategyCurve(w) {
  if (!w || !w.strategies) return null;
  const key = `L${state.returnsL}_R${state.returnsR}_N${state.returnsN}`;
  return w.strategies[key] || null;
}

function currentReturnsWindow() {
  const r = state.returns;
  if (!r || r.empty || !r.markets) return null;
  const m = r.markets[state.returnsMarket];
  if (!m || !m.windows) return null;
  return m.windows[state.returnsWindow] || null;
}

function bindReturnsToggles() {
  const mkt = $("returns-market-toggle");
  mkt.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.market === state.returnsMarket) return;
      mkt.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.returnsMarket = btn.dataset.market;
      renderReturns();
    });
  });
  const win = $("returns-window-toggle");
  win.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.window === state.returnsWindow) return;
      win.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.returnsWindow = btn.dataset.window;
      renderReturns();
    });
  });
}

function bindParamToggles() {
  const bind = (id, attr, key) => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = Number(btn.dataset[attr]);
        if (val === state[key]) return;
        box.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        state[key] = val;
        renderReturns();
      });
    });
  };
  bind("param-lookback", "l", "returnsL");
  bind("param-rebalance", "r", "returnsR");
  bind("param-topn", "n", "returnsN");
}

/* 강건성 검증 표 — 여러 구간에서 조합이 일관되게 통했는지 (매일 재계산) */
function renderRobustness() {
  const box = clear($("robustness-table"));
  const caption = $("robustness-caption");
  const verdict = $("robustness-verdict");
  clear(verdict);

  const r = state.returns;
  const market = r && !r.empty && r.markets ? r.markets[state.returnsMarket] : null;
  const rob = market && market.robustness ? market.robustness : [];
  if (!rob.length) {
    caption.textContent = "";
    box.append(el("div", { class: "placeholder" }, "검증 데이터가 없습니다."));
    return;
  }

  const cfg = r.robust_config || {};
  const nWindows = rob[0].windows;
  caption.textContent =
    `최근 ${Math.round((cfg.history_days || 365) / 30)}개월을 ` +
    `${Math.round((cfg.window_days || 91) / 30)}개월 구간 ${nWindows}개로 나눠 조합별 성과의 일관성을 검증 ` +
    `(데이터 갱신 때마다 다시 계산)`;

  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "신호"), el("th", {}, "리밸런싱"),
      el("th", { class: "num" }, "평균 초과"), el("th", { class: "num" }, "표준편차"),
      el("th", { class: "num" }, "승률"), el("th", {}, "판정"))),
    el("tbody", {}, rob.map((x, i) =>
      el("tr", { class: i === 0 && x.consistent ? "robust-row-best" : "" },
        el("td", {}, `${x.lookback}일`),
        el("td", {}, x.rebalance === 1 ? "매일" : "주 1회"),
        el("td", { class: `num ${deltaClass(x.mean_alpha)}` }, fmtPp(x.mean_alpha)),
        el("td", { class: "num" }, `${x.stdev.toFixed(1)}%p`),
        el("td", { class: "num" }, `${x.win_rate.toFixed(0)}%`),
        el("td", {}, x.consistent
          ? el("span", { class: "robust-consistent" }, "★ 일관적 우수")
          : el("span", { class: "no-parse" }, "—"))))));
  box.append(el("div", { class: "table-wrap" }, table));

  const consistent = rob.filter((x) => x.consistent);
  const mktName = state.returnsMarket === "kospi" ? "코스피" : "코스닥";
  if (consistent.length) {
    verdict.append(
      el("b", { class: "verdict-good" }, `${mktName}: 일관적으로 우수한 조합 ${consistent.length}개`),
      ` — 여러 구간에서 반복적으로 지수를 이겼습니다(승률 70%+ & 평균 초과 양수). ` +
      `다만 구간이 서로 겹쳐 독립 표본이 아니고, 거래비용·슬리피지를 무시했으므로 과신은 금물입니다.`);
  } else {
    verdict.append(
      el("b", { class: "verdict-bad" }, `${mktName}: 일관적으로 우수한 조합 없음`),
      ` — 어떤 파라미터도 여러 구간에서 꾸준히 지수를 이기지 못했습니다. ` +
      `특정 조합이 좋아 보여도 그 구간에 우연히 맞은 것(과적합)일 가능성이 큽니다.`);
  }
}

function fmtPct(v) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function fmtPp(v) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%p`;
}

function renderReturns() {
  const caption = $("returns-caption");
  const summaryBox = clear($("returns-summary"));
  const chartBox = clear($("returns-chart"));
  const tableBox = clear($("returns-table"));
  const basketBox = clear($("returns-basket"));

  const win = currentReturnsWindow();
  if (!win || !win.dates || !win.dates.length) {
    caption.textContent = "";
    chartBox.append(el("div", { class: "placeholder" },
      "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  // 선택된 파라미터의 전략 곡선을 얹는다 (차트·테이블이 RETURN_SERIES를 순회)
  win.strategy = strategyCurve(win) || [];
  const stratRet = win.strategy.length ? win.strategy[win.strategy.length - 1] : 0;
  const benchRet = win.benchmark.length ? win.benchmark[win.benchmark.length - 1] : 0;
  const stratAlpha = stratRet - benchRet;

  const s = win.summary;
  const rebalLabel = state.returnsR === 1 ? "매일" : "주 1회";
  caption.textContent =
    `${win.start} ~ ${state.returns.as_of} · ${win.dates.length}거래일 · ` +
    `전략: 최근 ${state.returnsL}일 신호로 상위 ${state.returnsN}종목, ${rebalLabel} 리밸런싱`;

  // 요약 KPI: 전략(주인공) + 지수 + 참고 2방식
  const tile = (label, value, sub, cls) =>
    el("div", { class: "stat-tile" },
      el("div", { class: "stat-label" }, label),
      el("div", { class: `stat-value ${cls || ""}` }, value),
      el("div", { class: "stat-sub" }, sub));
  summaryBox.append(
    tile("일별 추종 전략", fmtPct(stratRet),
      `지수 대비 ${fmtPp(stratAlpha)}`, deltaClass(stratRet)),
    tile("지수 (벤치마크)", fmtPct(benchRet),
      state.returnsMarket === "kospi" ? "KOSPI" : "코스닥", deltaClass(benchRet)),
    tile("스냅샷 (참고)", fmtPct(s.snapshot_return),
      `지수 대비 ${fmtPp(s.snapshot_alpha)}`, deltaClass(s.snapshot_return)),
    tile("판정", stratAlpha > 0 ? "지수 상회" : "지수 하회",
      "선택한 전략 기준", stratAlpha > 0 ? "delta-buy" : "delta-sell"));

  chartBox.append(buildReturnsChart(win));

  // 범례 (3시리즈)
  const legend = el("div", { class: "legend" });
  RETURN_SERIES.forEach((se) => {
    legend.append(el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: `background:${se.color}` }), se.label));
  });
  chartBox.append(legend);

  // 바스켓 5종목
  const bt = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "종목"), el("th", { class: "num" }, "코드"),
      el("th", { class: "num" }, "비중"), el("th", { class: "num" }, "당시 순매수"))),
    el("tbody", {}, (win.basket || []).map((b) =>
      el("tr", {},
        el("td", {}, b.name),
        el("td", { class: "num" }, b.code),
        el("td", { class: "num" }, `${(b.weight * 100).toFixed(1)}%`),
        el("td", { class: "num" }, `${fmtInt(b.buy_value_100m)}억`)))));
  basketBox.append(el("div", { class: "table-wrap" }, bt));

  // 테이블 대체 뷰 (날짜별 네 값)
  const rows = win.dates.map((d, i) =>
    el("tr", {},
      el("td", {}, d),
      el("td", { class: `num ${deltaClass(win.strategy[i] ?? 0)}` }, fmtPct(win.strategy[i] ?? 0)),
      el("td", { class: `num ${deltaClass(win.snapshot[i])}` }, fmtPct(win.snapshot[i])),
      el("td", { class: `num ${deltaClass(win.continuous[i])}` }, fmtPct(win.continuous[i])),
      el("td", { class: `num ${deltaClass(win.benchmark[i])}` }, fmtPct(win.benchmark[i]))));
  tableBox.append(el("div", { class: "table-wrap" },
    el("table", { class: "data-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "날짜"), el("th", { class: "num" }, "전략"),
        el("th", { class: "num" }, "스냅샷"),
        el("th", { class: "num" }, "연속"), el("th", { class: "num" }, "지수"))),
      el("tbody", {}, rows.reverse()))));

  // 파라미터 설명 + 강건성 검증 표
  const stratCap = $("strategy-caption");
  if (stratCap) {
    stratCap.textContent =
      "최근 N일 연기금 누적 순매수 상위 종목을 주기적으로 갈아탑니다(롱온리·종가 매매). " +
      "파라미터를 바꾸면 위 차트의 '일별 추종 전략' 곡선이 즉시 바뀝니다.";
  }
  renderRobustness();
}

function buildReturnsChart(win) {
  const W = 960, H = 300, padL = 52, padR = 14, padT = 14, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = win.dates.length;

  const all = [...(win.strategy || []), ...win.snapshot, ...win.continuous, ...win.benchmark, 0];
  const lo = Math.min(...all), hi = Math.max(...all);
  const { max: absMax, ticks } = niceScale(Math.max(Math.abs(lo), Math.abs(hi)), 3);
  const yMin = lo < 0 ? -absMax : 0;
  const yMax = hi > 0 ? absMax : 0;
  const span = (yMax - yMin) || 1;

  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - yMin) / span) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": "연기금 따라 투자 누적수익률 곡선",
  });

  // 그리드 + y 눈금 (0선 강조)
  const yTicks = [...new Set([0, ...ticks, ...ticks.map((t) => -t)])]
    .filter((t) => t >= yMin - 1e-9 && t <= yMax + 1e-9);
  yTicks.forEach((t) => {
    svg.append(svgEl("line", {
      x1: padL, x2: W - padR, y1: y(t), y2: y(t),
      stroke: t === 0 ? "var(--baseline)" : "var(--grid)", "stroke-width": 1,
    }));
    const lab = svgEl("text", {
      x: padL - 8, y: y(t) + 4, "text-anchor": "end", class: "svg-tick",
    });
    lab.textContent = `${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(t)}%`;
    svg.append(lab);
  });

  // x 라벨 (시작/중간/끝)
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
    if (i < 0 || i >= n) return;
    const lab = svgEl("text", {
      x: x(i), y: H - 8,
      "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle",
      class: "svg-tick",
    });
    lab.textContent = win.dates[i].slice(2);
    svg.append(lab);
  });

  // 3개 곡선 (2px 선)
  RETURN_SERIES.forEach((se) => {
    const d = win[se.key].map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg.append(svgEl("path", {
      d, fill: "none", stroke: se.color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
      "stroke-dasharray": se.key === "benchmark" ? "" : "",
      opacity: se.key === "benchmark" ? 0.75 : 1,
    }));
  });

  // 크로스헤어 + 호버 툴팁
  const cross = svgEl("line", {
    y1: padT, y2: padT + plotH, stroke: "var(--baseline)", "stroke-width": 1, opacity: 0,
  });
  svg.append(cross);
  const dots = RETURN_SERIES.map((se) => {
    const c = svgEl("circle", { r: 4, fill: se.color, stroke: "var(--surface)", "stroke-width": 2, opacity: 0 });
    svg.append(c);
    return c;
  });

  const hit = svgEl("rect", {
    x: padL, y: padT, width: plotW, height: plotH, fill: "transparent",
  });
  hit.style.cursor = "crosshair";

  const showAt = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((px - padL) / plotW) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("opacity", 1);
    RETURN_SERIES.forEach((se, k) => {
      dots[k].setAttribute("cx", x(i));
      dots[k].setAttribute("cy", y(win[se.key][i]));
      dots[k].setAttribute("opacity", 1);
    });
    showTooltip(evt, win.dates[i], [
      ...RETURN_SERIES.map((se) =>
        tooltipRow(se.label, fmtPct(win[se.key][i]), se.color)),
      tooltipRow("스냅샷이란", "시작일에 사서 그대로 보유"),
      tooltipRow("연속이란", "매일 연기금 매매를 따라감(없는 종목 매도는 무시)"),
    ]);
  };
  hit.addEventListener("pointerenter", showAt);
  hit.addEventListener("pointermove", showAt);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0);
    dots.forEach((d) => d.setAttribute("opacity", 0));
    hideTooltip();
  });
  svg.append(hit);

  return svg;
}

/* ------------------------------------------------- 미국 주식 (13F) */
function renderUsHoldings() {
  renderUsTop();
  renderUsDelta();
  renderUsTable();
  const caption = $("us-caption");
  const us = state.usHoldings;
  if (!us || us.empty) {
    caption.textContent = "";
    return;
  }
  caption.textContent =
    `${us.as_of} 기준 (제출 ${us.filed_date}) · ${fmtInt(us.count)}종목 · ` +
    `총 ${fmtUsd(us.total_value_usd)} · 전분기(${us.prev_as_of}) 대비 신규 ${us.new_count} · 청산 ${us.exited_count}`;
}

function renderUsTop() {
  const box = clear($("us-top-chart"));
  const us = state.usHoldings;
  if (!us || us.empty || !us.holdings) {
    box.append(el("div", { class: "placeholder" }, "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }
  const top = us.holdings.slice(0, 15);
  const maxVal = Math.max(...top.map((h) => h.value_usd));
  const { max: xmax, ticks } = niceScale(maxVal / 1e9, 4); // $B 눈금

  const names = el("div", { class: "hchart-names" });
  const plot = el("div", { class: "hchart-plot" });
  ticks.forEach((tk) => plot.append(el("div", { class: "gridline", style: `left:${(tk / xmax) * 100}%` })));
  plot.append(el("div", { class: "gridline zero", style: "left:0%" }));

  top.forEach((h, i) => {
    names.append(el("div", { class: "hchart-name", title: h.issuer }, h.issuer));
    const w = (h.value_usd / 1e9 / xmax) * 100;
    const row = el("div", { class: "hchart-row" });
    row.append(el("div", { class: "hbar", style: `left:0%; width:${w}%; background:var(--seq)` }));
    if (i < 5) {
      row.append(el("div", { class: "hbar-value", style: `left:calc(${w}% + 6px)` }, fmtUsd(h.value_usd)));
    }
    const hit = el("div", { class: "hbar-hit" });
    bindTooltip(hit, (e) =>
      showTooltip(e, h.issuer, [
        tooltipRow("평가액", fmtUsd(h.value_usd), "var(--seq)"),
        tooltipRow("비중", `${h.weight_pct}%`),
        tooltipRow("주식수", fmtInt(h.shares)),
        tooltipRow("분기 증감", h.delta_shares === null ? "신규 편입" : fmtDeltaShares(h.delta_shares)),
      ]));
    row.append(hit);
    plot.append(row);
  });

  const axis = el("div", { class: "hchart-axis" });
  axis.append(el("span", { style: "left:0%" }, "0"));
  ticks.forEach((tk) => axis.append(el("span", { style: `left:${(tk / xmax) * 100}%` }, `$${tk}B`)));
  box.append(el("div", { class: "hchart" },
    el("div", { class: "hchart-grid" }, names, plot),
    el("div", { class: "hchart-grid" }, el("div"), axis)));
}

// 분기 매매 상위 — 추정 거래대금(Δ주식수 × 평균단가), 신규/청산 포함
function usDeltaRows() {
  const us = state.usHoldings;
  if (!us || us.empty) return [];
  const rows = [];
  for (const h of us.holdings || []) {
    if (h.prev_shares === null) {
      rows.push({ issuer: h.issuer, est_usd: h.value_usd, kind: "신규" });
    } else if (h.delta_shares && h.shares > 0) {
      rows.push({ issuer: h.issuer, est_usd: h.delta_shares * (h.value_usd / h.shares), kind: null });
    }
  }
  for (const x of us.exited || []) {
    rows.push({ issuer: x.issuer, est_usd: -x.prev_value_usd, kind: "청산" });
  }
  const buys = rows.filter((r) => r.est_usd > 0).sort((a, b) => b.est_usd - a.est_usd).slice(0, 8);
  const sells = rows.filter((r) => r.est_usd < 0).sort((a, b) => a.est_usd - b.est_usd).slice(0, 8);
  return [...buys, ...sells.reverse()];
}

function renderUsDelta() {
  const chartBox = clear($("us-delta-chart"));
  const tableBox = clear($("us-delta-table"));
  const rows = usDeltaRows();
  if (!rows.length) {
    chartBox.append(el("div", { class: "placeholder" }, "데이터가 없습니다."));
    return;
  }
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.est_usd)));
  const { max: xmax, ticks } = niceScale(maxAbs / 1e9, 3);

  const names = el("div", { class: "hchart-names" });
  const plot = el("div", { class: "hchart-plot" });
  const xpos = (v) => 50 + (v / xmax) * 50;
  plot.append(el("div", { class: "gridline zero", style: `left:50%` }));
  ticks.forEach((tk) => {
    plot.append(el("div", { class: "gridline", style: `left:${xpos(tk)}%` }));
    plot.append(el("div", { class: "gridline", style: `left:${xpos(-tk)}%` }));
  });

  rows.forEach((r) => {
    names.append(el("div", { class: "hchart-name", title: r.issuer }, r.issuer));
    const positive = r.est_usd >= 0;
    const w = (Math.abs(r.est_usd) / 1e9 / xmax) * 50;
    const row = el("div", { class: "hchart-row" });
    row.append(el("div", {
      class: `hbar${positive ? "" : " neg"}`,
      style: `left:${positive ? 50 : 50 - w}%; width:${w}%; background:${positive ? "var(--buy)" : "var(--sell)"}`,
    }));
    row.append(el("div", {
      class: "hbar-value",
      style: positive ? `left:calc(${50 + w}% + 6px)` : `right:calc(${50 + w}% + 6px); left:auto`,
    }, fmtUsd(r.est_usd) + (r.kind ? ` (${r.kind})` : "")));
    const hit = el("div", { class: "hbar-hit" });
    bindTooltip(hit, (e) =>
      showTooltip(e, r.issuer, [
        tooltipRow("추정 거래대금", fmtUsd(r.est_usd), positive ? "var(--buy)" : "var(--sell)"),
        tooltipRow("구분", r.kind || (positive ? "지분 확대" : "지분 축소")),
      ]));
    row.append(hit);
    plot.append(row);
  });

  const axis = el("div", { class: "hchart-axis" });
  axis.append(el("span", { style: "left:50%" }, "0"));
  ticks.forEach((tk) => {
    axis.append(el("span", { style: `left:${xpos(tk)}%` }, `+$${tk}B`));
    axis.append(el("span", { style: `left:${xpos(-tk)}%` }, `−$${tk}B`));
  });
  chartBox.append(el("div", { class: "hchart" },
    el("div", { class: "hchart-grid" }, names, plot),
    el("div", { class: "hchart-grid" }, el("div"), axis)));
  chartBox.append(el("div", { class: "legend" },
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--buy)" }), "매수(확대·신규)"),
    el("span", { class: "legend-item" },
      el("span", { class: "legend-swatch", style: "background:var(--sell)" }), "매도(축소·청산)")));

  const table = el("table", { class: "data-table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "종목"), el("th", { class: "num" }, "추정 거래대금"), el("th", {}, "구분"))),
    el("tbody", {}, rows.map((r) =>
      el("tr", {},
        el("td", {}, r.issuer),
        el("td", { class: `num ${deltaClass(r.est_usd)}` }, fmtUsd(r.est_usd)),
        el("td", {}, r.kind || (r.est_usd >= 0 ? "지분 확대" : "지분 축소"))))));
  tableBox.append(el("div", { class: "table-wrap" }, table));
}

const US_COLUMNS = [
  { key: "issuer", label: "종목명", num: false },
  { key: "shares", label: "주식수", num: true },
  { key: "value_usd", label: "평가액", num: true },
  { key: "weight_pct", label: "비중(%)", num: true },
  { key: "delta_shares", label: "Δ주식수(분기)", num: true },
];

function renderUsTable() {
  const box = clear($("us-table"));
  const pag = clear($("us-pagination"));
  const us = state.usHoldings;
  if (!us || us.empty || !us.holdings) {
    box.append(el("div", { class: "placeholder" }, "데이터가 없습니다."));
    return;
  }
  const v = state.usView;
  let rows = us.holdings;
  if (v.query) {
    const q = v.query.toLowerCase();
    rows = rows.filter((h) => h.issuer.toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => {
    const x = a[v.sortKey] ?? -Infinity, y = b[v.sortKey] ?? -Infinity;
    const cmp = typeof x === "string" ? x.localeCompare(y) : x - y;
    return v.sortAsc ? cmp : -cmp;
  });
  const pages = Math.max(1, Math.ceil(rows.length / v.perPage));
  if (v.page > pages) v.page = pages;
  const pageRows = rows.slice((v.page - 1) * v.perPage, v.page * v.perPage);

  const headCells = US_COLUMNS.map((c) => {
    const th = el("th", { class: `sortable${c.num ? " num" : ""}` }, c.label);
    if (v.sortKey === c.key) th.append(el("span", { class: "sort-arrow" }, v.sortAsc ? "▲" : "▼"));
    th.addEventListener("click", () => {
      if (v.sortKey === c.key) v.sortAsc = !v.sortAsc;
      else { v.sortKey = c.key; v.sortAsc = c.key === "issuer"; }
      v.page = 1;
      renderUsTable();
    });
    return th;
  });

  const tbody = el("tbody");
  pageRows.forEach((h) => {
    tbody.append(el("tr", {},
      el("td", {}, h.issuer),
      el("td", { class: "num" }, fmtInt(h.shares)),
      el("td", { class: "num" }, fmtUsd(h.value_usd)),
      el("td", { class: "num" }, h.weight_pct.toFixed(2)),
      el("td", { class: `num ${h.delta_shares === null ? "" : deltaClass(h.delta_shares)}` },
        h.delta_shares === null
          ? el("span", { class: "amend-badge" }, "신규")
          : fmtDeltaShares(h.delta_shares))));
  });
  box.append(el("div", { class: "table-wrap" },
    el("table", { class: "data-table" }, el("thead", {}, el("tr", {}, headCells)), tbody)));

  const prev = el("button", { disabled: v.page <= 1 ? "" : null }, "이전");
  prev.addEventListener("click", () => { v.page -= 1; renderUsTable(); });
  const next = el("button", { disabled: v.page >= pages ? "" : null }, "다음");
  next.addEventListener("click", () => { v.page += 1; renderUsTable(); });
  pag.append(prev, el("span", {}, `${v.page} / ${pages} 페이지 · ${fmtInt(rows.length)}종목`), next);
}

/* ------------------------------------------ 수급 현미경 (본주×레버리지) */
const MICRO_SERIES = [
  { key: "individual", label: "개인", color: "var(--s1)" },
  { key: "foreign", label: "외국인", color: "var(--s6)" },
  { key: "institution", label: "기관", color: "var(--s2)" },
];

function microData() {
  const sf = state.stockFlow;
  if (!sf || sf.empty || !sf.stocks) return null;
  return sf.stocks[state.microStock] || null;
}

function cumsum(xs) {
  let acc = 0;
  return xs.map((v) => (acc += v || 0));
}

/* 그날 주가 방향을 '주도'한 주체 — 상승일=최대 순매수, 하락일=최대 순매도.
   반환: [{key, v, up}] (key=null이면 3주체 밖(기타법인 등)이 주도, 방향 미상은 null). */
function microLeaders(d, adj) {
  const flows = {
    individual: adj ? d.individual_adjusted : d.flows.individual,
    foreign: d.flows.foreign,
    institution: d.flows.institution,
  };
  return d.dates.map((_, i) => {
    const prev = i > 0 ? d.close[i - 1] : null, cur = d.close[i];
    if (!prev || !cur || prev === cur) return null; // 첫날·보합은 판정 불가
    const up = cur > prev;
    let key = null, v = 0;
    MICRO_SERIES.forEach((s) => {
      const f = flows[s.key][i] || 0;
      if (up ? f > v : f < v) { key = s.key; v = f; }
    });
    return { key, v, up };
  });
}

function renderMicroscope() {
  const chartBox = clear($("micro-chart"));
  const tableBox = clear($("micro-table"));
  const sumBox = clear($("micro-summary"));
  const prodBox = clear($("micro-products"));
  const caption = $("micro-caption");

  const d = microData();
  if (!d || !d.dates || !d.dates.length) {
    caption.textContent = "";
    chartBox.append(el("div", { class: "placeholder" },
      "데이터가 없습니다. [데이터 갱신]을 눌러 수집하세요."));
    return;
  }

  const adj = state.microMode === "adj";
  const daily = state.microScale === "daily";
  const sm = d.summary;
  caption.textContent =
    `${d.dates[0]} ~ ${d.dates[d.dates.length - 1]} (${d.dates.length}거래일) · ` +
    (daily
      ? "주가 + 투자자별 일별 순매수 — 0선 위 막대가 그날 산 쪽, 아래가 판 쪽"
      : "주가 + 투자자별 누적 순매수 — 기울기가 그날의 매수 주체") +
    " · 캔들 아래 색 띠 = 그날 주가를 주도한 주체" +
    (adj ? " · 보정: 개인에 레버리지 경유 수요 반영(±2배)" : "");

  // 요약 카드
  const indivTotal = adj
    ? sm.individual + d.lever_extra.reduce((a, b) => a + b, 0)
    : sm.individual;
  const tile = (label, v, sub) =>
    el("div", { class: "stat-tile" },
      el("div", { class: "stat-label" }, label),
      el("div", { class: `stat-value ${deltaClass(v)}` }, fmtEok(Math.round(v))),
      el("div", { class: "stat-sub" }, sub));
  sumBox.append(
    tile(adj ? "개인 (실질·보정)" : "개인 (본주)", indivTotal, "90일 누적 순매수"),
    tile("외국인", sm.foreign, "90일 누적 순매수"),
    tile("기관 (LP 헤지 포함)", sm.institution, "90일 누적 순매수"),
    el("div", { class: "stat-tile" },
      el("div", { class: "stat-label" }, "레버리지 개인 유입 / AUM"),
      el("div", { class: "stat-value" }, `${fmtEok(Math.round(sm.lever_inflow))}`),
      el("div", { class: "stat-sub" },
        `현재 잔존 ${fmtInt(sm.lever_aum_100m)}억 (레버리지 ${d.products.filter(p => p.factor > 0).length}종)`)));

  chartBox.append(buildMicroChart(d, adj));

  // 범례 (캔들 데이터가 있으면 양봉/음봉, 없으면 주가 선)
  const hasCandle = Array.isArray(d.open) && d.open.some((v) => v != null);
  const priceLegend = hasCandle
    ? [el("span", { class: "legend-item" },
        el("span", { class: "legend-swatch", style: "background:var(--buy)" }), "양봉(상승)"),
       el("span", { class: "legend-item" },
        el("span", { class: "legend-swatch", style: "background:var(--sell)" }), "음봉(하락)")]
    : [el("span", { class: "legend-item" },
        el("span", { class: "legend-swatch", style: "background:var(--muted)" }), "주가(상단)")];
  chartBox.append(el("div", { class: "legend" },
    ...priceLegend,
    ...MICRO_SERIES.map((s) =>
      el("span", { class: "legend-item" },
        el("span", { class: "legend-swatch", style: `background:${s.color}` }),
        s.key === "individual" && adj ? "개인(실질)" : s.label))));

  // 주도 일수 집계 — "상승일은 누가 주도했나"를 기간 전체로 요약
  const leaders = microLeaders(d, adj);
  const counts = { up: {}, down: {} };
  let upDays = 0, downDays = 0;
  leaders.forEach((L) => {
    if (!L) return;
    if (L.up) upDays += 1; else downDays += 1;
    const box = L.up ? counts.up : counts.down;
    const k = L.key || "other";
    box[k] = (box[k] || 0) + 1;
  });
  const seriesMeta = [
    ...MICRO_SERIES.map((s) => ({
      key: s.key, color: s.color,
      label: s.key === "individual" && adj ? "개인(실질)" : s.label,
    })),
    { key: "other", color: "var(--muted)", label: "기타" },
  ];
  const sideRow = (label, total, obj) =>
    el("div", { class: "legend" },
      el("span", { class: "legend-item" }, `${label} ${total}일 주도 —`),
      ...seriesMeta
        .map((m) => ({ m, c: obj[m.key] || 0 }))
        .filter((x) => x.c > 0)
        .sort((a, b) => b.c - a.c)
        .map((x) =>
          el("span", { class: "legend-item" },
            el("span", { class: "legend-swatch", style: `background:${x.m.color}` }),
            `${x.m.label} ${x.c}일`)));
  chartBox.append(sideRow("상승", upDays, counts.up), sideRow("하락", downDays, counts.down));

  // 연계 상품 목록
  prodBox.append(el("h3", {}, `연계 레버리지·인버스 상품 (자동 탐색, ${d.products.length}개)`));
  prodBox.append(el("div", { class: "table-wrap" },
    el("table", { class: "data-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "상품"), el("th", { class: "num" }, "배수"),
        el("th", { class: "num" }, "현재 AUM"))),
      el("tbody", {}, d.products.map((p) =>
        el("tr", {},
          el("td", {}, p.name),
          el("td", { class: "num" }, p.factor > 0 ? `+${p.factor}x` : `${p.factor}x`),
          el("td", { class: "num" },
            p.aum_100m != null ? `${fmtInt(p.aum_100m)}억` : "—")))))));

  // 테이블 대체 뷰 (최근 30거래일)
  const idxs = d.dates.map((_, i) => i).slice(-30).reverse();
  tableBox.append(el("div", { class: "table-wrap" },
    el("table", { class: "data-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "날짜"), el("th", { class: "num" }, "종가"),
        el("th", {}, "주도"),
        el("th", { class: "num" }, "개인(억)"), el("th", { class: "num" }, "외국인(억)"),
        el("th", { class: "num" }, "기관(억)"), el("th", { class: "num" }, "레버리지경유(억)"),
        el("th", { class: "num" }, "개인 실질(억)"))),
      el("tbody", {}, idxs.map((i) =>
        el("tr", {},
          el("td", {}, d.dates[i]),
          el("td", { class: "num" }, d.close[i] ? fmtInt(d.close[i]) : "—"),
          (() => {
            const L = leaders[i];
            if (!L) return el("td", {}, "—");
            const ls = seriesMeta.find((m) => m.key === (L.key || "other"));
            return el("td", { style: `color:${ls.color}` },
              `${L.up ? "▲" : "▼"} ${ls.label}`);
          })(),
          el("td", { class: `num ${deltaClass(d.flows.individual[i])}` }, fmtEok(d.flows.individual[i])),
          el("td", { class: `num ${deltaClass(d.flows.foreign[i])}` }, fmtEok(d.flows.foreign[i])),
          el("td", { class: `num ${deltaClass(d.flows.institution[i])}` }, fmtEok(d.flows.institution[i])),
          el("td", { class: `num ${deltaClass(d.lever_extra[i])}` }, fmtEok(d.lever_extra[i])),
          el("td", { class: `num ${deltaClass(d.individual_adjusted[i])}` }, fmtEok(d.individual_adjusted[i]))))))));
}

function buildMicroChart(d, adj) {
  const W = 960, priceH = 150, flowH = 190, gap = 26, padL = 60, padR = 14, padT = 10, padB = 26;
  const H = padT + priceH + gap + flowH + padB;
  const n = d.dates.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": "주가와 투자자별 순매수" });

  // ---- 상단: 주가 (캔들 · 시/고/저 없는 옛 데이터면 종가 선으로 폴백) ----
  const hasOHLC = Array.isArray(d.open) && d.open.some((v) => v != null);
  const closes = d.close.map((c) => c || 0);
  const priceVals = closes.filter(Boolean);
  if (hasOHLC) {
    d.high.forEach((v) => { if (v != null) priceVals.push(v); });
    d.low.forEach((v) => { if (v != null) priceVals.push(v); });
  }
  const pLo = Math.min(...priceVals), pHi = Math.max(...priceVals);
  const pSpan = (pHi - pLo) || 1;
  const py = (v) => padT + priceH - ((v - pLo) / pSpan) * priceH;
  [pLo, (pLo + pHi) / 2, pHi].forEach((t) => {
    svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: py(t), y2: py(t),
      stroke: "var(--grid)", "stroke-width": 1 }));
    const lab = svgEl("text", { x: padL - 6, y: py(t) + 4, "text-anchor": "end", class: "svg-tick" });
    lab.textContent = t >= 10000 ? `${Math.round(t / 1000)}천` : fmtInt(t);
    svg.append(lab);
  });
  if (hasOHLC) {
    const slotP = (W - padL - padR) / n;
    const cw = Math.min(14, Math.max(1.5, slotP - 1.5)); // 하단 막대와 같은 폭
    for (let i = 0; i < n; i++) {
      const o = d.open[i], h = d.high[i], l = d.low[i], c = d.close[i];
      if (o == null || h == null || l == null || !c) continue;
      const color = c >= o ? "var(--buy)" : "var(--sell)";
      const cx = x(i);
      svg.append(svgEl("line", { x1: cx.toFixed(1), x2: cx.toFixed(1),
        y1: py(h).toFixed(1), y2: py(l).toFixed(1), stroke: color, "stroke-width": 1 }));
      const bx = Math.min(W - padR - cw, Math.max(padL, cx - cw / 2));
      svg.append(svgEl("rect", { x: bx.toFixed(1),
        y: py(Math.max(o, c)).toFixed(1), width: cw.toFixed(1),
        height: Math.max(Math.abs(py(o) - py(c)), 1).toFixed(1), fill: color }));
    }
  } else {
    svg.append(svgEl("path", {
      d: closes.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${py(v).toFixed(1)}`).join(" "),
      fill: "none", stroke: "var(--muted)", "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }

  // ---- 하단: 투자자별 순매수 (일별=양방향 스택 막대, 누적=선) ----
  const daily = state.microScale === "daily";
  const dailySeries = {
    individual: adj ? d.individual_adjusted : d.flows.individual,
    foreign: d.flows.foreign,
    institution: d.flows.institution,
  };
  const fTop = padT + priceH + gap;

  // ---- 패널 사이 주도 스트립: 상승일=가장 많이 산 주체 색, 하락일=가장 많이 판 주체 색
  const leaders = microLeaders(d, adj);
  const colorOf = Object.fromEntries(MICRO_SERIES.map((s) => [s.key, s.color]));
  const stripY = padT + priceH + 8, stripH = 9;
  const slotS = (W - padL - padR) / n;
  const sw = Math.min(14, Math.max(1.5, slotS - 1.5));
  leaders.forEach((L, i) => {
    if (!L) return;
    const bx = Math.min(W - padR - sw, Math.max(padL, x(i) - sw / 2));
    svg.append(svgEl("rect", {
      x: bx.toFixed(1), y: stripY, width: sw.toFixed(1), height: stripH,
      fill: L.key ? colorOf[L.key] : "var(--muted)",
      opacity: L.key ? 1 : 0.35,
    }));
  });
  const stripLab = svgEl("text", { x: padL - 6, y: stripY + stripH,
    "text-anchor": "end", class: "svg-tick" });
  stripLab.textContent = "주도";
  svg.append(stripLab);

  if (daily) {
    // 하루 = 막대 하나. 산 주체는 0선 위로, 판 주체는 아래로 쌓아
    // "그날 누가 사고 누가 팔았는지"를 주가와 같은 x축에서 바로 대조한다.
    let maxAbs = 1;
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      MICRO_SERIES.forEach((s) => {
        const v = dailySeries[s.key][i] || 0;
        if (v > 0) pos += v; else neg -= v;
      });
      maxAbs = Math.max(maxAbs, pos, neg);
    }
    const { max: ymax, ticks } = niceScale(maxAbs, 2);
    const fy = (v) => fTop + flowH / 2 - (v / ymax) * (flowH / 2);
    for (const t of [...ticks.map((v) => -v), 0, ...ticks]) {
      svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: fy(t), y2: fy(t),
        stroke: t === 0 ? "var(--baseline)" : "var(--grid)", "stroke-width": 1 }));
      const lab = svgEl("text", { x: padL - 6, y: fy(t) + 4, "text-anchor": "end", class: "svg-tick" });
      lab.textContent = t === 0 ? "0" : `${t > 0 ? "+" : "−"}${(Math.abs(t) / 1e4).toFixed(1)}조`;
      svg.append(lab);
    }
    const slot = (W - padL - padR) / n;
    const barW = Math.min(14, Math.max(1.5, slot - 1.5));
    for (let i = 0; i < n; i++) {
      const bx = Math.min(W - padR - barW, Math.max(padL, x(i) - barW / 2));
      let accUp = 0, accDn = 0;
      MICRO_SERIES.forEach((s) => {
        const v = dailySeries[s.key][i] || 0;
        if (!v) return;
        let yTop, yBot;
        if (v > 0) { yTop = fy(accUp + v); yBot = fy(accUp); accUp += v; }
        else { yTop = fy(accDn); yBot = fy(accDn + v); accDn += v; }
        svg.append(svgEl("rect", { x: bx.toFixed(1), y: yTop.toFixed(1),
          width: barW.toFixed(1), height: Math.max(yBot - yTop, 0.5).toFixed(1),
          fill: s.color }));
      });
    }
  } else {
    const series = {
      individual: cumsum(dailySeries.individual),
      foreign: cumsum(dailySeries.foreign),
      institution: cumsum(dailySeries.institution),
    };
    const all = [...series.individual, ...series.foreign, ...series.institution, 0];
    const fLo = Math.min(...all), fHi = Math.max(...all);
    const fSpan = (fHi - fLo) || 1;
    const fy = (v) => fTop + flowH - ((v - fLo) / fSpan) * flowH;
    // 0선 + 상/하한 눈금
    [[0, "var(--baseline)"], [fLo, "var(--grid)"], [fHi, "var(--grid)"]].forEach(([t, c]) => {
      svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: fy(t), y2: fy(t),
        stroke: c, "stroke-width": 1 }));
      const lab = svgEl("text", { x: padL - 6, y: fy(t) + 4, "text-anchor": "end", class: "svg-tick" });
      lab.textContent = `${(t / 1e4).toFixed(1)}조`;
      svg.append(lab);
    });
    MICRO_SERIES.forEach((s) => {
      svg.append(svgEl("path", {
        d: series[s.key].map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${fy(v).toFixed(1)}`).join(" "),
        fill: "none", stroke: s.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    });
  }

  // x축 라벨 (시작/중간/끝)
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
    const lab = svgEl("text", { x: x(i), y: H - 8,
      "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", class: "svg-tick" });
    lab.textContent = d.dates[i].slice(5);
    svg.append(lab);
  });

  // ---- 크로스헤어 (두 패널 관통) ----
  const cross = svgEl("line", { class: "crosshair-line", y1: padT, y2: H - padB, opacity: 0 });
  svg.append(cross);
  const hit = svgEl("rect", { x: padL, y: padT, width: W - padL - padR,
    height: H - padT - padB, fill: "transparent" });
  svg.append(hit);

  const showAt = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("opacity", 1);

    clear(tooltip);
    tooltip.append(el("div", { class: "tt-title" }, d.dates[i]));
    tooltip.append(tooltipRow("종가", d.close[i] ? `${fmtInt(d.close[i])}원` : "—", "var(--muted)"));
    if (d.open && d.open[i] != null) {
      tooltip.append(tooltipRow("시 · 고 · 저",
        `${fmtInt(d.open[i])} · ${fmtInt(d.high[i])} · ${fmtInt(d.low[i])}`));
    }
    if (i > 0 && d.close[i] && d.close[i - 1]) {
      const chg = (d.close[i] / d.close[i - 1] - 1) * 100;
      tooltip.append(tooltipRow("전일比",
        `${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%`,
        chg >= 0 ? "var(--buy)" : "var(--sell)"));
    }
    const L = leaders[i];
    if (L) {
      const ls = MICRO_SERIES.find((s) => s.key === L.key);
      tooltip.append(tooltipRow(L.up ? "상승 주도" : "하락 주도",
        ls
          ? `${L.key === "individual" && adj ? "개인(실질)" : ls.label} ${fmtEok(L.v)}`
          : "기타 주체(3주체 외)",
        ls ? ls.color : "var(--muted)"));
    }
    tooltip.append(tooltipRow(state.microMode === "adj" ? "개인(실질) 당일" : "개인 당일",
      fmtEok(state.microMode === "adj" ? d.individual_adjusted[i] : d.flows.individual[i]), "var(--s1)"));
    tooltip.append(tooltipRow("외국인 당일", fmtEok(d.flows.foreign[i]), "var(--s6)"));
    tooltip.append(tooltipRow("기관 당일", fmtEok(d.flows.institution[i]), "var(--s2)"));
    if (d.lever_extra[i]) {
      tooltip.append(tooltipRow("└ 레버리지 경유", fmtEok(d.lever_extra[i])));
    }
    tooltip.append(el("div", { class: "method-note" },
      state.microScale === "daily"
        ? "0선 위 막대=그날 산 쪽 · 아래=판 쪽 · 기관에는 LP 헤지 물량 포함"
        : "기울기가 가파른 쪽이 그날의 수급 주도자 · 기관에는 LP 헤지 물량 포함"));
    tooltip.hidden = false;
    moveTooltip(evt);
  };
  hit.addEventListener("pointerenter", showAt);
  hit.addEventListener("pointermove", showAt);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0);
    hideTooltip();
  });

  return el("div", { class: "linechart" }, svg);
}

function bindMicroToggles() {
  const stock = $("micro-stock-toggle");
  stock.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.stock === state.microStock) return;
      stock.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.microStock = btn.dataset.stock;
      renderMicroscope();
    });
  });
  const mode = $("micro-mode-toggle");
  mode.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === state.microMode) return;
      mode.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.microMode = btn.dataset.mode;
      renderMicroscope();
    });
  });
  const scale = $("micro-scale-toggle");
  scale.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.scale === state.microScale) return;
      scale.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.microScale = btn.dataset.scale;
      renderMicroscope();
    });
  });
}

/* ------------------------------------------ 데이터 신선도 경고 */
// 소스별 기대 갱신 주기(일). 이보다 오래되면 '예전 데이터'로 간주.
// daily=true(매일 갱신 기대)인 소스만 상단 배너로 경고 — 나머지(분기·월·연)는
// 원래 오래되는 게 정상이라 잘못된 경고를 내지 않는다.
const FRESHNESS = {
  pension_flow:       { days: 3,   section: "pension-flow-section", label: "연기금 일별 순매수", daily: true },
  pension_stock_flow: { days: 3,   section: "pension-flow-section", label: "연기금 종목별 수급", daily: true },
  filings:            { days: 4,   section: "trends-section",       label: "국민연금 매매 공시(DART)", daily: true },
  stock_flow:         { days: 4,   section: "microscope-section",   label: "수급 현미경(본주×레버리지)", daily: true },
  us_holdings:        { days: 100, section: "us-section",           label: "미국 주식 13F", daily: false },
  allocation:         { days: 45,  section: "allocation-section",   label: "자산배분", daily: false },
  // holdings(연 1회)·major_stakes(분기)는 원래 오래되므로 경고 대상 아님
};

function referenceTime() {
  const bm = state.buildMeta;
  // 정적 사이트: 빌드(=배포) 시각 기준. 로컬: 클라이언트 현재 시각 기준.
  if (bm && bm.built_at) {
    const t = new Date(bm.built_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function stalenessReport() {
  const bm = state.buildMeta;
  if (!bm || !bm.sources) return [];
  const ref = referenceTime();
  const errors = bm.errors || {};
  const out = [];
  for (const [src, cfg] of Object.entries(FRESHNESS)) {
    const fa = bm.sources[src];
    if (!fa) continue;
    const t = new Date(fa).getTime();
    if (Number.isNaN(t)) continue;
    const ageDays = (ref - t) / 86400000;
    // DART는 수집 오류 키가 'dart'
    const hasError = src in errors || (src === "filings" && "dart" in errors);
    if (ageDays > cfg.days || hasError) {
      out.push({ src, cfg, fetchedAt: fa, ageDays: Math.max(0, Math.floor(ageDays)), hasError });
    }
  }
  return out;
}

function fmtDateOnly(iso) {
  return (iso || "").slice(0, 10) || "?";
}

function renderStalenessBanner() {
  const banner = $("staleness-banner");
  clear(banner);
  const reports = stalenessReport();
  const daily = reports.filter((r) => r.cfg.daily); // 매일 갱신 기대 소스만 배너
  if (!daily.length) {
    banner.hidden = true;
    markStaleSections(reports);
    return;
  }
  banner.hidden = false;
  banner.append(el("div", { class: "banner-title" },
    "⚠️ 실시간 데이터 수집에 일부 실패했습니다 — 아래 항목은 예전 데이터를 표시 중입니다"));
  const ul = el("ul", {});
  daily.forEach((r) => {
    ul.append(el("li", {},
      `${r.cfg.label} — `,
      el("b", {}, `${fmtDateOnly(r.fetchedAt)} 기준`),
      ` (${r.ageDays}일 전 수집)`));
  });
  banner.append(ul);
  const when = state.buildMeta && state.buildMeta.built_at
    ? `사이트 갱신 시도: ${fmtKst(state.buildMeta.built_at)} (KST)` : "";
  banner.append(el("div", { class: "banner-note" },
    `나머지 항목은 정상 수집되었습니다. 다음 자동 갱신에서 복구되면 자동으로 최신화됩니다. ${when}`));
  markStaleSections(reports);
}

// 해당 섹션 캡션 앞에 '⚠️ N일 전 데이터' 배지 (매일/비매일 모두)
function markStaleSections(reports) {
  document.querySelectorAll(".stale-badge").forEach((e) => e.remove());
  reports.forEach((r) => {
    const sec = document.getElementById(r.cfg.section);
    const cap = sec && sec.querySelector(".card-caption");
    if (cap && !cap.querySelector(".stale-badge")) {
      cap.prepend(el("span", { class: "stale-badge" }, `⚠️ ${r.ageDays}일 전 데이터 · `));
    }
  });
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

/* 섹션 접기/펼치기 — 상태는 localStorage에 저장 */
const COLLAPSE_KEY = "whale.collapsed";
// 기본 접힘: 연 1회 공시라 참고용인 국내주식 보유 현황
const DEFAULT_COLLAPSED = { "holdings-section": true };
// 펼칠 때 실측 기반 렌더(라벨 폭 측정 등)를 다시 수행
const SECTION_RERENDER = {
  "pension-flow-section": () => { renderPensionFlow(); renderPensionStock(); },
  "returns-section": renderReturns,
  "microscope-section": renderMicroscope,
  "trends-section": renderTrends,
  "us-section": renderUsHoldings,
  "allocation-section": renderAllocation,
  "holdings-section": renderHoldings,
};

function initCollapsibles() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}"); } catch (e) { /* 무시 */ }

  document.querySelectorAll("main > section.card").forEach((sec) => {
    const head = sec.querySelector(":scope > .card-head");
    if (!head) return;
    // card-head를 제외한 내용을 .card-body로 감싼다
    const body = el("div", { class: "card-body" });
    [...sec.children].filter((c) => c !== head).forEach((c) => body.append(c));
    sec.append(body);

    const collapsed = sec.id in saved ? !!saved[sec.id] : !!DEFAULT_COLLAPSED[sec.id];
    sec.classList.toggle("collapsed", collapsed);

    const btn = el("button", {
      class: "collapse-btn", type: "button",
      "aria-expanded": String(!collapsed), title: "섹션 접기/펼치기",
    }, collapsed ? "▸" : "▾");
    btn.addEventListener("click", () => {
      const nowCollapsed = sec.classList.toggle("collapsed");
      btn.textContent = nowCollapsed ? "▸" : "▾";
      btn.setAttribute("aria-expanded", String(!nowCollapsed));
      saved[sec.id] = nowCollapsed;
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(saved)); } catch (e) { /* 무시 */ }
      if (!nowCollapsed && SECTION_RERENDER[sec.id]) {
        SECTION_RERENDER[sec.id]();
        renderStalenessBanner();
      }
    });
    head.append(btn);
  });
}

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

let trendsReqSeq = 0; // 기간 토글 연타 시 늦게 온 응답이 최신 상태를 덮지 않도록

function bindDaysToggle() {
  const toggle = $("days-toggle");
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (days === state.days) return;
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      state.days = days;
      state.filingsShown = 30;
      const seq = ++trendsReqSeq;
      // 재조회 중 이전 렌더를 낮은 불투명도로 유지
      const body = $("trends-body");
      body.classList.add("is-loading");
      try {
        const { body: data } = await fetchJSON(`/api/trends?days=${days}`);
        if (seq !== trendsReqSeq) return; // 더 최신 요청이 있음 — 무시
        state.trends = data;
      } finally {
        if (seq === trendsReqSeq) body.classList.remove("is-loading");
      }
      renderTrends();
      renderKPIs();
      renderBadges();
      renderStalenessBanner();
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

// ISO 시각(오프셋 무관)을 한국 시간(KST) 문자열로. GitHub 러너는 UTC라
// 오프셋이 +00:00이지만 절대시각은 같으므로 KST로 변환해 표시한다.
function fmtKst(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 16).replace("T", " ");
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function setLastFinished(iso) {
  if (!iso) return;
  $("last-finished").hidden = false;
  $("last-finished").textContent = `마지막 갱신 ${fmtKst(iso)} (KST)`;
}

async function pollRefreshStatus() {
  const { status: code, body: status } = await fetchJSON("/api/refresh/status");
  if (code === 0) return; // 일시적 네트워크 오류 — 다음 폴링에서 재시도
  if (status.running) {
    setProgress(status);
    return;
  }
  endProgress();
  lastFinishedSeen = status.last_finished || lastFinishedSeen;
  setLastFinished(status.last_finished);
  if (status.error) showToast(`갱신 중 오류: ${status.error}`, 6000);
  else showToast("데이터 갱신 완료");
  await loadAll();
}

function bindRefresh() {
  if (STATIC_MODE) {
    // 정적 사이트에는 수집 서버가 없다 — 갱신 버튼 숨김 (자동 갱신은 GitHub Actions가 담당)
    $("refresh-btn").hidden = true;
    return;
  }
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
  const [h, a, m, t, pf, psf, us, rt, sf, bm] = await Promise.all([
    fetchJSON("/api/holdings"),
    fetchJSON("/api/allocation"),
    fetchJSON("/api/major-stakes"),
    fetchJSON(`/api/trends?days=${state.days}`),
    fetchJSON("/api/pension-flow"),
    fetchJSON("/api/pension-stock-flow"),
    fetchJSON("/api/us-holdings"),
    fetchJSON("/api/returns"),
    fetchJSON("/api/stock-flow"),
    fetchJSON("/api/build-meta"),
  ]);
  state.holdings = h.body;
  state.allocation = a.body;
  state.majorStakes = m.body;
  state.trends = t.body;
  state.pensionFlow = pf.body;
  state.pensionStockFlow = psf.body;
  state.usHoldings = us.body;
  state.returns = rt.body;
  state.stockFlow = sf.body;
  state.buildMeta = bm.body && !bm.body.empty ? bm.body : null;

  renderBadges();
  renderKPIs();
  renderAllocation();
  renderTrends();
  renderPensionFlow();
  renderPensionStock();
  renderMicroscope();
  renderReturns();
  renderHoldings();
  renderUsHoldings();
  renderFooterDates();
  renderStalenessBanner(); // 섹션 캡션이 채워진 뒤 신선도 배지/배너를 얹는다
}

/* 서버 측 자동 갱신 감시 — 5분마다 확인해서 새 데이터가 있으면 다시 그린다 */
let lastFinishedSeen = null;

async function watchServerRefresh() {
  if (pollTimer) return; // 수동 갱신을 이미 따라가는 중
  const { status: code, body: status } = await fetchJSON("/api/refresh/status");
  if (code === 0) return;
  if (status.running) {
    // 자동 갱신이 서버에서 시작됨 — 진행 UI로 따라간다
    $("refresh-btn").disabled = true;
    setProgress(status);
    pollTimer = setInterval(pollRefreshStatus, 1000);
    return;
  }
  if (status.last_finished && status.last_finished !== lastFinishedSeen) {
    lastFinishedSeen = status.last_finished;
    setLastFinished(status.last_finished);
    showToast("데이터가 자동 갱신되었습니다");
    await loadAll();
  }
}

async function init() {
  initCollapsibles();
  bindViewToggles();
  bindDaysToggle();
  bindPensionMarketToggle();
  bindPensionWindowToggle();
  bindReturnsToggles();
  bindParamToggles();
  bindMicroToggles();
  bindRefresh();
  await loadAll();

  if (STATIC_MODE) {
    // 정적 모드: 서버 상태 폴링 없이, 데이터 수집 시각만 표시
    const fetchedAt = (state.pensionFlow && state.pensionFlow.fetched_at)
      || (state.trends && state.trends.fetched_at)
      || (state.allocation && state.allocation.fetched_at);
    if (fetchedAt) setLastFinished(fetchedAt);
    return;
  }

  // 페이지 로드 시 이미 갱신이 돌고 있으면 따라간다
  const { body: status } = await fetchJSON("/api/refresh/status");
  if (status.running) {
    $("refresh-btn").disabled = true;
    setProgress(status);
    pollTimer = setInterval(pollRefreshStatus, 1000);
  } else {
    lastFinishedSeen = status.last_finished || null;
    setLastFinished(status.last_finished);
  }
  setInterval(watchServerRefresh, 5 * 60 * 1000);
}

const searchInput = $("holdings-search");
searchInput.addEventListener("input", () => {
  state.holdingsView.query = searchInput.value.trim();
  state.holdingsView.page = 1;
  renderHoldingsTable();
});

const usSearchInput = $("us-search");
usSearchInput.addEventListener("input", () => {
  state.usView.query = usSearchInput.value.trim();
  state.usView.page = 1;
  renderUsTable();
});

init();
