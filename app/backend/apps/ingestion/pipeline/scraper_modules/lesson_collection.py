

def crawl_inline_toc_entry(
    entry,
    remaining_items,
    base_url,
    cache,
    active_urls,
    crawl_state,
    crawl_limits,
    depth,
):
    title = clean_display_text(entry.get("title", ""))
    node_type = entry.get("type") or "lesson"
    raw_url = (entry.get("url") or "").strip()
    local_content_item = consume_inline_content_item(title, remaining_items)
    local_content = truncate_scraped_content(
        clean_content_html(
            local_content_item.get("content", "") if local_content_item else "",
            title,
        ),
        crawl_limits.get("max_content_chars"),
    )

    nested_children = [
        child
        for child in (
            crawl_inline_toc_entry(
                child_entry,
                remaining_items,
                base_url,
                cache,
                active_urls,
                crawl_state,
                crawl_limits,
                depth + 1,
            )
            for child_entry in entry.get("children", []) or []
        )
        if child
    ]

    if raw_url and not raw_url.startswith("#"):
        normalized_url = normalize_crawl_url(raw_url, base_url=base_url)
        if normalized_url:
            linked_node = scrape_recursive_content_node(
                normalized_url,
                title_hint=title,
                node_type=node_type,
                cache=cache,
                active_urls=active_urls,
                crawl_state=crawl_state,
                crawl_limits=crawl_limits,
                depth=depth,
            )
            if local_content and not linked_node.get("content"):
                linked_node["content"] = local_content
            if title:
                linked_node["title"] = title
            linked_node["type"] = node_type
            linked_node["children"] = merge_unique_children(
                linked_node.get("children", []),
                nested_children,
            )
            return linked_node

    if not title and not local_content and not nested_children:
        return None

    return build_content_node(
        title,
        node_type=node_type,
        content=local_content,
        children=nested_children,
    )


def content_node_to_toc_entry(node, parent_path=()):
    path = list(parent_path) + [node.get("title", "")]
    entry = {
        "title": node.get("title", ""),
        "type": node.get("type", "lesson"),
        "has_content": bool(node.get("content")),
        "path": path,
    }
    if node.get("children"):
        entry["children"] = [
            content_node_to_toc_entry(child, tuple(path))
            for child in node["children"]
        ]
    return entry


def flatten_content_nodes(nodes, parent_path=(), max_items=None):
    items = []

    for node in nodes:
        title = node.get("title", "")
        path = list(parent_path) + [title]
        if node.get("content"):
            items.append(
                {
                    "title": title,
                    "content": node["content"],
                    "type": node.get("type", "lesson"),
                    "parent": parent_path[-1] if parent_path else None,
                    "path": path,
                }
            )
            if isinstance(max_items, int) and max_items > 0 and len(items) >= max_items:
                return items

        child_limit = None
        if isinstance(max_items, int) and max_items > 0:
            child_limit = max_items - len(items)
            if child_limit <= 0:
                return items

        items.extend(
            flatten_content_nodes(
                node.get("children", []),
                tuple(path),
                max_items=child_limit,
            )
        )

        if isinstance(max_items, int) and max_items > 0 and len(items) >= max_items:
            return items

    return items

def get_total_pages(soup):
    pager = soup.find("div", class_="ld-pagination ld-pagination-page-course_content_shortcode")
    if pager and pager.has_attr("data-pager-results"):
        try:
            data = json.loads(pager["data-pager-results"].replace("&quot;", '"'))
            return int(data.get("total_pages", 1))
        except Exception:
            pass
    return 1

def scrape_nested_topics(lesson_item):
    """
    Recursively scrape topics from a lesson item's expanded content.
    Returns a list of (title, url) tuples for topics.
    """
    topics = []
    seen_urls = set()  # Track URLs to avoid duplicates
    
    # Find the expanded container for this lesson
    expand_id = lesson_item.get("data-ld-expand-id")
    if not expand_id:
        return topics
    
    # Find the corresponding expanded container
    expanded_container = lesson_item.find("div", id=f"{expand_id}-container")
    if not expanded_container:
        return topics
    
    # Find all topic items within this container
    topic_items = expanded_container.find_all(
        "div",
        class_=lambda c: c and "ld-table-list-item" in c,
        recursive=True
    )
    
    for topic_item in topic_items:
        # Find the link to the topic
        a = topic_item.find("a", class_=lambda c: c and "ld-table-list-item-preview" in c)
        if not a or not a.get("href"):
            continue
        
        url = a["href"]
        
        # Skip if we've already seen this URL
        if url in seen_urls:
            continue
        seen_urls.add(url)
            
        # Get the topic title
        title_span = a.find("span", class_="ld-topic-title")
        if title_span:
            title = title_span.get_text(strip=True)
            topics.append((title, url))
    
    return topics

def scrape_lesson_list(soup):
    """
    Scrape lessons and their nested topics from the page.
    Returns a list of dictionaries with lesson info and nested topics.
    """
    lessons = []
    
    # Find all lesson items
    lesson_items = soup.find_all(
        "div",
        class_=lambda c: c and "ld-item-lesson-item" in c
    )

    for lesson_item in lesson_items:
        # Find the lesson link
        a = lesson_item.find("a", class_="ld-item-name")
        if not a:
            continue
            
        # Get lesson title
        title_div = a.find("div", class_="ld-item-title")
        if not title_div:
            continue
            
        lesson_title = title_div.get_text(strip=True)
        # Remove the topic count text (e.g., "14 Topics" or "12 Topics" without space)
        lesson_title = re.sub(r'\d+\s*Topics.*$', '', lesson_title, flags=re.IGNORECASE)
        lesson_title = lesson_title.strip()
        
        lesson_url = a.get("href")
        
        # Check if this lesson has nested topics
        topics = scrape_nested_topics(lesson_item)
        
        lesson_data = {
            "title": lesson_title,
            "url": lesson_url,
            "topics": topics,
            "has_topics": len(topics) > 0
        }
        
        lessons.append(lesson_data)

    return lessons

def scrape_all_lessons(book_url, max_pages=None):
    """
    Scrape all lessons across all pages.
    Returns a list of lesson dictionaries.
    """
    lessons = []
    page = 1

    while True:
        if max_pages is not None and page > max_pages:
            break

        soup = get_soup(f"{book_url}?ld-courseinfo-lesson-page={page}")
        if not soup:
            break

        lessons.extend(scrape_lesson_list(soup))
        if page >= get_total_pages(soup):
            break

        page += 1
        time.sleep(1)

    return lessons
