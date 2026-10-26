// Settings sheet: appearance, reading, library connection, storage.

import { h, svg, sheet, toast, switchEl, segmented, fmtBytes, confirmSheet } from '../ui.js';
import { icons } from '../icons.js';
import { settings, THEMES } from '../settings.js';
import { library } from '../library.js';
import { GitHub } from '../github.js';
import { pc } from '../pc.js';
import { voiceById } from '../voices.js';
import { openVoicePicker } from './voice-picker.js';

export function openSettings({ focus } = {}) {
  const s = sheet(({ close }) => {
    const themeGrid = h('div', { class: 'themes' });
    const drawThemes = () => themeGrid.replaceChildren(...THEMES.map(([id, name, bg, fg]) =>
      h('button', {
        class: 'theme-swatch' + (settings.get('theme') === id ? ' on' : ''),
        style: id === 'auto'
          ? { background: 'linear-gradient(135deg, #f7f6f2 50%, #17181a 50%)', color: '#777' }
          : { background: bg, color: fg, boxShadow: 'inset 0 0 0 1px rgba(128,128,128,.25)' },
        onclick: () => { settings.set({ theme: id }); drawThemes(); },
      }, name, h('div', { class: 'lines' }, h('i'), h('i')))));
    drawThemes();

    const sizeLabel = h('span', { class: 'muted small' }, `${settings.get('readerSize')} px`);
    const size = h('input', { type: 'range', class: 'slider', min: 14, max: 28, step: 1, value: settings.get('readerSize'),
      oninput: (e) => { settings.set({ readerSize: +e.target.value }); sizeLabel.textContent = `${e.target.value} px`; } });

    const defVoiceRow = h('button', { class: 'list-row', onclick: async () => {
      const v = await openVoicePicker({ current: settings.get('defaultVoice'), title: 'Default voice', confirmLabel: 'Use' });
      if (v) { settings.set({ defaultVoice: v }); drawDefVoice(); }
    } });
    const drawDefVoice = () => defVoiceRow.replaceChildren(svg(icons.voice),
      h('span', { class: 'grow' }, h('div', {}, 'Default voice for new books'), h('div', { class: 'sub' }, voiceById(settings.get('defaultVoice')).name)),
      h('span', { class: 'muted small' }, '›'));
    drawDefVoice();

    // Library connection
    const repo = h('input', { placeholder: 'your-name/books-library', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: settings.get('repo') });
    const token = h('input', { type: 'password', placeholder: 'github_pat_…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: settings.get('token') });
    const libStatus = h('div', { class: 'small muted', style: { minHeight: '18px' } });
    const saveBtn = h('button', { class: 'btn primary block', onclick: async () => {
      saveBtn.disabled = true;
      libStatus.textContent = 'Checking…';
      try {
        const gh = new GitHub(repo.value, token.value);
        const info = await gh.check();
        if (!info.private) {
          const ok = await confirmSheet({ title: 'This repo is public', message: 'Anyone could see your books and audio. Use a private repo instead?', confirm: 'Use it anyway' });
          if (!ok) { libStatus.textContent = ''; return; }
        }
        await gh.ensureReady();
        settings.set({ repo: gh.repo, token: token.value.trim() });
        if (pc.available) await pc.saveConfig(gh.repo, token.value.trim()).catch(() => {});
        libStatus.textContent = `Connected to ${info.full_name}`;
        toast('Library connected');
        library.refresh();
      } catch (e) {
        libStatus.textContent = e.message;
      } finally {
        saveBtn.disabled = false;
      }
    } }, 'Save and connect');

    const storage = h('div', { class: 'small muted' }, 'Calculating…');
    navigator.storage?.estimate?.().then((est) => {
      const n = [...library.local.values()].length;
      storage.textContent = `${n} book${n === 1 ? '' : 's'} downloaded · ${fmtBytes(est.usage || 0)} used on this device`;
    }).catch(() => { storage.textContent = ''; });

    const libSection = h('div', {},
      h('h3', {}, 'Library'),
      h('p', { class: 'small muted', style: { margin: '0 0 6px' } }, 'Your private GitHub repo where the phone and PC swap books and audio. See the setup guide in the README for how to make one and its access key.'),
      h('label', { class: 'field' }, h('span', {}, 'Repository'), repo),
      h('label', { class: 'field' }, h('span', {}, 'Access key (fine-grained token)'), token),
      saveBtn, libStatus,
      pc.available ? h('button', { class: 'btn block', style: { marginTop: '8px' }, onclick: async () => { await pc.voiceSamples(); toast('Recording voice samples on this PC'); } }, 'Re-record voice samples') : null);

    const out = [
      h('h2', {}, 'Settings'),
      h('h3', {}, 'Theme'), themeGrid,

      h('h3', {}, 'Reading'),
      h('div', { class: 'list' },
        h('div', { class: 'list-row', style: { display: 'block' } },
          h('div', { style: { marginBottom: '8px' } }, 'Highlight while reading'),
          segmented([['off', 'Off'], ['sentence', 'Sentence'], ['word', 'Word']], settings.get('highlight'), (v) => settings.set({ highlight: v }))),
        h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('div', {}, 'Follow along'), h('div', { class: 'sub' }, 'Keep the current sentence in view')),
          switchEl(settings.get('follow'), (v) => settings.set({ follow: v }))),
        h('div', { class: 'list-row', style: { display: 'block' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', {}, 'Text size'), sizeLabel), size),
        h('div', { class: 'list-row', style: { display: 'block' } },
          h('div', { style: { marginBottom: '8px' } }, 'Text font'),
          segmented([['serif', 'Book'], ['sans', 'Clean']], settings.get('readerFont'), (v) => settings.set({ readerFont: v })))),

      h('h3', {}, 'Listening'),
      h('div', { class: 'list' },
        h('div', { class: 'list-row', style: { display: 'block' } },
          h('div', { style: { marginBottom: '8px' } }, 'Skip back'),
          segmented([[10, '10 s'], [15, '15 s'], [30, '30 s']], settings.get('skipBack'), (v) => settings.set({ skipBack: v }))),
        h('div', { class: 'list-row', style: { display: 'block' } },
          h('div', { style: { marginBottom: '8px' } }, 'Skip forward'),
          segmented([[15, '15 s'], [30, '30 s'], [60, '60 s']], settings.get('skipForward'), (v) => settings.set({ skipForward: v }))),
        defVoiceRow),

      libSection,

      h('h3', {}, 'Storage'),
      h('div', { class: 'list' },
        h('div', { class: 'list-row' }, h('span', { class: 'grow' }, storage)),
        h('button', { class: 'list-row danger', onclick: async () => {
          const ok = await confirmSheet({ title: 'Remove all downloads?', message: 'Your books stay in your library and can be downloaded again.', confirm: 'Remove', danger: true });
          if (!ok) return;
          for (const id of [...library.local.keys()]) await library.removeDownload(id);
          toast('Downloads removed');
          close();
        } }, svg(icons.trash), h('span', { class: 'grow' }, 'Remove all downloads'))),

      h('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '24px' } }, 'Books · voices by Kokoro'),
    ];
    if (focus === 'library') setTimeout(() => libSection.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350);
    return out;
  });
  return s;
}
