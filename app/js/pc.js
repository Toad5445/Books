// Talks to the converter running on your PC. Only available when the app
// is opened from the PC itself (http://localhost:8765).

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Books': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Converter error ${res.status}`);
  return res.json();
}

const listeners = new Set();

export const pc = {
  available: false,
  status: null,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async detect() {
    if (!isLocal) return false;
    try {
      this.status = await call('GET', '/api/pc/status');
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  },

  config: () => call('GET', '/api/pc/config'),
  saveConfig: (repo, token) => call('POST', '/api/pc/config', { repo, token }),
  convert: (ids) => call('POST', '/api/pc/convert', { ids }),
  cancel: (id) => call('POST', '/api/pc/cancel', { id }),
  voiceSamples: () => call('POST', '/api/pc/voice-samples', {}),

  job(id) { return this.status?.jobs?.[id] || null; },

  startPolling(onJobFinished) {
    let lastStates = {};
    const tick = async () => {
      try {
        this.status = await call('GET', '/api/pc/status');
        const jobs = this.status.jobs || {};
        for (const [id, job] of Object.entries(jobs)) {
          if (lastStates[id] && lastStates[id] !== job.state && ['done', 'error', 'cancelled'].includes(job.state)) onJobFinished?.(id, job);
        }
        lastStates = Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.state]));
        listeners.forEach((fn) => fn());
      } catch {}
      setTimeout(tick, this.status?.current ? 1500 : 4000);
    };
    tick();
  },
};
