"""CLI 진입점: python -m nps_fetcher [--days 180] [--max-new 300]"""

import argparse

from .pipeline import run_refresh


def main():
    parser = argparse.ArgumentParser(description="국민연금 투자 데이터 수집")
    parser.add_argument("--days", type=int, default=180, help="DART 공시 조회 기간(일)")
    parser.add_argument("--max-new", type=int, default=300, help="1회 최대 신규 공시 파싱 수")
    args = parser.parse_args()

    def progress(step, done, total):
        suffix = f" [{done}/{total}]" if total else ""
        print(f"  {step}{suffix}", flush=True)

    result = run_refresh(days=args.days, max_new=args.max_new, progress=progress)
    print()
    print("완료" if result["ok"] else "일부 실패")
    for k, v in result["counts"].items():
        print(f"  {k}: {v}")
    for src, msg in result["errors"].items():
        print(f"  [오류] {src}: {msg}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
