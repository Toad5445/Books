"""Books converter for your PC.

Run start.bat (or `python server.py`). It opens the Books app in your browser
at http://localhost:8765, where queued books get a Convert button.
"""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.normpath(os.path.join(HERE, "..", "app"))
CONFIG_PATH = os.path.join(HERE, "config.json")
PORT = int(os.environ.get("BOOKS_PORT", "8765"))

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=1)


class Worker:
    """Runs conversions one at a time in the background."""

    def __init__(self):
        self.config = load_config()
        self.jobs: dict[str, dict] = {}  # id -> {state, progress, message}
        self.queue: queue.Queue = queue.Queue()
        self.engine = None
        self.engine_state = {"state": "idle", "device": None, "message": ""}
        self.current = None
        self.cancel_flag = set()
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()
        threading.Thread(target=self._warm_up, daemon=True).start()

    def store(self):
        from store import GitHubStore

        if not self.config.get("repo") or not self.config.get("token"):
            raise RuntimeError("Connect your library first (Settings → Library).")
        return GitHubStore(self.config["repo"], self.config["token"])

    def _load_engine(self):
        with self.lock:
            if self.engine is not None:
                return self.engine
            self.engine_state = {"state": "loading", "device": None, "message": "Loading Kokoro voice model"}
            try:
                from synth import Engine

                self.engine = Engine()
                self.engine_state = {"state": "ready", "device": self.engine.device, "message": ""}
            except Exception as e:
                traceback.print_exc()
                self.engine_state = {"state": "error", "device": None, "message": str(e)}
                raise
            return self.engine

    def _warm_up(self):
        try:
            self._load_engine()
        except Exception:
            return
        self.ensure_voice_samples()

    def ensure_voice_samples(self, force=False):
        try:
            st = self.store()
            if not force and any(p.startswith("voices/") for p in st.tree()):
                return
        except Exception:
            return
        self.submit("__voices__")

    def submit(self, book_id: str):
        with self.lock:
            job = self.jobs.get(book_id)
            if job and job["state"] in ("waiting", "running"):
                return
            self.jobs[book_id] = {"state": "waiting", "progress": 0, "message": "Waiting its turn"}
        self.queue.put(book_id)

    def cancel(self, book_id: str):
        self.cancel_flag.add(book_id)
        job = self.jobs.get(book_id)
        if job and job["state"] == "waiting":
            job.update(state="cancelled", message="Cancelled")

    def _run(self):
        from convert import Cancelled, convert_book, make_voice_samples

        while True:
            book_id = self.queue.get()
            job = self.jobs.get(book_id)
            if not job or job["state"] == "cancelled":
                self.cancel_flag.discard(book_id)
                continue
            self.current = book_id
            job.update(state="running", progress=0, message="Starting")

            def report(p, m, job=job):
                job["progress"], job["message"] = p, m

            try:
                engine = self._load_engine()
                st = self.store()
                if book_id == "__voices__":
                    make_voice_samples(st, engine, report)
                else:
                    convert_book(st, engine, book_id, report, lambda: book_id in self.cancel_flag)
                job.update(state="done", progress=1, message="Done")
            except Cancelled:
                job.update(state="cancelled", message="Cancelled")
                self._set_status(book_id, "queued", "")
            except Exception as e:
                traceback.print_exc()
                job.update(state="error", message=str(e))
                if book_id != "__voices__":
                    self._set_status(book_id, "error", str(e))
            finally:
                self.cancel_flag.discard(book_id)
                self.current = None

    def _set_status(self, book_id, status, message):
        try:
            def change(b):
                b["status"] = status
                b["message"] = message
                b["progress"] = 0

            self.store().update_book(book_id, change, f"{status}: {book_id}")
        except Exception:
            pass


WORKER: Worker | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "BooksConverter/1"

    def log_message(self, fmt, *args):  # keep the console readable
        if "/api/" in (args[0] if args else ""):
            return
        sys.stderr.write("  " + fmt % args + "\n")

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("localhost", "127.0.0.1")

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def _api_allowed(self) -> bool:
        # The custom header can't be sent cross-site without a CORS preflight,
        # which this server never approves, so other websites can't use the API.
        if not self._host_ok() or self.headers.get("X-Books") != "1":
            self._json(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            if not self._api_allowed():
                return
            w = WORKER
            if path == "/api/pc/status":
                return self._json(
                    200,
                    {
                        "ok": True,
                        "engine": w.engine_state,
                        "jobs": w.jobs,
                        "current": w.current,
                        "configured": bool(w.config.get("repo") and w.config.get("token")),
                    },
                )
            if path == "/api/pc/config":
                return self._json(200, {"repo": w.config.get("repo", ""), "token": w.config.get("token", "")})
            return self._json(404, {"error": "not found"})
        self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._api_allowed():
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        w = WORKER
        if path == "/api/pc/config":
            w.config = {"repo": body.get("repo", "").strip(), "token": body.get("token", "").strip()}
            save_config(w.config)
            threading.Thread(target=w.ensure_voice_samples, daemon=True).start()
            return self._json(200, {"ok": True})
        if path == "/api/pc/convert":
            for book_id in body.get("ids", []):
                w.submit(str(book_id))
            return self._json(200, {"ok": True})
        if path == "/api/pc/cancel":
            w.cancel(str(body.get("id")))
            return self._json(200, {"ok": True})
        if path == "/api/pc/voice-samples":
            w.ensure_voice_samples(force=True)
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})

    def _static(self, path):
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(APP_DIR, rel))
        if not full.startswith(APP_DIR) or not os.path.isfile(full):
            full = os.path.join(APP_DIR, "index.html")
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self._send(200, data, ctype)


def disable_quick_edit():
    """Clicking inside a Windows console window starts a text selection that
    freezes the program until Esc is pressed. Turn that off for this window."""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)  # standard input
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, (mode.value & ~0x0040) | 0x0080)  # quick edit off
    except Exception:
        pass


def main():
    global WORKER
    disable_quick_edit()
    WORKER = Worker()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}/"
    print(f"\n  Books converter is running at {url}")
    print("  Keep this window open while converting. Close it to stop.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
