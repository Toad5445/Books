// The bookshelf: what's in the GitHub library, what's downloaded on this device,
// and actions (add, download, re-voice, delete).

import { db, persist } from './db.js';
import { GitHub } from './github.js';
import { settings } from './settings.js';

const listeners = new Set();

export const library = {
  books: new Map(),     // id -> book.json from the library
  local: new Map(),     // id -> { audioVersion, size } of what's downloaded here
  tree: {},             // path -> {sha, size}
  voiceSamples: {},     // voice id -> blob sha
  downloads: new Map(), // id -> progress 0..1 for downloads in flight
  uploads: new Map(),   // id -> progress 0..1 for uploads in flight
  synced: false,
  syncing: false,
  error: null,

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { listeners.forEach((fn) => fn()); },

  configured: () => !!(settings.get('repo') && settings.get('token')),
  gh: () => new GitHub(settings.get('repo'), settings.get('token')),

  async init() {
    // Show what we knew last time straight away, even offline.
    const cached = await db.get('library').catch(() => null);
    if (cached) {
      this.books = new Map(Object.entries(cached.books || {}));
      this.tree = cached.tree || {};
      this.voiceSamples = cached.voiceSamples || {};
    }
    for (const key of await db.keys('local:')) {
      this.local.set(key.slice(6), await db.get(key));
    }
    this.emit();
  },

  async refresh() {
    if (!this.configured() || this.syncing) return;
    this.syncing = true;
    this.emit();
    try {
      const gh = this.gh();
      const tree = await gh.tree();
      const books = new Map();
      const jobs = [];
      for (const [path, entry] of Object.entries(tree)) {
        const m = path.match(/^books\/([^/]+)\/book\.json$/);
        if (!m) continue;
        const id = m[1];
        if (this.tree[path]?.sha === entry.sha && this.books.has(id)) {
          books.set(id, this.books.get(id));
        } else {
          jobs.push(gh.blobJSON(entry.sha).then((b) => books.set(id, { ...b, id })).catch(() => {}));
        }
      }
      await Promise.all(jobs);
      const voiceSamples = {};
      for (const [path, entry] of Object.entries(tree)) {
        const m = path.match(/^voices\/([^/]+)\.m4a$/);
        if (m) voiceSamples[m[1]] = entry.sha;
      }
      this.books = books;
      this.tree = tree;
      this.voiceSamples = voiceSamples;
      this.error = null;
      this.synced = true;
      await db.set('library', { books: Object.fromEntries(books), tree, voiceSamples });
    } catch (e) {
      this.error = e.message;
    } finally {
      this.syncing = false;
      this.emit();
    }
  },

  sorted() {
    return [...this.books.values()].sort((a, b) => (b.added || '').localeCompare(a.added || ''));
  },

  /** What the shelf should say about a book. */
  state(book) {
    const local = this.local.get(book.id);
    const audio = book.audio;
    const s = {
      playable: !!local,
      downloaded: !!local,
      stale: !!(local && audio && local.audioVersion < audio.version),
      downloading: this.downloads.get(book.id),
      uploading: this.uploads.get(book.id),
    };
    if (s.uploading != null) s.label = 'uploading';
    else if (s.downloading != null) s.label = 'downloading';
    else if (book.status === 'converting') s.label = 'converting';
    else if (book.status === 'queued') s.label = book.revoice ? 'revoice' : 'queued';
    else if (book.status === 'error') s.label = 'error';
    else if (book.status === 'ready' && !local) s.label = 'ready';
    else if (s.stale) s.label = 'update';
    else s.label = 'downloaded';
    return s;
  },

  queuedCount() {
    return [...this.books.values()].filter((b) => b.status === 'queued' || b.status === 'converting').length;
  },

  // ---------------------------------------------------------- adding

  async add(file, { title, author, voice }) {
    const kind = /\.epub$/i.test(file.name) || file.type === 'application/epub+zip' ? 'epub' : 'pdf';
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const book = {
      id, title: title || file.name.replace(/\.(pdf|epub)$/i, ''), author: author || '',
      format: kind, voice, status: 'queued', progress: 0, message: '', added: now, updated: now,
      fileName: file.name, fileSize: file.size,
    };
    this.uploads.set(id, 0);
    this.books.set(id, book);
    this.emit();
    try {
      await this.gh().commit({
        [`books/${id}/source.${kind}`]: file,
        [`books/${id}/book.json`]: JSON.stringify(book, null, 1),
      }, `Add ${book.title}`, { onProgress: (p) => { this.uploads.set(id, p); this.emit(); } });
      // Keep a local copy of the original so "Page" view works without re-downloading.
      await db.set(`source:${id}`, file).catch(() => {});
    } catch (e) {
      this.books.delete(id);
      throw e;
    } finally {
      this.uploads.delete(id);
      this.emit();
    }
    await this.refresh();
    return id;
  },

  // ---------------------------------------------------------- changing a book

  async update(id, change, message) {
    const gh = this.gh();
    for (let attempt = 0; attempt < 3; attempt++) {
      const tree = await gh.tree();
      const entry = tree[`books/${id}/book.json`];
      if (!entry) throw new Error('This book is no longer in the library.');
      const book = await gh.blobJSON(entry.sha);
      change(book);
      book.updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      try {
        await gh.commit({ [`books/${id}/book.json`]: JSON.stringify(book, null, 1) }, message);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    await this.refresh();
  },

  /** Queue the book again with another voice, keeping audio before `from` seconds. */
  revoice(id, voice, from = 0) {
    return this.update(id, (b) => {
      if (!b.audio) { b.voice = voice; delete b.revoice; }
      else b.revoice = { voice, from: Math.max(0, from) };
      b.status = 'queued';
      b.progress = 0;
      b.message = '';
    }, `Re-voice ${id}`);
  },

  /** Before conversion, the voice can simply be swapped. */
  setVoice(id, voice) {
    return this.update(id, (b) => { b.voice = voice; }, `Voice for ${id}`);
  },

  retry(id) {
    return this.update(id, (b) => { b.status = 'queued'; b.message = ''; b.progress = 0; }, `Retry ${id}`);
  },

  cancelRevoice(id) {
    return this.update(id, (b) => { delete b.revoice; b.status = b.audio ? 'ready' : 'queued'; }, `Cancel re-voice ${id}`);
  },

  async remove(id) {
    const gh = this.gh();
    const tree = await gh.tree();
    const files = {};
    for (const path of Object.keys(tree)) if (path.startsWith(`books/${id}/`)) files[path] = null;
    if (Object.keys(files).length) await gh.commit(files, `Remove ${id}`);
    await gh.deleteBranch(`audio/${id}`).catch(() => {});
    await this.removeDownload(id);
    await db.delPrefix(`progress:${id}`);
    await this.refresh();
  },

  // ---------------------------------------------------------- downloads

  async download(id) {
    const book = this.books.get(id);
    if (!book?.audio || this.downloads.has(id)) return;
    await persist();
    this.downloads.set(id, 0);
    this.emit();
    try {
      const gh = this.gh();
      const manifestEntry = this.tree[`books/${id}/manifest.json`] || (await gh.tree())[`books/${id}/manifest.json`];
      if (!manifestEntry) throw new Error('The converted text is missing. Try converting again.');
      const total = book.audio.size + manifestEntry.size;
      let done = 0;
      const manifest = await gh.blobJSON(manifestEntry.sha);
      done += manifestEntry.size;
      const parts = [];
      for (const part of book.audio.parts) {
        const before = done;
        parts.push(await gh.blob(part.sha, {
          size: part.size,
          onProgress: (got) => { this.downloads.set(id, (before + got) / total); this.emit(); },
        }));
        done += part.size;
      }
      const audio = new Blob(parts, { type: book.audio.mime || 'audio/mp4' });
      const coverEntry = this.tree[`books/${id}/cover.jpg`];
      if (coverEntry) await this.cover(id).catch(() => {});
      await db.set(`audio:${id}`, audio);
      await db.set(`manifest:${id}`, manifest);
      const local = { audioVersion: book.audio.version, size: audio.size, voice: book.voice, at: Date.now() };
      await db.set(`local:${id}`, local);
      this.local.set(id, local);
    } finally {
      this.downloads.delete(id);
      this.emit();
    }
  },

  async removeDownload(id) {
    await db.del(`audio:${id}`);
    await db.del(`manifest:${id}`);
    await db.del(`local:${id}`);
    await db.del(`source:${id}`);
    this.local.delete(id);
    this.emit();
  },

  async cover(id) {
    const entry = this.tree[`books/${id}/cover.jpg`];
    if (!entry) return null;
    const key = `blob:${entry.sha}`;
    let blob = await db.get(key);
    if (!blob) {
      if (!this.configured()) return null;
      blob = await this.gh().blob(entry.sha);
      await db.set(key, blob);
    }
    return blob;
  },

  /** The original uploaded file (for the Page view and voice previews). */
  async source(id, onProgress) {
    let blob = await db.get(`source:${id}`);
    if (blob) return blob;
    const book = this.books.get(id);
    const entry = this.tree[`books/${id}/source.${book?.format || 'pdf'}`];
    if (!entry) throw new Error('The original file isn’t in the library.');
    blob = await this.gh().blob(entry.sha, { size: entry.size, onProgress });
    await db.set(`source:${id}`, blob).catch(() => {});
    return blob;
  },

  async voiceSample(voice) {
    const sha = this.voiceSamples[voice];
    if (!sha) return null;
    const key = `blob:${sha}`;
    let blob = await db.get(key);
    if (!blob) {
      blob = await this.gh().blob(sha);
      blob = new Blob([blob], { type: 'audio/mp4' });
      await db.set(key, blob);
    }
    return blob;
  },

  // ---------------------------------------------------------- listening progress

  async progress(id) {
    return (await db.get(`progress:${id}`)) || null;
  },

  async saveProgress(id, time, duration) {
    const p = { time, duration, at: Date.now() };
    await db.set(`progress:${id}`, p);
    const meta = this.progressCache.get(id);
    this.progressCache.set(id, p);
    if (!meta || Math.abs((meta.time || 0) - time) > 30) this.emit();
  },

  progressCache: new Map(),
  async loadProgressCache() {
    for (const key of await db.keys('progress:')) this.progressCache.set(key.slice(9), await db.get(key));
  },
};
