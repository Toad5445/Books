"""Fetch the latest app and converter from GitHub. start.bat runs this before
starting the converter, so fixes arrive without re-downloading anything."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import zipfile

import requests

REPO = os.environ.get("BOOKS_REPO", "Toad5445/Books")
BRANCH = os.environ.get("BOOKS_BRANCH", "main")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main() -> None:
    url = f"https://codeload.github.com/{REPO}/zip/refs/heads/{BRANCH}"
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
    except Exception:
        print("  Couldn't check for updates (offline?). Starting the current version.")
        return

    z = zipfile.ZipFile(io.BytesIO(r.content))
    prefix = z.namelist()[0].split("/")[0] + "/"
    changed = []
    for name in z.namelist():
        rel = name[len(prefix):]
        if not rel or name.endswith("/"):
            continue
        if not (rel.startswith(("app/", "converter/")) or rel == "README.md"):
            continue
        if rel.endswith(".bat"):
            continue  # Windows reads a running .bat as it goes; replacing it mid-run breaks it
        data = z.read(name)
        path = os.path.join(ROOT, *rel.split("/"))
        try:
            with open(path, "rb") as f:
                if f.read() == data:
                    continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        changed.append(rel)

    if not changed:
        print("  Up to date.")
        return
    print(f"  Updated {len(changed)} file(s).")
    if "converter/requirements.txt" in changed:
        print("  Installing new requirements...")
        subprocess.call([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(HERE, "requirements.txt")])


if __name__ == "__main__":
    main()
