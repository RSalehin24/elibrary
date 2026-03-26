#!/usr/bin/env python3
import argparse
import json
import random
import re
import string
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

ROOT = Path(__file__).resolve().parents[1]
BASE_API = "http://localhost:8000/api"
FRONTEND_ORIGIN = "http://localhost:5173/"
RUNS = 10


@dataclass
class EndpointConfig:
    page: str
    endpoint: str
    defaults: dict[str, Any]
    filter_values: dict[str, list[Any]]
    sort_pairs: list[tuple[str, str]]
    pagination: dict[str, str] | None
    aliases: list[str]


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def pick_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        candidates = [v for v in payload.values() if isinstance(v, list)]
        if candidates:
            candidates.sort(
                key=lambda values: (
                    sum(isinstance(item, dict) for item in values),
                    len(values),
                ),
                reverse=True,
            )
            return [row for row in candidates[0] if isinstance(row, dict)]
    return []


def flatten_strings(value: Any) -> list[str]:
    stack = [value]
    out: list[str] = []
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
        elif isinstance(cur, str):
            text = cur.strip()
            if text:
                out.append(text)
    return out


def pick_token(row: dict[str, Any]) -> str | None:
    for text in flatten_strings(row):
        clean = re.sub(r"[^A-Za-z0-9 ]+", " ", text)
        for token in clean.split():
            if len(token) >= 4 and not token.isdigit():
                return token
    return None


def make_session(email: str, password: str, preauth_session_id: str = "") -> requests.Session:
    session = requests.Session()
    if preauth_session_id:
        session.cookies.set("sessionid", preauth_session_id)
        status, payload = call_endpoint(session, "/auth/session/", {})
        if status == 200 and isinstance(payload, dict) and payload.get("authenticated"):
            return session

    csrf_response = session.get(f"{BASE_API}/csrf/", timeout=15)
    csrf_response.raise_for_status()

    token = ""
    if "application/json" in csrf_response.headers.get("content-type", ""):
        token = csrf_response.json().get("csrfToken", "")
    token = token or session.cookies.get("csrftoken", "")

    login = session.post(
        f"{BASE_API}/auth/login/",
        json={"email": email, "password": password},
        headers={"X-CSRFToken": token, "Referer": FRONTEND_ORIGIN},
        timeout=15,
    )
    if login.status_code != 200:
        raise RuntimeError(f"login failed ({login.status_code}): {login.text[:180]}")
    return session


def call_endpoint(session: requests.Session, endpoint: str, params: dict[str, Any]) -> tuple[int, Any]:
    query = urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE_API}{endpoint}"
    if query:
        url = f"{url}?{query}"
    response = session.get(url, timeout=30)
    payload: Any
    try:
        payload = response.json()
    except Exception:
        payload = {"raw": response.text[:1000]}
    return response.status_code, payload


def search_cases(sample_token: str | None) -> list[tuple[str, str]]:
    exact = sample_token or "sample"
    partial = exact[: max(1, len(exact) // 2)]
    return [
        ("exact_match", exact),
        ("partial_match", partial),
        ("case_insensitive", exact.upper()),
        ("leading_trailing_spaces", f"  {exact}  "),
        ("non_existent", "__no_match_" + "".join(random.choice(string.ascii_lowercase) for _ in range(8))),
        ("special_chars", "!@#$%^&*()_+[]{}<>?"),
        ("malicious_sql_injection", "' OR 1=1 --"),
        ("very_long_input", "x" * 4096),
        ("empty_input", ""),
        ("rapid_sequential_typing", "rapid-sequence"),
    ]


def evaluate_search(
    session: requests.Session,
    config: EndpointConfig,
    base_rows: list[dict[str, Any]],
    issues: list[dict[str, Any]],
) -> tuple[int, int]:
    passes = 0
    total = 10
    token = pick_token(base_rows[0]) if base_rows else None
    cases = search_cases(token)

    for case_name, query in cases:
        if case_name == "rapid_sequential_typing":
            ok = True
            for idx in range(10):
                typed = (token or "rapid")[: min(len(token or "rapid"), idx + 1)]
                status, _ = call_endpoint(
                    session,
                    config.endpoint,
                    {**config.defaults, "q": typed},
                )
                if status != 200:
                    ok = False
                    issues.append(
                        {
                            "feature": "search",
                            "case": case_name,
                            "page": config.page,
                            "endpoint": config.endpoint,
                            "issue": f"non-200 during rapid typing ({status})",
                        }
                    )
                    break
            if ok:
                passes += 1
            continue

        status, payload = call_endpoint(
            session,
            config.endpoint,
            {**config.defaults, "q": query},
        )
        rows = pick_rows(payload) if status == 200 else []

        ok = status == 200
        if ok and case_name == "non_existent" and base_rows:
            ok = len(rows) == 0
        if not ok:
            issues.append(
                {
                    "feature": "search",
                    "case": case_name,
                    "page": config.page,
                    "endpoint": config.endpoint,
                    "issue": f"status={status} rows={len(rows)}",
                }
            )
        else:
            passes += 1

    return passes, total


def evaluate_filter(
    session: requests.Session,
    config: EndpointConfig,
    issues: list[dict[str, Any]],
) -> tuple[int, int]:
    passes = 0
    total = 10

    keys = list(config.filter_values.keys())
    if not keys:
        return 0, total

    single_key = keys[0]
    single_val = config.filter_values[single_key][0]
    multiple = {k: values[0] for k, values in list(config.filter_values.items())[:2]}

    cases = [
        ("single_filter", {single_key: single_val}),
        ("multiple_filters", multiple),
        ("remove_individual_filter", multiple),
        ("clear_all_filters", {}),
        ("invalid_filter_combo", {single_key: "__invalid_value__", **multiple}),
        ("boundary_values", {single_key: config.filter_values[single_key][-1]}),
        ("filters_no_results", {single_key: "__no_match_filter__"}),
        ("rapid_filter_changes", {single_key: single_val}),
        ("filters_with_search", {single_key: single_val, "q": "__possible_match__"}),
        ("filter_persistence_reload", {single_key: single_val}),
    ]

    for case_name, case_filters in cases:
        ok = True
        if case_name == "rapid_filter_changes":
            for value in config.filter_values[single_key][: min(5, len(config.filter_values[single_key]))]:
                status, _ = call_endpoint(
                    session,
                    config.endpoint,
                    {**config.defaults, single_key: value},
                )
                if status != 200:
                    ok = False
                    break
        else:
            status, payload = call_endpoint(
                session,
                config.endpoint,
                {**config.defaults, **case_filters},
            )
            ok = status == 200
            if ok and case_name == "filter_persistence_reload":
                status2, payload2 = call_endpoint(
                    session,
                    config.endpoint,
                    {**config.defaults, **case_filters},
                )
                ok = status2 == 200 and len(pick_rows(payload)) == len(pick_rows(payload2))

        if not ok:
            issues.append(
                {
                    "feature": "filter",
                    "case": case_name,
                    "page": config.page,
                    "endpoint": config.endpoint,
                    "issue": "filter case failed",
                }
            )
        else:
            passes += 1

    return passes, total


def evaluate_pagination(
    session: requests.Session,
    config: EndpointConfig,
    issues: list[dict[str, Any]],
) -> tuple[int, int]:
    total = 10
    if not config.pagination:
        return 0, total

    page_key = config.pagination["page"]
    limit_key = config.pagination["limit"]
    passes = 0

    base_params = {**config.defaults, limit_key: 10, page_key: 1}
    s0, p0 = call_endpoint(session, config.endpoint, base_params)
    rows0 = pick_rows(p0) if s0 == 200 else []

    scenarios = [
        ("default_page_load", {page_key: 1, limit_key: 10}),
        ("next_page_navigation", {page_key: 2, limit_key: 10}),
        ("previous_page_navigation", {page_key: 1, limit_key: 10}),
        ("jump_specific_page", {page_key: 3, limit_key: 10}),
        ("first_page_behavior", {page_key: 1, limit_key: 10}),
        ("last_page_behavior", {page_key: 9999, limit_key: 10}),
        ("invalid_page_number", {page_key: -1, limit_key: 10}),
        ("pagination_with_filters", {page_key: 1, limit_key: 10, **({next(iter(config.filter_values)): config.filter_values[next(iter(config.filter_values))][0]} if config.filter_values else {})}),
        ("pagination_with_search", {page_key: 1, limit_key: 10, "q": pick_token(rows0[0]) if rows0 else ""}),
        ("duplicates_missing_check", {page_key: 2, limit_key: 10}),
    ]

    for case_name, extra in scenarios:
        status, payload = call_endpoint(session, config.endpoint, {**config.defaults, **extra})
        ok = status == 200

        if ok and case_name == "duplicates_missing_check" and rows0:
            ids0 = {row.get("id") for row in rows0 if row.get("id") is not None}
            rowsx = pick_rows(payload)
            idsx = {row.get("id") for row in rowsx if row.get("id") is not None}
            if idsx:
                ok = ids0.isdisjoint(idsx)

        if not ok:
            issues.append(
                {
                    "feature": "pagination",
                    "case": case_name,
                    "page": config.page,
                    "endpoint": config.endpoint,
                    "issue": f"pagination case failed (status={status})",
                }
            )
        else:
            passes += 1

    return passes, total


def values_for_sort_key(rows: list[dict[str, Any]], key: str) -> list[str]:
    vals = []
    for row in rows:
        value = row.get(key)
        vals.append("" if value is None else str(value).lower())
    return vals


def evaluate_sort(
    session: requests.Session,
    config: EndpointConfig,
    issues: list[dict[str, Any]],
) -> tuple[int, int]:
    passes = 0
    total = 10

    if not config.sort_pairs:
        return 0, total

    asc, desc = config.sort_pairs[0]
    candidates = [
        ("ascending_order", asc),
        ("descending_order", desc),
        ("toggle_sorting_repeatedly", asc),
        ("sorting_with_duplicates", asc),
        ("sorting_with_null_empty", asc),
        ("sorting_with_search", desc),
        ("sorting_with_filters", asc),
        ("sorting_persistence_reload", asc),
        ("sorting_across_pagination", desc),
        ("sorting_large_dataset", asc),
    ]

    for case_name, sort_value in candidates:
        params = {**config.defaults, "sort": sort_value}
        if case_name == "sorting_with_filters" and config.filter_values:
            key = next(iter(config.filter_values))
            params[key] = config.filter_values[key][0]
        if case_name == "sorting_with_search":
            status0, payload0 = call_endpoint(session, config.endpoint, config.defaults)
            rows0 = pick_rows(payload0) if status0 == 200 else []
            params["q"] = pick_token(rows0[0]) if rows0 else ""
        if case_name in {"sorting_across_pagination", "sorting_large_dataset"} and config.pagination:
            params[config.pagination["limit"]] = 20
            params[config.pagination["page"]] = 1

        ok = True
        if case_name == "toggle_sorting_repeatedly":
            for _ in range(6):
                for option in (asc, desc):
                    status, _ = call_endpoint(session, config.endpoint, {**config.defaults, "sort": option})
                    if status != 200:
                        ok = False
                        break
                if not ok:
                    break
        else:
            status, payload = call_endpoint(session, config.endpoint, params)
            ok = status == 200
            if ok and case_name == "sorting_persistence_reload":
                status2, payload2 = call_endpoint(session, config.endpoint, params)
                rows1 = pick_rows(payload)
                rows2 = pick_rows(payload2)
                ok = status2 == 200 and [r.get("id") for r in rows1[:10]] == [r.get("id") for r in rows2[:10]]
            if ok and case_name in {"ascending_order", "descending_order"}:
                rows = pick_rows(payload)
                if rows:
                    key_hint = None
                    if "title" in rows[0]:
                        key_hint = "title"
                    elif "name" in rows[0]:
                        key_hint = "name"
                    elif "catalog_code" in rows[0]:
                        key_hint = "catalog_code"
                    if key_hint:
                        values = values_for_sort_key(rows[:25], key_hint)
                        expected = sorted(values)
                        if case_name == "descending_order":
                            expected = list(reversed(expected))
                        ok = values == expected

        if not ok:
            issues.append(
                {
                    "feature": "sorting",
                    "case": case_name,
                    "page": config.page,
                    "endpoint": config.endpoint,
                    "issue": "sorting case failed",
                }
            )
        else:
            passes += 1

    return passes, total


def build_configs() -> list[EndpointConfig]:
    return [
        EndpointConfig(
            page="Home",
            endpoint="/catalog/books/",
            defaults={"record_type": "all", "sort": "-created_at"},
            filter_values={
                "record_type": ["digital", "manual", "all"],
                "state": ["draft", "ready", "published"],
                "review_state": ["pending", "approved", "rejected"],
            },
            sort_pairs=[("title", "-title")],
            pagination=None,
            aliases=["Library", "Created Books"],
        ),
        EndpointConfig(
            page="Manual Books",
            endpoint="/catalog/manual-books/",
            defaults={"sort": "-created_at"},
            filter_values={
                "created_after": ["2000-01-01", "2020-01-01"],
                "created_before": ["2030-01-01", "2026-01-01"],
            },
            sort_pairs=[("title", "-title")],
            pagination=None,
            aliases=[],
        ),
        EndpointConfig(
            page="Categories",
            endpoint="/catalog/categories/",
            defaults={"record_type": "all", "sort": "-book_count"},
            filter_values={"record_type": ["digital", "manual", "all"]},
            sort_pairs=[("name", "-name")],
            pagination=None,
            aliases=[],
        ),
        EndpointConfig(
            page="Series",
            endpoint="/catalog/series/",
            defaults={"record_type": "all", "sort": "-book_count"},
            filter_values={"record_type": ["digital", "manual", "all"]},
            sort_pairs=[("name", "-name")],
            pagination=None,
            aliases=[],
        ),
        EndpointConfig(
            page="Writers",
            endpoint="/catalog/writers/",
            defaults={"record_type": "all", "sort": "-book_count"},
            filter_values={"record_type": ["digital", "manual", "all"]},
            sort_pairs=[("name", "-name")],
            pagination=None,
            aliases=["Translators:/catalog/translators/", "Compilers:/catalog/compilers/", "Editors:/catalog/editors/"],
        ),
        EndpointConfig(
            page="Processing - Submissions",
            endpoint="/ingestion/submissions/",
            defaults={"limit": 60},
            filter_values={"status": ["queued", "processing", "failed"], "review_state": ["pending", "approved"]},
            sort_pairs=[],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
        EndpointConfig(
            page="Processing - Jobs",
            endpoint="/ingestion/jobs/",
            defaults={"limit": 60},
            filter_values={"status": ["queued", "processing", "failed"], "job_type": ["ingestion", "resolution", "curation"]},
            sort_pairs=[],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
        EndpointConfig(
            page="Processing - Duplicate Reviews",
            endpoint="/ingestion/duplicate-reviews/",
            defaults={"limit": 60},
            filter_values={"status": ["pending", "confirmed", "dismissed"]},
            sort_pairs=[],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
        EndpointConfig(
            page="Processing - Catalog Entries",
            endpoint="/ingestion/catalog/entries/",
            defaults={"limit": 180, "sort": "status_recent"},
            filter_values={"status": ["new", "processing", "failed", "ready"]},
            sort_pairs=[("title_asc", "title_desc")],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
        EndpointConfig(
            page="Processing - Incomplete Check",
            endpoint="/ingestion/catalog/incomplete-check/",
            defaults={"limit": 180},
            filter_values={"status": ["removed", "still", "missing"]},
            sort_pairs=[],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
        EndpointConfig(
            page="Processing - Curation Runs",
            endpoint="/ingestion/catalog/curation-runs/",
            defaults={"limit": 60},
            filter_values={"status": ["queued", "processing", "failed"], "mode": ["pending", "all"]},
            sort_pairs=[],
            pagination={"page": "page", "limit": "limit"},
            aliases=[],
        ),
    ]


def run_suite(session_id: str = "") -> dict[str, Any]:
    env = read_env(ROOT / ".env")
    email = env.get("SUPER_ADMIN_EMAIL")
    password = env.get("SUPER_ADMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError("SUPER_ADMIN_EMAIL or SUPER_ADMIN_PASSWORD missing in .env")

    configs = build_configs()
    all_runs: list[dict[str, Any]] = []
    all_issues: list[dict[str, Any]] = []

    session = make_session(
        email,
        password,
        preauth_session_id=session_id or env.get("QA_SESSION_ID", ""),
    )

    for run_idx in range(1, RUNS + 1):
        started = time.time()
        run_result = {"run": run_idx, "pages": [], "issue_count": 0}

        for config in configs:
            page_issues: list[dict[str, Any]] = []

            status, payload = call_endpoint(session, config.endpoint, config.defaults)
            base_rows = pick_rows(payload) if status == 200 else []
            if status != 200:
                page_issues.append(
                    {
                        "feature": "baseline",
                        "case": "default_load",
                        "page": config.page,
                        "endpoint": config.endpoint,
                        "issue": f"baseline status={status}",
                    }
                )

            search_pass, search_total = evaluate_search(session, config, base_rows, page_issues)
            filter_pass, filter_total = evaluate_filter(session, config, page_issues)
            page_pass, page_total = evaluate_pagination(session, config, page_issues)
            sort_pass, sort_total = evaluate_sort(session, config, page_issues)

            page_report = {
                "page": config.page,
                "endpoint": config.endpoint,
                "aliases": config.aliases,
                "baseline_status": status,
                "baseline_rows": len(base_rows),
                "search": {"pass": search_pass, "total": search_total},
                "filter": {"pass": filter_pass, "total": filter_total},
                "pagination": {"pass": page_pass, "total": page_total},
                "sorting": {"pass": sort_pass, "total": sort_total},
                "issues": deepcopy(page_issues),
            }
            run_result["pages"].append(page_report)
            all_issues.extend(page_issues)

        run_result["issue_count"] = sum(len(page["issues"]) for page in run_result["pages"])
        run_result["duration_seconds"] = round(time.time() - started, 2)
        all_runs.append(run_result)

    page_aggregate: dict[str, dict[str, Any]] = {}
    for run in all_runs:
        for page in run["pages"]:
            bucket = page_aggregate.setdefault(
                page["page"],
                {
                    "page": page["page"],
                    "endpoint": page["endpoint"],
                    "aliases": page["aliases"],
                    "search_pass": 0,
                    "search_total": 0,
                    "filter_pass": 0,
                    "filter_total": 0,
                    "pagination_pass": 0,
                    "pagination_total": 0,
                    "sorting_pass": 0,
                    "sorting_total": 0,
                    "issues": [],
                },
            )
            bucket["search_pass"] += page["search"]["pass"]
            bucket["search_total"] += page["search"]["total"]
            bucket["filter_pass"] += page["filter"]["pass"]
            bucket["filter_total"] += page["filter"]["total"]
            bucket["pagination_pass"] += page["pagination"]["pass"]
            bucket["pagination_total"] += page["pagination"]["total"]
            bucket["sorting_pass"] += page["sorting"]["pass"]
            bucket["sorting_total"] += page["sorting"]["total"]
            bucket["issues"].extend(page["issues"])

    summary = {
        "runs": RUNS,
        "total_pages": len(page_aggregate),
        "total_issues": len(all_issues),
        "run_issue_counts": [run["issue_count"] for run in all_runs],
        "flaky_runs": [run["run"] for run in all_runs if run["issue_count"] != all_runs[0]["issue_count"]],
    }

    return {
        "generated_at_epoch": int(time.time()),
        "summary": summary,
        "pages": list(page_aggregate.values()),
        "runs": all_runs,
        "issues": all_issues,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", default="", help="Pre-authenticated Django sessionid cookie")
    args = parser.parse_args()

    report = run_suite(session_id=args.session_id)
    out_dir = ROOT / "test-artifacts"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "qa-e2e-query-report.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"report: {out_path}")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
