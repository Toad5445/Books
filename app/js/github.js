// Reads and writes the private library repo through the GitHub API.
// Same layout as converter/store.py.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class GitHub {
  constructor(repo, token) {
    this.repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    this.token = token.trim();
    this._branch = null;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  async req(method, path, { body, accept, ok = [200, 201] } = {}) {
    const url = path.startsWith('http') ? path : `${API}/repos/${this.repo}${path}`;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers({ ...(accept ? { Accept: accept } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }),
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });
      } catch (e) {
        lastErr = new GitHubError('Can’t reach GitHub. Check your connection.', 0);
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (ok.includes(res.status)) return res;
      if (res.status >= 500 || res.status === 429) {
        lastErr = new GitHubError(`GitHub is having trouble (${res.status}).`, res.status);
        await sleep(800 * 2 ** attempt);
        continue;
      }
      return res;
    }
    throw lastErr;
  }

  async json(method, path, opts) {
    const res = await this.req(method, path, opts);
    if (![200, 201].includes(res.status)) throw await errorFrom(res);
    return res.json();
  }

  async check() {
    const res = await this.req('GET', '');
    if (res.status === 401) throw new GitHubError('GitHub rejected the access key.', 401);
    if (res.status === 404) throw new GitHubError('Library repo not found. Check the name, and that the key has access to it.', 404);
    if (res.status !== 200) throw await errorFrom(res);
    const info = await res.json();
    this._branch = info.default_branch || 'main';
    return info;
  }

  async branch() {
    if (!this._branch) await this.check();
    return this._branch;
  }

  async head(name) {
    const res = await this.req('GET', `/git/ref/heads/${name || await this.branch()}`);
    if (res.status === 409 || res.status === 404) return null;
    if (res.status !== 200) throw await errorFrom(res);
    return (await res.json()).object.sha;
  }

  async ensureReady() {
    if (await this.head()) return;
    // A brand-new empty repo needs a first commit before it can hold files.
    const res = await this.req('PUT', '/contents/README.md', {
      body: { message: 'Create audiobook library', content: btoa('# Audiobook library\n\nManaged by the Books app.\n') },
    });
    if (![200, 201, 422].includes(res.status)) throw await errorFrom(res);
  }

  /** All files on the default branch: path -> {sha, size}. */
  async tree() {
    const head = await this.head();
    if (!head) return {};
    const data = await this.json('GET', `/git/trees/${head}?recursive=1`);
    const out = {};
    for (const e of data.tree) if (e.type === 'blob') out[e.path] = { sha: e.sha, size: e.size };
    return out;
  }

  /** Download a file by its blob sha. onProgress(received, total). */
  async blob(sha, { onProgress, size } = {}) {
    const res = await this.req('GET', `/git/blobs/${sha}`, { accept: 'application/vnd.github.raw' });
    if (res.status !== 200) throw await errorFrom(res);
    if (!onProgress || !res.body) return res.blob();
    const total = Number(res.headers.get('Content-Length')) || size || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    return new Blob(chunks);
  }

  async blobJSON(sha) {
    return JSON.parse(await (await this.blob(sha)).text());
  }

  /** Upload a file as a git blob, with upload progress. Returns its sha. */
  async createBlob(data, onProgress) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const b64 = await toBase64(blob);
    const body = JSON.stringify({ content: b64, encoding: 'base64' });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/repos/${this.repo}/git/blobs`);
      for (const [k, v] of Object.entries(this.headers({ 'Content-Type': 'application/json' }))) xhr.setRequestHeader(k, v);
      if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
      xhr.onload = () => {
        if (xhr.status === 201) resolve(JSON.parse(xhr.responseText).sha);
        else reject(new GitHubError(`Upload failed (${xhr.status}). ${safeMessage(xhr.responseText)}`, xhr.status));
      };
      xhr.onerror = () => reject(new GitHubError('Upload failed. Check your connection.', 0));
      xhr.send(body);
    });
  }

  /** Write (string/Blob/bytes) or delete (null) several files in one commit. */
  async commit(files, message, { onProgress } = {}) {
    await this.ensureReady();
    const branch = await this.branch();
    const blobs = {};
    const writes = Object.entries(files).filter(([, v]) => v != null);
    const totalBytes = writes.reduce((n, [, v]) => n + sizeOf(v), 0) || 1;
    let doneBytes = 0;
    for (const [path, value] of writes) {
      const sz = sizeOf(value);
      blobs[path] = await this.createBlob(typeof value === 'string' ? new TextEncoder().encode(value) : value,
        onProgress && ((loaded, total) => onProgress((doneBytes + sz * loaded / total) / totalBytes)));
      doneBytes += sz;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const head = await this.head();
      const base = await this.json('GET', `/git/commits/${head}`);
      let existing = null;
      const entries = [];
      for (const [path, value] of Object.entries(files)) {
        if (value == null) {
          existing ??= await this.tree();
          if (!existing[path]) continue;
          entries.push({ path, mode: '100644', type: 'blob', sha: null });
        } else {
          entries.push({ path, mode: '100644', type: 'blob', sha: blobs[path] });
        }
      }
      if (!entries.length) return;
      const tree = await this.json('POST', '/git/trees', { body: { base_tree: base.tree.sha, tree: entries } });
      const commit = await this.json('POST', '/git/commits', { body: { message, tree: tree.sha, parents: [head] } });
      const res = await this.req('PATCH', `/git/refs/heads/${branch}`, { body: { sha: commit.sha, force: false } });
      if (res.status === 200) return;
      await sleep(700 * (attempt + 1));
    }
    throw new GitHubError('Couldn’t save to the library. Try again in a moment.', 409);
  }

  async deleteBranch(name) {
    const res = await this.req('DELETE', `/git/refs/heads/${name}`, { ok: [204] });
    if (![204, 404, 422].includes(res.status)) throw await errorFrom(res);
  }
}

function sizeOf(v) {
  if (typeof v === 'string') return v.length;
  return v.size ?? v.byteLength ?? 0;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function errorFrom(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  if (res.status === 401) return new GitHubError('GitHub rejected the access key. It may have expired.', 401);
  if (res.status === 403) return new GitHubError('The access key isn’t allowed to do that. It needs Contents: Read and write.', 403);
  if (res.status === 404) return new GitHubError('Not found in the library repo.', 404);
  return new GitHubError(`GitHub error ${res.status}. ${safeMessage(text)}`, res.status);
}

function safeMessage(text) {
  try { return JSON.parse(text).message || ''; } catch { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
