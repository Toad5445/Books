"""The library lives in a private GitHub repo. This module reads and writes it.

Layout of the library repo (default branch):
    books/<id>/book.json      status, voice, title ... (written by phone and PC)
    books/<id>/source.pdf     the uploaded book (or source.epub)
    books/<id>/manifest.json  text, pages and timings (written by the PC)
    books/<id>/cover.jpg      cover image (written by the PC)
    voices/<voice>.m4a        voice samples (written by the PC)
Audio is stored as blobs on a branch per book, audio/<id>, so deleting a
book's audio frees the space instead of staying in the main history.
"""

from __future__ import annotations

import base64
import json
import os
import time

import requests

API = os.environ.get("BOOKS_GITHUB_API", "https://api.github.com")  # overridable for testing


class StoreError(Exception):
    pass


class GitHubStore:
    def __init__(self, repo: str, token: str):
        self.repo = repo.strip().strip("/")
        self.s = requests.Session()
        self.s.headers.update(
            {
                "Authorization": f"Bearer {token.strip()}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        )
        self._branch = None

    # -- low level

    def _req(self, method, path, ok=(200, 201), **kw):
        url = path if path.startswith("http") else f"{API}/repos/{self.repo}{path}"
        for attempt in range(5):
            try:
                r = self.s.request(method, url, timeout=600, **kw)
            except requests.RequestException as e:
                if attempt == 4:
                    raise StoreError(f"Network error talking to GitHub: {e}") from e
                time.sleep(2 ** attempt)
                continue
            if r.status_code in ok:
                return r
            if r.status_code >= 500 or r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            return r
        return r

    def _json(self, method, path, **kw):
        r = self._req(method, path, **kw)
        if r.status_code not in (200, 201):
            raise StoreError(f"GitHub {method} {path} failed: {r.status_code} {r.text[:300]}")
        return r.json()

    @property
    def branch(self) -> str:
        if self._branch is None:
            info = self._json("GET", "")
            self._branch = info.get("default_branch") or "main"
        return self._branch

    def check(self) -> dict:
        r = self._req("GET", "")
        if r.status_code == 404:
            raise StoreError("Library repo not found. Check the name and that the token can access it.")
        if r.status_code == 401:
            raise StoreError("GitHub rejected the token.")
        info = r.json()
        return {"private": info.get("private"), "name": info.get("full_name")}

    def _head(self, branch: str | None = None) -> str | None:
        r = self._req("GET", f"/git/ref/heads/{branch or self.branch}")
        if r.status_code == 409:  # empty repository
            return None
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise StoreError(f"Could not read branch: {r.status_code} {r.text[:200]}")
        return r.json()["object"]["sha"]

    def _bootstrap(self) -> None:
        body = {
            "message": "Create audiobook library",
            "content": base64.b64encode(b"# Audiobook library\n\nManaged by the Books app.\n").decode(),
        }
        self._req("PUT", "/contents/README.md", json=body)

    def ensure_ready(self) -> None:
        """A brand-new empty repo can't hold blobs until it has a first commit."""
        if self._head() is None:
            self._bootstrap()

    def blob(self, data: bytes) -> str:
        return self._json(
            "POST", "/git/blobs", json={"content": base64.b64encode(data).decode(), "encoding": "base64"}
        )["sha"]

    def read_blob(self, sha: str) -> bytes:
        r = self._req("GET", f"/git/blobs/{sha}", headers={"Accept": "application/vnd.github.raw"})
        if r.status_code != 200:
            raise StoreError(f"Could not download file: {r.status_code}")
        return r.content

    def tree(self) -> dict[str, dict]:
        """All files on the default branch: path -> {sha, size}."""
        head = self._head()
        if head is None:
            return {}
        data = self._json("GET", f"/git/trees/{head}?recursive=1")
        return {e["path"]: e for e in data["tree"] if e["type"] == "blob"}

    def read(self, path: str) -> bytes | None:
        entry = self.tree().get(path)
        return self.read_blob(entry["sha"]) if entry else None

    def commit(self, files: dict[str, bytes | None], message: str) -> None:
        """Write (bytes) or delete (None) several files in one commit, retrying on races."""
        self.ensure_ready()
        blobs = {p: self.blob(d) for p, d in files.items() if d is not None}
        for attempt in range(6):
            head = self._head()
            if head is None:
                self._bootstrap()
                head = self._head()
            base_tree = self._json("GET", f"/git/commits/{head}")["tree"]["sha"]
            existing = None
            entries = []
            for p, d in files.items():
                if d is None:
                    if existing is None:
                        existing = self.tree()
                    if p not in existing:
                        continue
                    entries.append({"path": p, "mode": "100644", "type": "blob", "sha": None})
                else:
                    entries.append({"path": p, "mode": "100644", "type": "blob", "sha": blobs[p]})
            if not entries:
                return
            tree = self._json("POST", "/git/trees", json={"base_tree": base_tree, "tree": entries})["sha"]
            new = self._json(
                "POST", "/git/commits", json={"message": message, "tree": tree, "parents": [head]}
            )["sha"]
            r = self._req("PATCH", f"/git/refs/heads/{self.branch}", json={"sha": new, "force": False})
            if r.status_code == 200:
                return
            time.sleep(1 + attempt)
        raise StoreError("Could not save to the library (too many simultaneous changes).")

    # -- books

    def list_books(self) -> dict[str, dict]:
        books = {}
        for path, entry in self.tree().items():
            parts = path.split("/")
            if len(parts) == 3 and parts[0] == "books" and parts[2] == "book.json":
                try:
                    books[parts[1]] = json.loads(self.read_blob(entry["sha"]))
                except Exception:
                    pass
        return books

    def get_book(self, book_id: str) -> dict:
        data = self.read(f"books/{book_id}/book.json")
        if data is None:
            raise StoreError("This book is no longer in the library.")
        return json.loads(data)

    def update_book(self, book_id: str, change, message: str) -> dict:
        """Re-read book.json, apply change(dict) and save, so phone edits aren't overwritten."""
        for attempt in range(4):
            book = self.get_book(book_id)
            change(book)
            book["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            try:
                self.commit({f"books/{book_id}/book.json": _dump(book)}, message)
                return book
            except StoreError:
                if attempt == 3:
                    raise
        return book

    # -- audio branch

    def put_audio(self, book_id: str, parts: list[bytes]) -> list[dict]:
        self.ensure_ready()
        entries, out = [], []
        for i, data in enumerate(parts):
            sha = self.blob(data)
            entries.append({"path": f"part{i}.bin", "mode": "100644", "type": "blob", "sha": sha})
            out.append({"sha": sha, "size": len(data)})
        tree = self._json("POST", "/git/trees", json={"tree": entries})["sha"]
        commit = self._json(
            "POST", "/git/commits", json={"message": f"Audio for {book_id}", "tree": tree, "parents": []}
        )["sha"]
        ref = f"audio/{book_id}"
        r = self._req("PATCH", f"/git/refs/heads/{ref}", json={"sha": commit, "force": True})
        if r.status_code != 200:
            self._json("POST", "/git/refs", json={"ref": f"refs/heads/{ref}", "sha": commit})
        return out


def _dump(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, indent=1).encode()


def dump_compact(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
