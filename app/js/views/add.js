// "Add a book" sheet: pick a file, check the details, choose a voice, upload.

import { h, svg, sheet, toast, fmtBytes } from '../ui.js';
import { icons } from '../icons.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { voiceById } from '../voices.js';
import { bookInfo } from '../bookinfo.js';
import { openVoicePicker } from './voice-picker.js';
import { openSettings } from './settings.js';
import { pc } from '../pc.js';

const MAX_SIZE = 95 * 1024 * 1024; // GitHub's per-file limit is 100 MB

export function openAddSheet() {
  if (!library.configured()) return openSettings({ focus: 'library' });
  let file = null;
  let info = { sample: '' };
  let voice = settings.get('defaultVoice');

  sheet(({ close }) => {
    const input = h('input', { type: 'file', accept: '.pdf,.epub,application/pdf,application/epub+zip', hidden: true });
    const drop = h('label', { class: 'dropzone' }, input,
      h('b', {}, 'Choose a PDF or EPUB'), h('span', {}, 'From Files, iCloud Drive or Downloads'));
    const title = h('input', { placeholder: 'Title' });
    const author = h('input', { placeholder: 'Author (optional)' });
    const voiceRow = h('button', { class: 'list-row', onclick: pickVoice });
    const addBtn = h('button', { class: 'btn primary', disabled: true, onclick: submit }, 'Add to queue');
    const progress = h('div', { class: 'bar', hidden: true, style: { marginTop: '14px' } }, h('i', { style: { width: '0%' } }));

    const drawVoice = () => voiceRow.replaceChildren(svg(icons.voice),
      h('span', { class: 'grow' }, h('div', {}, 'Voice'), h('div', { class: 'sub' }, `${voiceById(voice).name} · ${voiceById(voice).group}`)),
      h('span', { class: 'muted small' }, 'Change ›'));
    drawVoice();

    input.addEventListener('change', async () => {
      file = input.files[0];
      if (!file) return;
      if (file.size > MAX_SIZE) {
        toast(`That file is ${fmtBytes(file.size)}. GitHub only allows files up to 100 MB.`, { bad: true });
        file = null;
        return;
      }
      drop.classList.add('has');
      drop.replaceChildren(input, h('b', {}, file.name), h('span', {}, `${fmtBytes(file.size)} · reading details…`));
      title.value = file.name.replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ');
      addBtn.disabled = false;
      info = await bookInfo(file);
      if (info.title) title.value = info.title;
      if (info.author) author.value = info.author;
      drop.replaceChildren(input, h('b', {}, file.name),
        h('span', {}, [fmtBytes(file.size), info.pages ? `${info.pages} pages` : null].filter(Boolean).join(' · ')));
    });

    async function pickVoice() {
      const v = await openVoicePicker({ current: voice, sampleText: info.sample, confirmLabel: 'Use' });
      if (v) { voice = v; drawVoice(); }
    }

    async function submit() {
      if (!file) return;
      addBtn.disabled = true;
      addBtn.textContent = 'Uploading…';
      progress.hidden = false;
      const off = library.onChange(() => {
        const p = [...library.uploads.values()][0];
        if (p != null) progress.firstChild.style.width = `${Math.round(p * 100)}%`;
      });
      try {
        await library.add(file, { title: title.value.trim(), author: author.value.trim(), voice });
        toast(pc.available ? 'Added. Press Convert when you’re ready.' : 'Added to the queue. Convert it on your PC.');
        close();
      } catch (e) {
        toast(e.message, { bad: true });
        addBtn.disabled = false;
        addBtn.textContent = 'Add to queue';
      } finally {
        off();
      }
    }

    return [
      h('h2', {}, 'Add a book'),
      h('p', { class: 'lead' }, 'It goes into your library’s queue. Your PC converts it into audio, and then it appears here ready to download.'),
      drop,
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'Author'), author),
      h('div', { class: 'list', style: { marginTop: '14px' } }, voiceRow),
      progress,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), addBtn),
    ];
  });
}
