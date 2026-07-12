"""국민연금 투자 동향 데이터 수집 패키지.

공개 파사드 — 웹앱(app.py)은 이 모듈의 심볼에만 의존한다.
"""

from .store import DATA_DIR, load_data, compute_trends
from .pipeline import run_refresh

__all__ = ["DATA_DIR", "load_data", "compute_trends", "run_refresh"]
