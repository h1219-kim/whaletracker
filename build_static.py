# -*- coding: utf-8 -*-
"""정적 사이트 빌드 — site/ 폴더에 '서버 없이' 열 수 있는 대시보드를 굽는다.

GitHub Pages / Cloudflare Pages 같은 정적 호스팅에 그대로 올릴 수 있다.
서버 API(/api/...)가 없으므로, 대신 미리 구운 JSON 파일을 app.js가 fetch한다
(app.js의 STATIC_MODE 참고). refresh 관련 기능은 정적 모드에서 자동으로 숨겨진다.

실행: python build_static.py
로컬 확인: python -m http.server -d site 8000  →  http://localhost:8000
"""

import json
import shutil
from pathlib import Path

from nps_fetcher import store

# 각 데이터셋을 담은 파일명 (fetched_at 신선도 판정용)
DATASET_FILES = {
    "allocation": "allocation.json",
    "holdings": "holdings.json",
    "major_stakes": "major_stakes.json",
    "pension_flow": "pension_flow.json",
    "pension_stock_flow": "pension_stock_flow.json",
    "us_holdings": "us_holdings.json",
    "filings": "filings.json",  # DART (사이트엔 trends로 반영되지만 신선도는 이걸로)
    "returns": "returns.json",
    "stock_flow": "stock_flow.json",
}

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
DATA = ROOT / "data"
STATIC = ROOT / "static"
TEMPLATE = ROOT / "templates" / "index.html"

# 정적 사이트가 실제로 fetch하는 데이터셋 (app.js STATIC_MAP과 일치)
COPY_DATASETS = [
    "holdings", "allocation", "major_stakes",
    "pension_flow", "pension_stock_flow", "us_holdings", "returns", "stock_flow",
]
TREND_DAYS = [30, 90, 180]


def build():
    if SITE.exists():
        shutil.rmtree(SITE)
    (SITE / "data").mkdir(parents=True)

    # 1) 데이터셋 JSON 복사
    missing = []
    for name in COPY_DATASETS:
        src = DATA / f"{name}.json"
        if src.exists():
            shutil.copy(src, SITE / "data" / f"{name}.json")
        else:
            missing.append(name)
    if missing:
        print(f"[경고] 데이터 파일 없음(건너뜀): {', '.join(missing)} "
              f"— 먼저 'python -m nps_fetcher'로 수집하세요.")

    # 2) trends 기간별로 미리 계산해 굽기
    for days in TREND_DAYS:
        trends = store.compute_trends(days)
        with open(SITE / "data" / f"trends_{days}.json", "w", encoding="utf-8") as f:
            json.dump(trends, f, ensure_ascii=False)

    # 3) 정적 자원 복사
    shutil.copy(STATIC / "style.css", SITE / "style.css")
    shutil.copy(STATIC / "app.js", SITE / "app.js")

    # 4) build_meta.json — 신선도 경고의 근거
    #    (사이트 빌드 시각 + 각 소스 수집 시각 + 마지막 수집 실패 내역)
    sources = {}
    for name, fname in DATASET_FILES.items():
        src = DATA / fname
        try:
            sources[name] = json.loads(src.read_text(encoding="utf-8")).get("fetched_at")
        except Exception:
            sources[name] = None
    last_refresh = {}
    lr_path = DATA / ".cache" / "last_refresh.json"
    if lr_path.exists():
        try:
            last_refresh = json.loads(lr_path.read_text(encoding="utf-8"))
        except Exception:
            last_refresh = {}
    build_meta = {
        "built_at": store.now_kst_iso(),
        "sources": sources,
        "errors": last_refresh.get("errors", {}),
        "refreshed_at": last_refresh.get("refreshed_at"),
    }
    with open(SITE / "data" / "build_meta.json", "w", encoding="utf-8") as f:
        json.dump(build_meta, f, ensure_ascii=False, indent=2)

    # 5) index.html 변환 (Flask 템플릿 → 정적)
    html = TEMPLATE.read_text(encoding="utf-8")
    html = html.replace(
        "{{ url_for('static', filename='style.css') }}", "style.css"
    ).replace(
        "{{ url_for('static', filename='app.js') }}", "app.js"
    )
    # 정적 모드 플래그를 app.js보다 먼저 실행되도록 head에 주입
    html = html.replace(
        "</head>",
        "<script>window.WHALE_STATIC=true;</script>\n</head>",
        1,
    )
    (SITE / "index.html").write_text(html, encoding="utf-8")

    n_files = sum(1 for _ in (SITE / "data").glob("*.json"))
    print(f"정적 사이트 생성 완료: {SITE}  (데이터 {n_files}개)")
    print("로컬 확인:  python -m http.server -d site 8000  →  http://localhost:8000")


if __name__ == "__main__":
    build()
