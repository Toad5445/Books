// Options for one book: download, change voice, retry, delete.

import { h, svg, sheet, toast, confirmSheet, fmtBytes, fmtDuration } from '../ui.js';
import { icons } from '../icons.js';
import { library } from '../library.js';
import { voiceById } from '../voices.js';
import { openVoicePicker } from './voice-picker.js';
import { pc } from '../pc.js';

export function openBookSheet(id) {
  const book = library.books.get(id);
  if (!book) return;
  const st = library.state(book);
  const local = library.local.get(id);

  sheet(({ close }) => {
    const rows = [];
    const row = (icon, label, sub, onclick, cls = '') =>
      h('button', { class: 'list-row ' + cls, onclick: async () => { close(); await onclick(); } },
        svg(icon), h('span', { class: 'grow' }, h('div', {}, label), sub ? h('div', { class: 'sub' }, sub) : null));

    if (st.playable) rows.push(row(icons.play, 'Listen', null, () => (location.hash = `#/book/${encodeURIComponent(id)}`)));
    if (book.audio && (!local || st.stale)) {
      rows.push(row(icons.download, st.stale ? 'Download the new audio' : 'Download to this device', fmtBytes(book.audio.size),
        async () => { try { await library.download(id); toast('Downloaded'); } catch (e) { toast(e.message, { bad: true }); } }));
    }
    const pcRunning = pc.available && ['running', 'waiting'].includes(pc.job(id)?.state);
    if (pc.available && !pcRunning && ['queued', 'error', 'converting'].includes(book.status)) {
      rows.push(row(icons.pc, 'Convert now', 'On this PC', async () => { await pc.convert([id]); toast('Converting'); }));
    }
    if (book.status === 'converting' && !pcRunning) {
      rows.push(row(icons.refresh, 'Stuck? Put it back in the queue', 'Use this if your PC stopped mid-way', () => act(() => library.retry(id), 'Back in the queue')));
    }
    if (book.status === 'error') {
      rows.push(row(icons.refresh, 'Try again', 'Puts it back in the queue', () => act(() => library.retry(id), 'Back in the queue')));
    }
    if (book.status === 'queued' && !book.audio) {
      rows.push(row(icons.voice, 'Change voice', voiceById(book.voice).name, async () => {
        const v = await openVoicePicker({ current: book.voice, sampleText: await sample(id) });
        if (v && v !== book.voice) await act(() => library.setVoice(id, v), `Voice set to ${voiceById(v).name}`);
      }));
    } else if (book.audio && book.status !== 'converting') {
      rows.push(row(icons.voice, 'Re-voice the whole book', `Now: ${voiceById(book.voice).name}`, async () => {
        const v = await openVoicePicker({ current: book.voice, sampleText: await sample(id), title: 'Re-voice the book',
          lead: 'Your PC will record the whole book again in the new voice. You can keep listening to the current audio meanwhile.', confirmLabel: 'Switch to' });
        if (v) await act(() => library.revoice(id, v, 0), 'Re-voice queued for your PC');
      }));
    }
    if (book.revoice && book.status === 'queued') {
      rows.push(row(icons.close, 'Cancel re-voice', null, () => act(() => library.cancelRevoice(id), 'Re-voice cancelled')));
    }
    if (local) {
      rows.push(row(icons.trash, 'Remove download', `Frees ${fmtBytes(local.size)} · stays in your library`, async () => {
        await library.removeDownload(id);
        toast('Download removed');
      }));
    }
    rows.push(row(icons.trash, 'Delete from library', 'Removes the book and its audio everywhere', async () => {
      const ok = await confirmSheet({ title: `Delete “${book.title}”?`, message: 'This removes the book file and its audio from your library and this device.', confirm: 'Delete', danger: true });
      if (ok) await act(() => library.remove(id), 'Deleted');
    }, 'danger'));

    const facts = [
      book.author,
      (book.format || '').toUpperCase(),
      book.pages ? `${book.pages} pages` : null,
      book.audio?.duration ? fmtDuration(book.audio.duration) : null,
      `Voice: ${voiceById(book.voice).name}`,
    ].filter(Boolean).join(' · ');

    return [
      h('h2', {}, book.title || 'Untitled'),
      h('p', { class: 'lead' }, facts),
      book.status === 'error' ? h('div', { class: 'note' }, h('b', {}, 'Conversion problem: '), book.message || 'Unknown error') : null,
      book.status === 'converting' ? h('div', { class: 'note' }, `Converting · ${Math.round((book.progress || 0) * 100)}% · ${book.message || ''}`) : null,
      book.status === 'queued' ? h('div', { class: 'note' }, book.revoice
        ? `Waiting for your PC to re-voice it with ${voiceById(book.revoice.voice).name}.`
        : 'Waiting for your PC. Open Books Converter on your PC and press Convert.') : null,
      h('div', { class: 'list' }, ...rows),
    ];
  });
}

async function act(fn, done) {
  try { await fn(); toast(done); } catch (e) { toast(e.message, { bad: true }); }
}

/** A passage from the book for voice previews. */
export async function sample(id, near = null) {
  try {
    const { db } = await import('../db.js');
    const manifest = await db.get(`manifest:${id}`);
    if (manifest?.segs?.length) {
      let i = near != null ? manifest.segs.findIndex((s) => s.b > near) : Math.floor(manifest.segs.length * 0.1);
      if (i < 0) i = 0;
      let text = '';
      while (i < manifest.segs.length && text.length < 120) text += (text ? ' ' : '') + manifest.segs[i++].x;
      return text;
    }
    const src = await library.source(id).catch(() => null);
    if (src) {
      const { bookInfo } = await import('../bookinfo.js');
      const book = library.books.get(id);
      return (await bookInfo(new File([src], book?.fileName || `book.${book?.format || 'pdf'}`))).sample;
    }
  } catch {}
  return '';
}
