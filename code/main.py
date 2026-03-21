import argparse
import time
from scraper import scrape_book_data
from html_book import create_html_book
from epub_book import create_epub
from config import BOOK_URLS

# Delay between books (in seconds) to avoid rate limiting
DELAY_BETWEEN_BOOKS = 3


def parse_args():
    parser = argparse.ArgumentParser(description="Batch scrape ebanglalibrary books and generate HTML/EPUB outputs.")
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        default=[],
        help="Direct ebanglalibrary book URL. Repeat for multiple books.",
    )
    parser.add_argument(
        "--name",
        action="append",
        dest="names",
        default=[],
        help="Optional display name for each --url entry. Repeat in the same order as --url.",
    )
    parser.add_argument(
        "--delay",
        type=int,
        default=DELAY_BETWEEN_BOOKS,
        help="Delay between books in seconds.",
    )
    return parser.parse_args()


def configured_books(args):
    if args.urls:
        books = []
        for index, url in enumerate(args.urls):
            name = args.names[index] if index < len(args.names) else url
            books.append((name, url))
        return books
    return BOOK_URLS

def process_book(name, url, index, total):
    """Process a single book URL and return success status."""
    print(f"\n{'='*60}")
    print(f"Processing book {index}/{total}: {name}")
    print(f"URL: {url}")
    print('='*60)
    
    try:
        data = scrape_book_data(url)
        if not data:
            print(f"❌ Failed to scrape: {name}")
            return False, name
        
        book_title = data.get("book_title", "Unknown")
        print(f"📖 Scraped Title: {book_title}")
        
        create_html_book(data)
        create_epub(data)
        
        print(f"✅ Successfully generated: {book_title}")
        return True, name
    except Exception as e:
        print(f"❌ Error processing {name}: {e}")
        return False, name

def main():
    args = parse_args()
    book_urls = configured_books(args)

    if not book_urls:
        print("No book URLs configured. Use BOOK_URLS_JSON/BOOK_URL env vars or pass --url.")
        exit(1)
    
    total = len(book_urls)
    print(f"\n📚 Starting batch processing of {total} book(s)...")
    print("\nBooks to process:")
    for i, (name, _) in enumerate(book_urls, 1):
        print(f"  {i}. {name}")
    
    successful = 0
    failed = 0
    failed_books = []
    
    for index, (name, url) in enumerate(book_urls, 1):
        success, book_name = process_book(name, url, index, total)
        if success:
            successful += 1
        else:
            failed += 1
            failed_books.append(book_name)
        
        # Add delay between books to avoid rate limiting (except for last book)
        if index < total:
            print(f"\n⏳ Waiting {args.delay}s before next book...")
            time.sleep(args.delay)
    
    # Print summary
    print(f"\n{'='*60}")
    print("📊 BATCH PROCESSING COMPLETE")
    print('='*60)
    print(f"✅ Successful: {successful}/{total}")
    print(f"❌ Failed: {failed}/{total}")
    
    if failed_books:
        print("\nFailed books:")
        for name in failed_books:
            print(f"  - {name}")
    
    print("\n🎉 Book generation complete!")

if __name__ == "__main__":
    main()
