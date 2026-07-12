"""공통 HTTP 유틸 — 타임아웃, 재시도, 요청 간 지연."""

import time

import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
TIMEOUT = 15
RETRIES = 2


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def request_with_retry(session, method, url, *, delay=0.0, **kwargs):
    """delay초 대기 후 요청. 실패 시 지수 백오프로 RETRIES회 재시도."""
    kwargs.setdefault("timeout", TIMEOUT)
    last_err = None
    for attempt in range(RETRIES + 1):
        if delay:
            time.sleep(delay)
        try:
            resp = session.request(method, url, **kwargs)
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:  # 연결/타임아웃/HTTP 오류 모두
            last_err = e
            if attempt < RETRIES:
                time.sleep(1.0 * (2**attempt))
    raise last_err
