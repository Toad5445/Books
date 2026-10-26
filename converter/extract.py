"""Turn a PDF or EPUB into a list of spoken segments (sentences).

Every segment remembers which page it came from and, for PDFs, where on the
page its words sit, so the app can link the audio timeline to pages and
highlight text on the original page while it is read aloud.

Pages without a usable text layer (scans, photos) are run through OCR.
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field

# Characters per synthetic "page" for EPUBs, which have no fixed pages.
EPUB_PAGE_CHARS = 1800
# Longest sentence we send to the voice in one go before splitting it.
MAX_SEGMENT_CHARS = 320


@dataclass
class Word:
    text: str
    page: int  # 0-based page index
    rect: tuple[float, float, float, float] | None = None  # normalised x0, y0, x1, y1


@dataclass
class Paragraph:
    words: list[Word]
    heading: bool = False
    chapter: str | None = None  # set on the first paragraph of a chapter


@dataclass
class Segment:
    text: str
    page: int
    words: list[tuple[int, int]]  # char offsets of each word in text
    rects: list[tuple[int, float, float, float, float]]  # page, x0, y0, x1, y1
    para_start: bool = False
    heading: bool = False
    chapter: str | None = None


@dataclass
class Book:
    kind: str
    title: str | None = None
    author: str | None = None
    pages: list[dict] = field(default_factory=list)  # per page: w, h, label, ocr
    paragraphs: list[Paragraph] = field(default_factory=list)
    cover_jpeg: bytes | None = None
    ocr_pages: int = 0
    toc: list[tuple[str, int]] = field(default_factory=list)  # PDF outline: title, page


# ---------------------------------------------------------------- PDF


def _norm_repeat_key(text: str) -> str:
    return re.sub(r"\d+", "#", text.strip().lower())


def _is_page_number(text: str) -> bool:
    t = text.strip().lower()
    return bool(re.fullmatch(r"(page\s+)?[\divxlc]+(\s+of\s+\d+)?", t)) and len(t) < 16


def _ocr_page(page, ocr) -> list[list[tuple[str, tuple[float, float, float, float]]]]:
    """OCR a page. Returns blocks -> list of (word, rect in page points)."""

    zoom = 2.5
    pix = page.get_pixmap(matrix=__import__("pymupdf").Matrix(zoom, zoom), alpha=False)
    result, _ = ocr(pix.tobytes("png"))
    lines = []
    for box, text, score in result or []:
        if not text.strip() or float(score) < 0.5:
            continue
        xs = [p[0] / zoom for p in box]
        ys = [p[1] / zoom for p in box]
        lines.append((min(xs), min(ys), max(xs), max(ys), text.strip()))
    lines.sort(key=lambda ln: (round(ln[1] / 6), ln[0]))

    # Group lines into paragraphs by vertical gaps.
    blocks: list[list[tuple[str, tuple[float, float, float, float]]]] = []
    prev = None
    for x0, y0, x1, y1, text in lines:
        h = y1 - y0
        if prev is None or y0 - prev[3] > 0.9 * h or abs(x0 - prev[0]) > 6 * h:
            blocks.append([])
        # Split the line into words, spreading the line box by character count.
        parts = text.split()
        total = sum(len(p) for p in parts) + max(len(parts) - 1, 0)
        cursor = 0
        for p in parts:
            a = x0 + (x1 - x0) * cursor / max(total, 1)
            cursor += len(p)
            b = x0 + (x1 - x0) * cursor / max(total, 1)
            cursor += 1
            blocks[-1].append((p, (a, y0, b, y1)))
        prev = (x0, y0, x1, y1)
    return blocks


def extract_pdf(data: bytes, progress=None) -> Book:
    import pymupdf as fitz

    doc = fitz.open(stream=data, filetype="pdf")
    book = Book(kind="pdf")
    meta = doc.metadata or {}
    book.title = (meta.get("title") or "").strip() or None
    book.author = (meta.get("author") or "").strip() or None
    labels = []
    try:
        labels = [doc[i].get_label() or str(i + 1) for i in range(len(doc))]
    except Exception:
        labels = [str(i + 1) for i in range(len(doc))]

    ocr = None
    raw_pages = []  # per page: list of blocks, block = list of (word, rect)
    for i, page in enumerate(doc):
        w, h = page.rect.width, page.rect.height
        words = page.get_text("words", sort=True)
        text_chars = sum(len(x[4]) for x in words)
        used_ocr = False
        if text_chars < 25 and (page.get_images() or page.get_drawings()):
            if ocr is None:
                from rapidocr_onnxruntime import RapidOCR

                ocr = RapidOCR()
            blocks = _ocr_page(page, ocr)
            used_ocr = bool(blocks)
            book.ocr_pages += 1 if used_ocr else 0
        else:
            by_block: dict[int, list] = {}
            for x0, y0, x1, y1, word, block_no, line_no, word_no in words:
                by_block.setdefault(block_no, []).append((word, (x0, y0, x1, y1)))
            blocks = list(by_block.values())
        raw_pages.append((w, h, blocks))
        book.pages.append({"w": round(w, 1), "h": round(h, 1), "label": labels[i], "ocr": used_ocr})
        if progress:
            progress(i + 1, len(doc))

    # Drop running headers/footers: short blocks near the top or bottom edge
    # that repeat across pages, and lone page numbers.
    edge_keys: Counter[str] = Counter()
    for w, h, blocks in raw_pages:
        for blk in blocks:
            y0 = min(r[1] for _, r in blk)
            y1 = max(r[3] for _, r in blk)
            text = " ".join(t for t, _ in blk)
            if (y1 < h * 0.1 or y0 > h * 0.9) and len(text) < 90:
                edge_keys[_norm_repeat_key(text)] += 1
    repeat_min = max(3, len(raw_pages) // 10)

    for pi, (w, h, blocks) in enumerate(raw_pages):
        for blk in blocks:
            text = " ".join(t for t, _ in blk)
            y0 = min(r[1] for _, r in blk)
            y1 = max(r[3] for _, r in blk)
            at_edge = y1 < h * 0.1 or y0 > h * 0.9
            if at_edge and (_is_page_number(text) or edge_keys[_norm_repeat_key(text)] >= repeat_min):
                continue
            ws = [
                Word(t, pi, (r[0] / w, r[1] / h, r[2] / w, r[3] / h))
                for t, r in blk
            ]
            book.paragraphs.append(Paragraph(ws))

    _merge_hyphens_and_page_breaks(book.paragraphs)

    try:
        book.toc = [(t.strip(), p - 1) for lvl, t, p, *_ in doc.get_toc() if lvl == 1 and p > 0 and t.strip()]
    except Exception:
        pass

    try:
        pix = doc[0].get_pixmap(matrix=fitz.Matrix(0.6, 0.6), alpha=False)
        book.cover_jpeg = pix.tobytes("jpeg")
    except Exception:
        pass
    return book


def _merge_hyphens_and_page_breaks(paragraphs: list[Paragraph]) -> None:
    # Re-join words hyphenated across lines ("exam-" + "ple").
    for para in paragraphs:
        out: list[Word] = []
        for wd in para.words:
            if out and out[-1].text.endswith("-") and len(out[-1].text) > 2 and wd.text[:1].islower():
                prev = out[-1]
                out[-1] = Word(prev.text[:-1] + wd.text, prev.page, prev.rect)
                out.append(Word("", wd.page, wd.rect))  # keep the rect for highlighting
                continue
            out.append(wd)
        para.words = out

    # A paragraph cut by a page break continues on the next page in lowercase.
    i = 0
    while i < len(paragraphs) - 1:
        a, b = paragraphs[i], paragraphs[i + 1]
        last = next((w.text for w in reversed(a.words) if w.text), "")
        first = next((w.text for w in b.words if w.text), "")
        if (
            a.words
            and b.words
            and a.words[-1].page != b.words[0].page
            and not re.search(r"[.!?:\"”’)]$", last)
            and first[:1].islower()
        ):
            a.words.extend(b.words)
            del paragraphs[i + 1]
            continue
        i += 1


# ---------------------------------------------------------------- EPUB

_BLOCK_TAGS = {
    "p", "div", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
    "dt", "dd", "td", "th", "figcaption", "section", "article", "aside", "header", "footer",
}
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


def _epub_blocks(soup):
    """Yield (text, is_heading) for leaf-level block elements in reading order."""
    body = soup.find("body") or soup
    for el in body.find_all(True):
        name = el.name.lower().split(":")[-1]
        if name not in _BLOCK_TAGS:
            continue
        if any(c.name and c.name.lower().split(":")[-1] in _BLOCK_TAGS for c in el.find_all(True)):
            # Not a leaf: only take text that sits directly inside it.
            direct = " ".join(
                s.strip() for s in el.find_all(string=True, recursive=False) if s.strip()
            )
            if direct:
                yield direct, name in _HEADINGS
            continue
        text = " ".join(el.get_text(" ").split())
        if text:
            yield text, name in _HEADINGS


def extract_epub(data: bytes, progress=None) -> Book:
    from bs4 import BeautifulSoup

    z = zipfile.ZipFile(io.BytesIO(data))
    container = BeautifulSoup(z.read("META-INF/container.xml"), "xml")
    opf_path = container.find("rootfile")["full-path"]
    opf_dir = posixpath.dirname(opf_path)
    opf = BeautifulSoup(z.read(opf_path), "xml")

    def resolve(href):
        from urllib.parse import unquote

        return posixpath.normpath(posixpath.join(opf_dir, unquote(href.split("#")[0])))

    book = Book(kind="epub")
    t = opf.find("title")
    a = opf.find("creator")
    book.title = t.get_text(strip=True) if t else None
    book.author = a.get_text(strip=True) if a else None

    manifest = {}
    cover_href = None
    for item in opf.find_all("item"):
        manifest[item.get("id")] = item
        if "cover-image" in (item.get("properties") or ""):
            cover_href = item.get("href")
    meta_cover = opf.find("meta", attrs={"name": "cover"})
    if not cover_href and meta_cover and meta_cover.get("content") in manifest:
        cover_href = manifest[meta_cover["content"]].get("href")
    if cover_href:
        try:
            book.cover_jpeg = _to_jpeg(z.read(resolve(cover_href)))
        except Exception:
            pass

    # Chapter titles from the table of contents, keyed by document path.
    toc_titles = _epub_toc_titles(z, opf, manifest, resolve)

    spine = [it for it in opf.find_all("itemref") if it.get("linear", "yes") != "no"]
    chars = 0
    for n, ref in enumerate(spine):
        item = manifest.get(ref.get("idref"))
        if item is None or "nav" in (item.get("properties") or ""):
            continue
        path = resolve(item.get("href"))
        try:
            soup = BeautifulSoup(z.read(path), "lxml")
        except KeyError:
            continue
        first = True
        for text, heading in _epub_blocks(soup):
            words = []
            for w in text.split():
                words.append(Word(w, chars // EPUB_PAGE_CHARS))
                chars += len(w) + 1
            para = Paragraph(words, heading=heading)
            if first:
                para.chapter = toc_titles.get(path) or (text[:80] if heading else None)
                first = False
            book.paragraphs.append(para)
        if progress:
            progress(n + 1, len(spine))

    pages = chars // EPUB_PAGE_CHARS + 1
    book.pages = [{"label": str(i + 1)} for i in range(pages)]
    return book


def _epub_toc_titles(z, opf, manifest, resolve) -> dict[str, str]:
    from bs4 import BeautifulSoup

    titles: dict[str, str] = {}
    try:
        nav = next((i for i in manifest.values() if "nav" in (i.get("properties") or "")), None)
        if nav is not None:
            nav_path = resolve(nav.get("href"))
            soup = BeautifulSoup(z.read(nav_path), "lxml")
            base = posixpath.dirname(nav_path)
            for a in soup.find_all("a", href=True):
                p = posixpath.normpath(posixpath.join(base, a["href"].split("#")[0]))
                titles.setdefault(p, " ".join(a.get_text(" ").split()))
        else:
            spine = opf.find("spine")
            ncx_id = spine.get("toc") if spine else None
            if ncx_id and ncx_id in manifest:
                ncx_path = resolve(manifest[ncx_id].get("href"))
                soup = BeautifulSoup(z.read(ncx_path), "xml")
                base = posixpath.dirname(ncx_path)
                for np_ in soup.find_all("navPoint"):
                    label = np_.find("text")
                    content = np_.find("content")
                    if label and content:
                        p = posixpath.normpath(posixpath.join(base, content["src"].split("#")[0]))
                        titles.setdefault(p, label.get_text(strip=True))
    except Exception:
        pass
    return titles


def _to_jpeg(img_bytes: bytes) -> bytes:
    import pymupdf as fitz

    pix = fitz.Pixmap(img_bytes)
    if pix.alpha or pix.n > 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    scale = min(1.0, 500 / max(pix.width, pix.height))
    if scale < 1:
        pix = fitz.Pixmap(pix, int(pix.width * scale), int(pix.height * scale), None)
    return pix.tobytes("jpeg")


# ---------------------------------------------------------------- sentences

_ABBREV = {
    "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "etc", "e.g", "i.e",
    "mt", "no", "fig", "vol", "ch", "capt", "col", "gen", "lt", "sgt", "rev", "gov",
}


def _ends_sentence(word: str, nxt: str | None) -> bool:
    w = word.rstrip("\"'”’)]»")
    if not w or w[-1] not in ".!?…":
        return False
    if w[-1] == ".":
        core = w[:-1].lower().lstrip("\"'“‘([«")
        if core in _ABBREV or re.fullmatch(r"[a-z]", core):
            return False
    if nxt and nxt[:1].islower():
        return False
    return True


def _clean(word: str) -> str:
    return word.replace("­", "").replace("ﬁ", "fi").replace("ﬂ", "fl")


def segment(book: Book) -> list[Segment]:
    segs: list[Segment] = []
    for para in book.paragraphs:
        words = [w for w in para.words if w.text or w.rect]
        cur: list[Word] = []
        first_in_para = True

        def flush():
            nonlocal first_in_para
            if not any(w.text for w in cur):
                cur.clear()
                return
            text_parts, offsets, pos = [], [], 0
            for w in cur:
                if not w.text:
                    continue
                t = _clean(w.text)
                offsets.append((pos, pos + len(t)))
                text_parts.append(t)
                pos += len(t) + 1
            rects = _merge_rects(cur)
            segs.append(
                Segment(
                    text=" ".join(text_parts),
                    page=next(w.page for w in cur if w.text),
                    words=offsets,
                    rects=rects,
                    para_start=first_in_para,
                    heading=para.heading,
                    chapter=para.chapter if first_in_para else None,
                )
            )
            first_in_para = False
            cur.clear()

        length = 0
        for i, w in enumerate(words):
            cur.append(w)
            length += len(w.text) + 1
            nxt = next((x.text for x in words[i + 1 :] if x.text), None)
            if w.text and _ends_sentence(w.text, nxt):
                flush()
                length = 0
            elif length > MAX_SEGMENT_CHARS and w.text and (w.text[-1] in ",;:—" or length > MAX_SEGMENT_CHARS * 1.5):
                flush()
                length = 0
        flush()
    return segs


def _merge_rects(words: list[Word]) -> list[tuple[int, float, float, float, float]]:
    rects: list[list] = []
    for w in words:
        if not w.rect:
            continue
        x0, y0, x1, y1 = w.rect
        if rects:
            r = rects[-1]
            cy, ry = (y0 + y1) / 2, (r[2] + r[4]) / 2
            if r[0] == w.page and abs(cy - ry) < (y1 - y0) * 0.6 and x0 >= r[1] - 0.01:
                r[1], r[2] = min(r[1], x0), min(r[2], y0)
                r[3], r[4] = max(r[3], x1), max(r[4], y1)
                continue
        rects.append([w.page, x0, y0, x1, y1])
    return [tuple(r) for r in rects]


def extract(data: bytes, kind: str, progress=None) -> tuple[Book, list[Segment]]:
    book = extract_pdf(data, progress) if kind == "pdf" else extract_epub(data, progress)
    return book, segment(book)
