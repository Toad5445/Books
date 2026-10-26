# Audiobooks

Turn your PDFs and EPUBs into natural-sounding audiobooks with the [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice model.
Add books from your iPhone or PC, convert them on your PC's graphics card, and listen on your phone with a
timeline linked to the book's pages.

```
 iPhone app                   Private GitHub repo                 Your PC
 (add, queue, listen)         (the "mailbox")                     (Books Converter)
 ────────────────────         ───────────────────                 ─────────────────
 Add book ─── upload ──────▶  book + "in queue"  ◀──── sees it ──  you press Convert
 Download ◀── audio ready ──  audio + text       ◀──── uploads ──  Kokoro records it
 Listen offline
```

**What it does**

- PDF and EPUB, with automatic text recognition (OCR) for scanned pages
- 28 English voices, with an instant sample of each plus "hear it with your book" previews
- Change speed instantly while listening (0.5×–3×, natural pitch)
- Change voice mid-book: your PC re-records from that point onwards
- A timeline linked to pages: drag it to see "Page 142 · Chapter 9", or tap a page number to jump there
- Read along in the extracted text or the original PDF pages, with optional sentence or word highlighting
- A bookshelf with covers, progress, and a queue showing which books still need converting
- Background sounds under the book (rain, fireplace, ocean, pink noise, shuffled lofi and bossa nova stations that fade from song to song, or your own songs), each with its own volume
- Sleep timer, lock-screen controls, offline listening
- Themes: Light, Paper, Forest, Dark, Dusk, Black (OLED), or Auto

---

## One-time setup

It takes about 20 minutes. You need a GitHub account, your Windows PC and your iPhone.

### 1. Put the app online (GitHub Pages)

1. Merge this branch into `main` on GitHub.
2. In this repo, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. After a minute, the app is live at **https://toad5445.github.io/Books/**. The **Actions** tab shows progress.

This repo only contains the app's code. Your books never go here.

### 2. Create your private library

1. Go to **https://github.com/new**.
2. Name it `books-library`, choose **Private**, and tick **Add a README file**.
3. Click **Create repository**.

### 3. Create an access key for the library

1. Go to **https://github.com/settings/personal-access-tokens/new** (Settings → Developer settings → Fine-grained tokens).
2. **Token name:** `Books app`. **Expiration:** choose the longest option offered.
3. **Repository access:** *Only select repositories*, then pick `books-library`.
4. **Permissions → Repository permissions → Contents:** **Read and write**.
5. Click **Generate token**. Copy it (it starts with `github_pat_`) and keep it somewhere safe, like your password manager. You'll paste it into the app on both devices.

The key can only touch your `books-library` repo.

### 4. Set up the converter on your PC (Windows)

1. Install **Python 3.12** from https://www.python.org/downloads/release/python-31210/ (choose "Windows installer (64-bit)") and tick **Add python.exe to PATH**.
   Kokoro doesn't support Python 3.13 or newer yet.
2. On this repo's GitHub page, click **Code → Download ZIP**. Unzip it somewhere permanent, for example `Documents\Books`.
3. Open the `converter` folder and double-click **`setup.bat`**.
   It downloads about 3 GB (PyTorch for your RTX 3080, Kokoro and the readers) and takes 10–20 minutes.
   At the end it prints `Kokoro is ready on cuda` and puts a **Books Converter** shortcut on your desktop.
4. Double-click **Books Converter**. A black window opens (leave it open) and the app opens in your browser.
5. In the app, tap the **gear → Library**. Enter `Toad5445/books-library` and paste your access key. Press **Save and connect**.
   The PC then records a short sample of every voice for instant previews (about a minute).

### 5. Install the app on your iPhone

1. Open **https://toad5445.github.io/Books/** in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Audiobooks** from your home screen (not from Safari). Go to **gear → Library**, enter the same repo and access key, then **Save and connect**.

---

## Everyday use

1. **Add a book** with **+** on your phone or PC. Pick a voice: tap ▶ for a quick sample, or *Hear … read this* to try it on a passage from the book.
   The book shows **In queue**, and the shelf says how many books are waiting for your PC.
2. **Convert** on your PC: open **Books Converter** and press **Convert** (or **Convert all**).
   With your RTX 3080, a typical novel takes about 5–10 minutes. Your phone shows the progress.
3. **Listen:** on your phone the book shows **Tap to download**. Once downloaded, it plays offline, including with the screen locked.

While listening:

- **Speed:** tap `1×` at bottom left.
- **Jump:** drag the timeline (it shows the page and chapter as you drag), tap **Page X of Y** to go to a page, or tap ☰ for chapters.
- **Text / Page:** the switch at the top flips between extracted text and the original PDF pages. Press and hold any sentence to play from there. Pinch to zoom the pages (or, in Text view, to change the text size).
- **Change voice:** **⋯ → Change voice from here.** Your PC re-records from that point onwards. Keep listening to the current audio meanwhile; when it's done the book shows **New audio ready**.
- **Sleep timer:** the moon icon.
- **Background sounds:** the wave icon next to it. Switch on as many as you like and set each one's volume, or add your own song from the Files app.
- **Highlighting, theme, text size:** the gear (or **⋯ → Display and highlighting**).

---

## Good to know

- **File size:** GitHub stores files up to 100 MB, so books over about 95 MB can't be added. A converted 10-hour book is about 200 MB of audio, which is split into parts automatically.
- **Library size:** GitHub prefers repos under a few GB. That's roughly 20–30 converted novels. Deleting a book (**⋯ → Delete from library**) frees its audio.
- **EPUB pages:** EPUBs have no printed pages, so the app uses even "pages" of about 300 words. PDFs use their real page numbers.
- **Highlighting on original PDF pages** is per sentence. Word-by-word highlighting is in the Text view.
- **Previews on the phone** run Kokoro on the iPhone itself. The first one downloads the voice engine (about 90 MB) and takes a few seconds. The ▶ samples recorded by your PC play instantly.
- **Access key expiry:** when the key expires, make a new one (step 3) and paste it into the app on both devices.
- The phone app and the browser on your PC each keep their own downloads and settings.

## Troubleshooting

- **`setup.bat` says Python 3.12 is required:** install 3.12 alongside any other version. The `py` launcher picks the right one.
- **It says "No graphics card found, so conversion will be slow":** update your NVIDIA driver, then run `setup.bat` again.
- **A book shows "Problem":** tap **⋯** on it to see the error, then **Try again**.
- **The phone says "Can't reach your library":** check the repo name (`Toad5445/books-library`) and that the key hasn't expired.

## How it's built

| Part | Where | What |
|---|---|---|
| `app/` | GitHub Pages | The installable web app (no build step). It talks to your library through the GitHub API. Uses pdf.js for the Page view and [kokoro-js](https://www.npmjs.com/package/kokoro-js) for on-phone previews. |
| `converter/` | Your PC | `server.py` (local web server and queue), `extract.py` (PDF/EPUB text, page positions, OCR with RapidOCR), `synth.py` (Kokoro and AAC audio), `convert.py` (the pipeline), `store.py` (library access). |

The nature sounds in `app/sounds/` are generated from scratch by `tools/make_sounds.py`.

**Music credits** (listed in `tools/music.json`):
- Lofi: songs by Loyalty Freak Music, released into the public domain (CC0 1.0).
- Bossa nova: "Bossa Antigua", "Bossa Bossa", "Samba Isobel", "Casa Bossa Nova" and "Backbay Lounge" by Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).

The library repo layout is `books/<id>/book.json` (status and voice), `source.pdf|epub`, `manifest.json` (every sentence with its page, its position on the page and word timings), `cover.jpg`, and `voices/*.m4a` samples.
Audio lives on a branch per book (`audio/<id>`), so deleting a book really frees the space.
