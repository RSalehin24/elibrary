import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django
django.setup()

from apps.ingestion.services.legacy_adapter import scrape_book_high_fidelity

URLS = [
    "https://www.ebanglalibrary.com/books/%E0%A6%B2%E0%A7%8B%E0%A6%B9%E0%A6%BF%E0%A6%A4%E0%A6%95%E0%A6%BF%E0%A6%B0%E0%A6%A3%E0%A6%9A%E0%A7%8D%E0%A6%9B%E0%A6%9F%E0%A6%BE/",
    "https://www.ebanglalibrary.com/books/%E0%A6%B9%E0%A6%BE%E0%A6%A4-%E0%A6%9B%E0%A7%81%E0%A6%81%E0%A6%AF%E0%A6%BC%E0%A7%87-%E0%A6%9B%E0%A7%81%E0%A6%81%E0%A6%AF%E0%A6%BC%E0%A7%87-%E0%A6%A6%E0%A6%BF%E0%A6%AF%E0%A6%BC%E0%A7%87%E0%A6%9B%E0%A6%BF-%E0%A6%B8%E0%A6%AC/",
    "https://www.ebanglalibrary.com/books/%E0%A6%A6%E0%A7%81%E0%A6%B0%E0%A7%8D%E0%A6%97%E0%A6%B0%E0%A6%B9%E0%A6%B8%E0%A7%8D%E0%A6%AF-%E0%A6%B6%E0%A6%B0%E0%A6%A6%E0%A6%BF%E0%A6%A8%E0%A7%8D%E0%A6%A6%E0%A7%81-%E0%A6%AC%E0%A6%A8%E0%A7%8D%E0%A6%A6%E0%A7%8D%E0%A6%AF%E0%A7%8B%E0%A6%AA%E0%A6%BE%E0%A6%A7%E0%A7%8D%E0%A6%AF%E0%A6%BE%E0%A6%AF%E0%A6%BC/",
]

for url in URLS:
    print(f"\n=== {url} ===")
    try:
        data = scrape_book_high_fidelity(url)
        print(f"  title: {data.get('book_title')}")
        print(f"  toc: {len(data.get('toc') or [])}")
        print(f"  content_items: {len(data.get('content_items') or [])}")
        print(f"  book_info len: {len(data.get('book_info') or '')}")
        print(f"  main_content len: {len(data.get('main_content') or '')}")
    except Exception as e:
        print(f"  ERROR: {e}")
