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
async function fetchJSON(url, opts) {
  try {
    const res = await fetch(url, opts);
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
  const [h, a, m, t, pf, psf, us] = await Promise.all([
    fetchJSON("/api/holdings"),
    fetchJSON("/api/allocation"),
    fetchJSON("/api/major-stakes"),
    fetchJSON(`/api/trends?days=${state.days}`),
    fetchJSON("/api/pension-flow"),
    fetchJSON("/api/pension-stock-flow"),
    fetchJSON("/api/us-holdings"),
  ]);
  state.holdings = h.body;
  state.allocation = a.body;
  state.majorStakes = m.body;
  state.trends = t.body;
  state.pensionFlow = pf.body;
  state.pensionStockFlow = psf.body;
  state.usHoldings = us.body;

  renderBadges();
  renderKPIs();
  renderAllocation();
  renderTrends();
  renderPensionFlow();
  renderPensionStock();
  renderHoldings();
  renderUsHoldings();
  renderFooterDates();
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
  bindViewToggles();
  bindDaysToggle();
  bindPensionMarketToggle();
  bindPensionWindowToggle();
  bindRefresh();
  await loadAll();
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
