"""Convert one book from the library queue into an audiobook."""

from __future__ import annotations

import os
import time

from extract import extract
from store import dump_compact
from synth import SAMPLE_RATE, VOICES, AacWriter, align_words, copy_prefix

PART_SIZE = 40 * 1024 * 1024  # GitHub blobs must stay under 100 MB
PROGRESS_EVERY = 30  # seconds between progress updates written to the library

# Silence between pieces of text, in seconds.
GAP_SENTENCE = 0.12
GAP_PARAGRAPH = 0.45
GAP_HEADING = 0.8
GAP_CHAPTER = 1.2

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")


class Cancelled(Exception):
    pass


def convert_book(store, engine, book_id: str, report, cancelled=lambda: False) -> None:
    """report(progress 0..1, message) is called often; it's shown on the PC and synced to the phone."""
    meta = store.get_book(book_id)
    kind = meta.get("format", "pdf")
    last_sync = [0.0]

    def status(progress, message, force=False):
        report(progress, message)
        if force or time.time() - last_sync[0] > PROGRESS_EVERY:
            last_sync[0] = time.time()

            def change(b):
                b["status"] = "converting"
                b["progress"] = round(progress, 3)
                b["message"] = message

            try:
                store.update_book(book_id, change, f"Converting {meta.get('title', book_id)}")
            except Exception:
                pass  # progress sync is best-effort

    status(0, "Reading the book", force=True)
    source = store.read(f"books/{book_id}/source.{kind}")
    if source is None:
        raise RuntimeError("The uploaded book file is missing from the library.")

    book, segs = extract(source, kind, lambda i, n: report(0.05 * i / n, f"Reading page {i} of {n}"))
    if not segs:
        raise RuntimeError("No readable text was found in this book.")
    if book.ocr_pages:
        report(0.05, f"Recognised text on {book.ocr_pages} scanned page(s)")

    # Re-voicing keeps the audio before the chosen point and only redoes the rest.
    revoice = meta.get("revoice") or None
    voice = (revoice or {}).get("voice") or meta.get("voice") or "af_heart"
    if voice not in VOICES:
        voice = "af_heart"
    start_seg, prefix_seconds, old_audio = 0, 0.0, None
    os.makedirs(CACHE_DIR, exist_ok=True)
    cached_audio = os.path.join(CACHE_DIR, f"{book_id}.m4a")
    if revoice and meta.get("audio"):
        old_manifest = _load_json(store.read(f"books/{book_id}/manifest.json"))
        if old_manifest and len(old_manifest["segs"]) == len(segs):
            frm = float(revoice.get("from") or 0)
            start_seg = next(
                (i for i, s in enumerate(old_manifest["segs"]) if s["b"] > frm), len(segs) - 1
            )
            start_seg = max(0, start_seg)
            prefix_seconds = old_manifest["segs"][start_seg]["a"] if start_seg else 0.0
            if start_seg:
                old_audio = _local_audio(store, meta, cached_audio)
                old_times = old_manifest["segs"][:start_seg]
        if not old_audio:
            start_seg, prefix_seconds = 0, 0.0

    tmp_path = cached_audio + ".part"
    writer = AacWriter(tmp_path)
    out_segs = []
    try:
        if old_audio:
            status(0.06, "Keeping the audio before your re-voice point")
            copy_prefix(old_audio, writer, prefix_seconds)
            out_segs.extend(old_times)

        total_chars = sum(len(s.text) for s in segs[start_seg:]) or 1
        done_chars = 0
        started = time.time()
        for i in range(start_seg, len(segs)):
            if cancelled():
                raise Cancelled()
            seg = segs[i]
            if i > 0:
                writer.silence(
                    GAP_CHAPTER if seg.chapter
                    else GAP_HEADING if seg.heading or segs[i - 1].heading
                    else GAP_PARAGRAPH if seg.para_start
                    else GAP_SENTENCE
                )
            start = writer.seconds
            audio, tokens = engine.speak(seg.text, voice)
            writer.write(audio)
            end = writer.seconds
            out_segs.append(_seg_json(seg, start, end, align_words(seg.text, seg.words, tokens, start, end)))

            done_chars += len(seg.text)
            frac = done_chars / total_chars
            eta = (time.time() - started) / frac * (1 - frac) if frac > 0.02 else None
            msg = f"Page {book.pages[seg.page]['label'] if seg.page < len(book.pages) else seg.page + 1}"
            if eta is not None:
                msg += f" · about {_fmt_eta(eta)} left"
            status(0.06 + 0.86 * frac, msg)
        writer.close()
    except BaseException:
        try:
            writer.close()
        except Exception:
            pass
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    os.replace(tmp_path, cached_audio)
    duration = writer.seconds

    status(0.93, "Uploading audio to your library", force=True)
    with open(cached_audio, "rb") as f:
        data = f.read()
    parts = [data[i : i + PART_SIZE] for i in range(0, len(data), PART_SIZE)]
    stored = store.put_audio(book_id, parts)

    manifest = {
        "v": 1,
        "kind": kind,
        "duration": round(duration, 3),
        "pages": book.pages,
        "chapters": _chapters(book, segs),
        "segs": out_segs,
    }
    files = {f"books/{book_id}/manifest.json": dump_compact(manifest)}
    if book.cover_jpeg:
        files[f"books/{book_id}/cover.jpg"] = book.cover_jpeg
    store.commit(files, f"Manifest for {meta.get('title', book_id)}")

    def finish(b):
        b["status"] = "ready"
        b["progress"] = 1
        b["message"] = ""
        b["voice"] = voice
        b.pop("revoice", None)
        if not b.get("title") and book.title:
            b["title"] = book.title
        if not b.get("author") and book.author:
            b["author"] = book.author
        b["pages"] = len(book.pages)
        b["hasCover"] = bool(book.cover_jpeg)
        b["audio"] = {
            "parts": stored,
            "size": len(data),
            "duration": round(duration, 3),
            "mime": "audio/mp4",
            "version": int((b.get("audio") or {}).get("version", 0)) + 1,
        }

    store.update_book(book_id, finish, f"Finished {meta.get('title', book_id)}")
    report(1, "Done")


def _seg_json(seg, start, end, words):
    out = {"a": round(start, 3), "b": round(end, 3), "p": seg.page, "x": seg.text, "w": words}
    if seg.rects:
        out["r"] = [[r[0]] + [round(v, 4) for v in r[1:]] for r in seg.rects]
    if seg.para_start:
        out["ps"] = 1
    if seg.heading:
        out["h"] = 1
    return out


def _chapters(book, segs):
    chapters = []
    if book.toc:
        for title, page in book.toc:
            idx = next((i for i, s in enumerate(segs) if s.page >= page), None)
            if idx is not None and (not chapters or chapters[-1]["seg"] != idx):
                chapters.append({"title": title, "seg": idx})
    else:
        for i, s in enumerate(segs):
            if s.chapter:
                chapters.append({"title": s.chapter, "seg": i})
    return chapters


def _local_audio(store, meta, cached_audio):
    """Path to this book's current audio, downloading it if this PC doesn't have it."""
    audio = meta.get("audio") or {}
    if os.path.exists(cached_audio) and os.path.getsize(cached_audio) == audio.get("size"):
        return cached_audio
    try:
        data = b"".join(store.read_blob(p["sha"]) for p in audio.get("parts", []))
    except Exception:
        return None
    if not data:
        return None
    with open(cached_audio, "wb") as f:
        f.write(data)
    return cached_audio


def _load_json(data):
    import json

    return json.loads(data) if data else None


def _fmt_eta(seconds: float) -> str:
    if seconds < 60:
        return "under a minute"
    minutes = round(seconds / 60)
    return f"{minutes} min" if minutes < 90 else f"{minutes / 60:.1f} h"


def make_voice_samples(store, engine, report=lambda p, m: None) -> None:
    """Short clips of every voice so the app can preview them instantly."""
    import tempfile

    files = {}
    for n, (voice, name) in enumerate(VOICES.items()):
        report(n / len(VOICES), f"Recording a sample of {name}")
        text = (
            f"Hi, I'm {name}. The evening was quiet, and the old house seemed to listen "
            "as the story began."
        )
        audio, _ = engine.speak(text, voice)
        fd, path = tempfile.mkstemp(suffix=".m4a")
        os.close(fd)
        w = AacWriter(path, bitrate=64000)
        w.silence(0.1)
        w.write(audio)
        w.close()
        with open(path, "rb") as f:
            files[f"voices/{voice}.m4a"] = f.read()
        os.remove(path)
    store.commit(files, "Voice samples")
    report(1, "Voice samples ready")


__all__ = ["convert_book", "make_voice_samples", "Cancelled", "SAMPLE_RATE"]
