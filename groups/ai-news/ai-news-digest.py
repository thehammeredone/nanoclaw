#!/usr/bin/env python3
"""Run ai-news-radar scraper and print a digest of English-language AI stories grouped by source."""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# OPML RSS content categorisation
# ---------------------------------------------------------------------------
# Each entry is (category_label, [regex_patterns]).
# Items are checked against each category in order; first match wins.
# Patterns are matched case-insensitively against the English title.
# ---------------------------------------------------------------------------
_OPML_CATEGORY_RULES = [
    ("Policy & Legal", [
        r"sue[sd]?\b", r"\blawsuit\b", r"\bcourt\b", r"trade secret",
        r"copyright", r"\bstolen\b", r"\btheft\b", r"steal(?:s|ing)\b",
        r"misconduct", r"extremist", r"\bexplosive", r"\bweapon\b",
        r"\billegal\b", r"backdoor", r"cheat(?:ing)?\b",
        # "ban" only as a standalone word, not in brand names like Ray-Ban
        r"(?<![A-Za-z]-)\bban(?:ned|ning|s)?\b",
        r"regulation", r"legislation", r"antitrust", r"GDPR", r"watchdog",
        r"\baccuses?\b", r"\bpolicy\b", r"distillation concern",
        r"open.weight.*policy", r"existential.*policy",
    ]),
    ("Hardware & Chips", [
        # "data center" only when it's about infrastructure, not general news
        r"\bchips?\b(?!.*Ray-Ban)", r"\bGPU\b", r"\bCPU\b", r"\bTPU\b",
        r"semiconductor", r"AI data cent(?:er|re)", r"\bHBM\b", r"\bDRAM\b",
        r"memory chip", r"\bfab\b", r"SK Hynix", r"SambaNova", r"\bIPO\b",
        r"wafer", r"compute cluster",
    ]),
    ("Research & Engineering", [
        r"\btraining\b", r"fine.tun", r"\binference\b", r"\bbenchmark\b",
        r"pretraining", r"\bRLHF\b", r"\bJAX\b", r"co.folding",
        r"tokenizer", r"disaggregated", r"host offloading",
        r"quantized model", r"LLM training", r"BioNeMo", r"NeMo\b",
        r"model co.design", r"attention profile", r"quantum comput",
        r"protein discovery", r"peptide",
    ]),
    ("Infrastructure & MLOps", [
        r"SageMaker", r"AgentCore", r"HyperPod", r"MLflow",
        r"serverless", r"Amazon Bedrock", r"Jamf.*Bedrock",
        r"Bedrock.*Jamf", r"Quick Automate", r"semantic layer",
        r"agentic workflow",
    ]),
    ("Society & Ethics", [
        r"emission", r"carbon", r"sustainab", r"deepfake",
        r"AI.generated content", r"social media post", r"\bstudent\b",
        r"academic", r"atrophy", r"human brain", r"reading.*book",
        r"home.+data cent", r"data cent.+home", r"linkedin.*AI",
        r"slop", r"AI girlfriend", r"pickup artist", r"eating disorder",
        r"therapist", r"museum", r"anti.AI movement",
    ]),
    ("Products & Features", [
        r"\blaunch(?:es|ed)?\b", r"\breleases?\b", r"\bannounces?\b",
        r"shut(?:ting)? down", r"\bbrowser\b", r"voice mode",
        r"new (?:model|feature|tool|version)", r"available now",
        r"GPT.5", r"Grok\b", r"Claude.*wrap", r"wrap.*Claude",
        r"AI.powered feature", r"getting.*AI",
    ]),
    ("Industry & Business", [
        r"raises?\b", r"\bfunding\b", r"\bvaluation\b",
        r"acquisition", r"\bCEO\b", r"\bCTO\b", r"stepping down",
        r"leaves? (?:the|his|her|their) (?:role|company|position)",
        r"\bbillion\b", r"million.*round", r"partnership",
        r"Series [A-F]\b", r"joins? (?:the )?\w+",
        r"Hugging Face.*CEO", r"CEO.*Hugging Face",
        r"cost efficiency", r"market dynamic", r"commodity",
        r"pressure on Anthropic", r"pressure on OpenAI",
    ]),
]


def categorize_opml_items(items: list) -> list[tuple[str, list]]:
    """Assign each OPML RSS item to a content category using regex rules.

    Returns a list of (category_label, [items]) sorted by each category's
    highest AI score, descending. Uncategorised items collect in 'Other'.
    """
    buckets: dict[str, list] = defaultdict(list)
    for item in items:
        title = (item.get("title_en") or item.get("title", "")).lower()
        matched = False
        for label, patterns in _OPML_CATEGORY_RULES:
            if any(re.search(p, title, re.IGNORECASE) for p in patterns):
                buckets[label].append(item)
                matched = True
                break
        if not matched:
            buckets["Other"].append(item)

    # Sort items within each bucket by score desc
    for cat_items in buckets.values():
        cat_items.sort(key=lambda x: x.get("ai_score", 0), reverse=True)

    # Sort categories by their best score desc
    return sorted(
        buckets.items(),
        key=lambda kv: max(i.get("ai_score", 0) for i in kv[1]),
        reverse=True,
    )

REPO = Path("/workspace/agent/ai-news-radar")
DATA = REPO / "data"
OPML = REPO / "feeds/follow.opml"
MIN_SCORE = 0.60        # drop anything below this
ENG_CAP = 10            # max items in Builder Engineering section
ENG_BOOST = 0.15        # score boost applied when sorting engineering items
DISCORD_LIMIT = 1950    # hard max chars per Discord message chunk (Discord limit is 2000)
DEDUP_HOURS = 36        # hours before a URL can reappear in the digest

ENGINEERING_SITES = {
    "Simon Willison",
    "Andrej Karpathy Blog",
    "Weights & Biases Blog",
    "LangChain Blog",
    "Lilian Weng Blog",
}

ENGINEERING_URL_PATTERNS = [
    "/engineering/",
    "simonwillison.net",
    "karpathy.github.io",
    "lilianweng.github.io",
    "langchain.dev",
    "wandb.ai/fully-connected",
]

SEEN_URLS_FILE = Path("/workspace/agent/digest-seen-urls.json")
DIGEST_OUTPUT = Path("/workspace/agent/digest-latest.md")
DISCORD_OUTPUT = Path("/workspace/agent/digest-discord.json")
TOP_STORIES_OUTPUT = Path("/workspace/agent/digest-top-stories.json")
TOP_STORIES_COUNT = 5  # max items pulled out as top stories


def run_scraper():
    env = os.environ.copy()
    env["REQUESTS_CA_BUNDLE"] = "/tmp/onecli-combined-ca.pem"
    args = [
        sys.executable,
        str(REPO / "scripts/update_news.py"),
        "--output-dir", str(DATA),
        "--window-hours", "24",
        "--translate-max-new", "0",
    ]
    if OPML.exists():
        args += ["--rss-opml", str(OPML)]
    result = subprocess.run(args, capture_output=True, text=True, env=env, timeout=300)
    return result.returncode == 0, result.stderr


def load_digest():
    with open(DATA / "latest-24h.json") as f:
        d = json.load(f)
    with open(DATA / "source-status.json") as f:
        s = json.load(f)
    return d, s


def has_cjk(text: str) -> bool:
    return any('一' <= c <= '鿿' or '㐀' <= c <= '䶿' for c in text)


def is_engineering(item) -> bool:
    url = item.get("url", "")
    site = item.get("site_name", "")
    return (
        site in ENGINEERING_SITES
        or any(p in url for p in ENGINEERING_URL_PATTERNS)
    )


def load_seen_urls() -> set:
    if not SEEN_URLS_FILE.exists():
        return set()
    try:
        data = json.loads(SEEN_URLS_FILE.read_text())
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=DEDUP_HOURS)).isoformat()
        return {entry["url"] for entry in data if entry.get("seen_at", "") > cutoff}
    except Exception:
        return set()


def save_seen_urls(urls: list):
    existing = []
    if SEEN_URLS_FILE.exists():
        try:
            existing = json.loads(SEEN_URLS_FILE.read_text())
        except Exception:
            pass
    now = datetime.now(timezone.utc).isoformat()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=DEDUP_HOURS)).isoformat()
    existing = [e for e in existing if e.get("seen_at", "") > cutoff]
    seen_set = {e["url"] for e in existing}
    for url in urls:
        if url not in seen_set:
            existing.append({"url": url, "seen_at": now})
    SEEN_URLS_FILE.write_text(json.dumps(existing, indent=2))


def build_digest(data, status, seen_urls: set):
    """Return (header, sections, all_english) where sections is [(source, [items])]."""
    items = data.get("items", [])
    total_raw = data.get("total_items", len(items))
    sources_ok = status.get("successful_sites", 0)
    sources_fail = len(status.get("failed_sites", []))
    generated = data.get("generated_at", "")[:19].replace("T", " ") + " UTC"

    # Filter: English, above threshold, not already seen
    english = [
        it for it in items
        if (it.get("title_en") or (it.get("title") and not has_cjk(str(it.get("title", "")))))
        and it.get("ai_score", 0) >= MIN_SCORE
        and it.get("url", "") not in seen_urls
    ]

    eng_pool = [it for it in english if is_engineering(it)]
    gen_pool = [it for it in english if not is_engineering(it)]

    eng_ranked = sorted(
        eng_pool,
        key=lambda x: (x.get("ai_score", 0) + ENG_BOOST, x.get("published", "")),
        reverse=True
    )[:ENG_CAP]

    gen_ranked = sorted(
        gen_pool,
        key=lambda x: (x.get("ai_score", 0), x.get("published", "")),
        reverse=True
    )

    # Separate OPML RSS for content categorisation; other sources group by name
    gen_opml = [it for it in gen_ranked if (it.get("site_name") or "") == "OPML RSS"]
    gen_other = [it for it in gen_ranked if (it.get("site_name") or "") != "OPML RSS"]

    by_source: dict[str, list] = defaultdict(list)
    for item in gen_other:
        site = item.get("site_name") or "Other"
        by_source[site].append(item)

    showing = len(eng_ranked) + len(gen_other) + len(gen_opml)
    header = (
        f"**AI News Digest** — {generated}\n"
        f"{total_raw} total scraped · {len(english)} new · showing {showing} "
        f"· {sources_ok} sources OK · {sources_fail} failed"
    )

    # Build sections: Builder Engineering first, then everything sorted by best score
    non_eng_sections: list[tuple[str, list]] = []
    for site, items in by_source.items():
        non_eng_sections.append((site, items))
    if gen_opml:
        non_eng_sections.extend(categorize_opml_items(gen_opml))
    non_eng_sections.sort(
        key=lambda x: max(i.get("ai_score", 0) for i in x[1]),
        reverse=True,
    )

    sections = []
    if eng_ranked:
        sections.append(("Builder Engineering", eng_ranked))
    sections.extend(non_eng_sections)

    # Identify top story candidates: news items only (exclude tweets and official blog/release sections)
    _NON_NEWS_SOURCES = {"Follow Builders", "Official AI Updates", "Builder Engineering"}

    def is_tweet(item):
        url = item.get("url", "")
        return "x.com/" in url or "twitter.com/" in url

    all_non_tweet = [
        (it, src)
        for src, its in sections
        for it in its
        if not is_tweet(it) and src not in _NON_NEWS_SOURCES
    ]
    all_non_tweet.sort(key=lambda x: x[0].get("ai_score", 0), reverse=True)

    top_story_urls: set = set()
    top_stories: list = []
    for item, source in all_non_tweet[:TOP_STORIES_COUNT]:
        top_stories.append({
            "title": item.get("title_en") or item.get("title", ""),
            "url": item.get("url", ""),
            "score": item.get("ai_score", 0),
            "source": source,
        })
        top_story_urls.add(item.get("url", ""))

    # Remove top story items from sections; drop sections that become empty
    filtered_sections = []
    for source, items in sections:
        kept = [it for it in items if it.get("url", "") not in top_story_urls]
        if kept:
            filtered_sections.append((source, kept))

    return header, filtered_sections, english, top_stories


_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FFFF☀-➿︀-️‍]+"
)

def _safe_link_title(title: str) -> str:
    """Strip characters that break markdown link rendering: emoji, embedded URLs, brackets."""
    title = _EMOJI_RE.sub("", title)
    title = re.sub(r"https?://\S+", "", title)
    title = re.sub(r"[\[\]]", "", title)
    return title.strip()


def render_item(item, discord=False) -> str:
    title = item.get("title_en") or item.get("title", "")
    url = item.get("url", "")
    score = item.get("ai_score", 0)
    if discord:
        return f"- [{_safe_link_title(title)}](<{url}>) · {score:.2f}"
    return f"- [{title}]({url}) · {score:.2f}"


def make_discord_chunks(header: str, sections: list) -> list:
    """Split into Discord-safe message strings (≤ DISCORD_LIMIT chars each).

    Uses actual assembled chunk length as the guard, not estimated byte counts,
    so the hard limit is enforced regardless of header variation.
    """
    chunks = [header]

    for source, items in sections:
        total = len(items)
        part_batches: list[list[str]] = []
        current_lines: list[str] = []

        # Worst-case header for size estimation: cont. 99/99 variant
        def worst_header(src: str) -> str:
            return f"**{src}** (cont. 99/99)"

        for item in items:
            line = render_item(item, discord=True)
            candidate = current_lines + [line]
            test_chunk = worst_header(source) + "\n" + "\n".join(candidate)
            if current_lines and len(test_chunk) > DISCORD_LIMIT:
                part_batches.append(current_lines)
                current_lines = [line]
            else:
                current_lines.append(line)

        if current_lines:
            part_batches.append(current_lines)

        total_parts = len(part_batches)
        for idx, lines in enumerate(part_batches):
            p = idx + 1
            if total_parts == 1:
                section_header = f"**{source}** ({total})"
            elif p == 1:
                section_header = f"**{source}** ({total}) — {p}/{total_parts}"
            else:
                section_header = f"**{source}** (cont. {p}/{total_parts})"
            chunk_text = section_header + "\n" + "\n".join(lines)
            assert len(chunk_text) <= DISCORD_LIMIT, f"chunk overflow: {len(chunk_text)} chars"
            chunks.append(chunk_text)

    return chunks


def format_digest_flat(header: str, sections: list) -> str:
    """Flat markdown for file output (no angle brackets)."""
    parts = [header, ""]
    for source, items in sections:
        parts.append(f"**{source}** ({len(items)})")
        for item in items:
            parts.append(render_item(item, discord=False))
        parts.append("")
    return "\n".join(parts)


if __name__ == "__main__":
    skip_scrape = "--no-scrape" in sys.argv
    if not skip_scrape:
        ok, err = run_scraper()
        if not ok:
            print(f"Scraper error:\n{err}", file=sys.stderr)

    data, status = load_digest()
    seen_urls = load_seen_urls()

    header, sections, english, top_stories = build_digest(data, status, seen_urls)

    flat = format_digest_flat(header, sections)
    print(flat)
    DIGEST_OUTPUT.write_text(flat, encoding="utf-8")

    chunks = make_discord_chunks(header, sections)
    DISCORD_OUTPUT.write_text(json.dumps(chunks, indent=2, ensure_ascii=False))

    TOP_STORIES_OUTPUT.write_text(json.dumps(top_stories, indent=2, ensure_ascii=False))

    all_urls = [it.get("url", "") for it in english if it.get("url")]
    save_seen_urls(all_urls)
