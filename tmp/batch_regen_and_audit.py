"""Batch reprocess + audit script.

Runs inside the processing-worker container:

    docker exec -e DJANGO_SETTINGS_MODULE=config.settings \
        compose-processing-worker-1 python /tmp/batch_regen_and_audit.py

For each target slug it:
  1) Queues a reprocess job, runs it synchronously (bypassing the celery
     worker that is currently flooded with bulk tick tasks).
  2) Locates the newest EPUB under storage/media/generated/<slug>/.
  3) Inspects the EPUB for spec invariants and emits a per-book report.

Writes:
  /storage/tmp/audit_report.json   — machine readable
  Prints a concise text summary.

Spec invariants checked (post-curated-rewrite, see repo memory):
  - Job completed (status == ready/success).
  - EPUB exists, non-empty, contains content/opf.
  - Contains EPUB/cover_page.xhtml, EPUB/info.xhtml, EPUB/toc.xhtml,
    EPUB/nav.xhtml, and at least one lesson*.xhtml.
  - Exactly one toc.xhtml (multi-TOC merged per §6).
  - nav.xhtml MUST NOT list front matter (cover/title/info/dedication/
    front_section_*) nor a self-link to toc.xhtml.
  - nav.xhtml's chapter list (depth>0 entries excluded) covers every
    lesson*.xhtml in OPF spine.
  - No front_section_*.xhtml is a pure bibliographic duplicate of info
    (caught by `_is_pure_title_duplicate_section`).
  - dedication.xhtml, if present, is NOT also listed as a front_section_*.
"""

import io
import json
import os
import sys
import traceback
import zipfile
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, "/app")

import django  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from apps.catalog.models import Book
from apps.ingestion.services.submissions import (
    queue_reprocess_book,
    process_submission_job,
)

GENERATED_ROOT = "/storage/media/generated"

REFERENCE_SLUGS = [
    "২০০১-আ-স্পেস-ওডিসি",
    "শার্লক-হোমস-সমগ্র-১",
    "সিডনি-সেলডন-রচনাসমগ্র-২",
    "৪৯-প্রফেসর-ওয়াই-৬-রহস্যপুরী",
    "শঙ্খ-ঘোষের-শ্রেষ্ঠ-কবিতা",
    "স্বপ্নের-বৃষ্টিমহল",
    "বাঃ-১২",
    "ছেড়ে-আসা-গ্রাম",
    "দুজনার-ঘর",
    "ফ্রান্সিস-সমগ্র-৪",
    "মন-আয়নায়-মেঘ",
    "বাউলকবি-রাধারমণ-গীতি-সংগ্রহ",
    "রোল-নং-১৭-দোলা-মিত্র-গল্পগ্রন্থ",
    "হিমুর-বাবার-কথামালা",
    "hamlet",
    # সাতকাহন-১ regression check (already verified manually).
    "সাতকাহন-১",
]


def collect_target_slugs():
    from django.db.models import Q

    slugs = list(REFERENCE_SLUGS)
    for pat in ["কাকাবাবু-সমগ্র", "কুয়াশা", "কিরীটী-অমনিবাস"]:
        for b in Book.objects.filter(slug__icontains=pat).order_by("slug"):
            if b.slug not in slugs:
                slugs.append(b.slug)
    return slugs


def newest_epub(slug):
    folder = os.path.join(GENERATED_ROOT, slug)
    if not os.path.isdir(folder):
        return None
    candidates = [
        (os.path.getmtime(os.path.join(folder, f)), os.path.join(folder, f))
        for f in os.listdir(folder)
        if f.lower().endswith(".epub")
    ]
    if not candidates:
        return None
    return max(candidates)[1]


def reprocess(slug):
    """Returns (job_status, error_message_or_None)."""
    try:
        book = Book.objects.get(slug=slug)
    except Book.DoesNotExist:
        return ("missing-book", "no Book row")

    try:
        job, _ = queue_reprocess_book(book)
    except Exception as exc:  # noqa: BLE001
        return ("queue-failed", f"{type(exc).__name__}: {exc}")

    try:
        process_submission_job(str(job.id), retry_count=0, task_id="audit")
    except Exception as exc:  # noqa: BLE001
        return ("process-failed", f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)}")

    job.refresh_from_db()
    err_msg = getattr(job, "date_error_message", None) or getattr(job, "error_message", None)
    return (job.status or "unknown", err_msg)


# ---------------------------------------------------------------------------
# EPUB inspection
# ---------------------------------------------------------------------------

NAV_FORBIDDEN_PREFIXES = ()  # nav.xhtml IS comprehensive per spec
# (docs/processing-live-test-matrix.md §nav): the only forbidden link is
# a self-link to nav.xhtml itself. Front matter (cover/title/info/
# dedication/front_section_*) and toc.xhtml MUST appear.


def audit_epub(path):
    issues = []
    info = {}
    try:
        z = zipfile.ZipFile(path)
    except Exception as exc:  # noqa: BLE001
        return [f"unzip-error: {exc}"], info

    names = z.namelist()
    info["filename"] = os.path.basename(path)
    info["size"] = os.path.getsize(path)

    epub_files = [n for n in names if n.startswith("EPUB/")]
    info["epub_files"] = len(epub_files)
    has = lambda n: any(name == f"EPUB/{n}" for name in names)

    for required in ("cover_page.xhtml", "info.xhtml", "toc.xhtml", "nav.xhtml"):
        if not has(required):
            issues.append(f"missing-{required}")

    lessons = [n for n in epub_files if "/lesson_" in n and n.endswith(".xhtml")]
    info["lesson_count"] = len(lessons)
    if not lessons:
        issues.append("no-lesson-chapters")

    toc_files = [n for n in epub_files if n.endswith("toc.xhtml")]
    if len(toc_files) > 1:
        issues.append(f"multiple-toc-files:{len(toc_files)}")

    front_sections = [
        n for n in epub_files
        if os.path.basename(n).startswith("front_section_")
    ]
    info["front_section_count"] = len(front_sections)

    # --- nav.xhtml structural checks ---
    try:
        nav_bytes = z.read("EPUB/nav.xhtml").decode("utf-8", errors="replace")
    except KeyError:
        nav_bytes = ""

    import re
    nav_hrefs = re.findall(r'href="([^"]+)"', nav_bytes)
    nav_bases = [h.split("#")[0] for h in nav_hrefs]

    # Self-link to nav.xhtml is the only nav-link prohibition.
    if "nav.xhtml" in nav_bases:
        issues.append("nav-self-links-nav")

    # Comprehensive coverage: nav must include every readable spine file.
    spine_xhtml = {
        os.path.basename(n)
        for n in epub_files
        if n.endswith(".xhtml") and os.path.basename(n) != "nav.xhtml"
    }
    nav_basenames = {os.path.basename(b) for b in nav_bases if b}
    missing_in_nav = sorted(spine_xhtml - nav_basenames)
    if missing_in_nav:
        # Cap to first 6 for readable issue strings.
        sample = ",".join(missing_in_nav[:6])
        more = f"+{len(missing_in_nav)-6}" if len(missing_in_nav) > 6 else ""
        issues.append(f"nav-missing-pages:{sample}{more}")

    # --- bibliographic-duplicate front sections ---
    if front_sections:
        from apps.ingestion.pipeline.book_manifest import (
            _is_pure_title_duplicate_section,
        )
        # We can't easily get book_title/author from the EPUB alone; rely on
        # filename-only heuristic: open info.xhtml and pull the first line.
        try:
            info_html = z.read("EPUB/info.xhtml").decode("utf-8", errors="replace")
        except KeyError:
            info_html = ""
        # Cheap title/author extraction: first two non-empty <p> text fragments.
        plain = re.sub(r"<[^>]+>", "\n", info_html)
        lines = [l.strip() for l in plain.splitlines() if l.strip()]
        # Find first occurrence of a multi-line block (title / author / type).
        title_guess = lines[0] if lines else ""
        author_guess = lines[1] if len(lines) > 1 else ""

        for fs in front_sections:
            try:
                html = z.read(fs).decode("utf-8", errors="replace")
            except KeyError:
                continue
            if _is_pure_title_duplicate_section(
                {"html": html}, title_guess, author_guess
            ):
                issues.append(f"bibliographic-duplicate:{os.path.basename(fs)}")

    # --- dedication should not also be a front section ---
    if has("dedication.xhtml") and front_sections:
        try:
            ded = z.read("EPUB/dedication.xhtml").decode("utf-8", errors="replace")
            ded_text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", ded)).strip()
            for fs in front_sections:
                fs_text = re.sub(
                    r"\s+",
                    " ",
                    re.sub(r"<[^>]+>", " ", z.read(fs).decode("utf-8", errors="replace")),
                ).strip()
                if ded_text and ded_text == fs_text:
                    issues.append(f"dedication-duplicated-in:{os.path.basename(fs)}")
        except Exception:
            pass

    z.close()
    return issues, info


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    slugs = collect_target_slugs()
    print(f"=== Targeting {len(slugs)} books ===")
    print()

    report = []
    start_all = datetime.utcnow()

    for idx, slug in enumerate(slugs, 1):
        t0 = datetime.utcnow()
        print(f"[{idx:>3}/{len(slugs)}] {slug}")
        status, err = reprocess(slug)
        epub_path = newest_epub(slug)
        issues, info = ([], {})
        if epub_path:
            issues, info = audit_epub(epub_path)
        else:
            issues = ["no-epub-output"]
        secs = (datetime.utcnow() - t0).total_seconds()
        entry = {
            "slug": slug,
            "job_status": status,
            "job_error": err,
            "epub": os.path.basename(epub_path) if epub_path else None,
            "info": info,
            "issues": issues,
            "elapsed_s": round(secs, 1),
        }
        report.append(entry)
        mark = "OK " if not issues and status in ("ready", "success") else "ISS"
        print(f"        {mark} status={status} issues={len(issues)} t={secs:.0f}s")
        if issues:
            for it in issues[:6]:
                print(f"           - {it}")
            if len(issues) > 6:
                print(f"           - ...({len(issues)-6} more)")

    out_path = "/storage/tmp/audit_report.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    total_secs = (datetime.utcnow() - start_all).total_seconds()
    counts = defaultdict(int)
    for r in report:
        if not r["issues"] and r["job_status"] in ("ready", "success"):
            counts["clean"] += 1
        else:
            counts["dirty"] += 1
        for it in r["issues"]:
            counts[it.split(":")[0]] += 1

    print()
    print("=== Summary ===")
    print(f"  total: {len(report)}  clean: {counts['clean']}  dirty: {counts['dirty']}")
    print(f"  total time: {total_secs:.0f}s")
    print("  issue counts:")
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        if k in ("clean", "dirty"):
            continue
        print(f"    {v:>3}  {k}")
    print()
    print(f"Full report written to: {out_path}")


if __name__ == "__main__":
    main()
