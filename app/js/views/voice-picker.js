// Voice picker sheet with instant samples and "hear it with your book" previews.

import { h, svg, sheet, toast, hashHue } from '../ui.js';
import { icons } from '../icons.js';
import { VOICES, voiceById } from '../voices.js';
import { playSample, playText, stopPreview, onPreviewChange, previewPlaying } from '../preview.js';

/**
 * openVoicePicker({ current, sampleText, title, lead, confirmLabel, extra }) -> Promise<voice id | null>
 * `extra(voice)` may return extra nodes shown above the confirm button.
 */
export function openVoicePicker({ current = 'af_heart', sampleText = '', title = 'Choose a voice', lead, confirmLabel = 'Use this voice' } = {}) {
  return new Promise((resolve) => {
    let selected = current;
    let result = null;
    let offPreview;
    const s = sheet(({ close }) => {
      const status = h('div', { class: 'small muted', style: { minHeight: '18px', marginTop: '6px' } });
      const setStatus = (d) => {
        if (d.status === 'loading') status.textContent = d.progress > 0 && d.progress < 1
          ? `Getting the voice engine ready (first time only)… ${Math.round(d.progress * 100)}%`
          : 'Getting the voice engine ready…';
        else if (d.status === 'generating') status.textContent = 'Reading it aloud…';
      };
      const run = async (btn, fn) => {
        btn.classList.add('busy');
        btn.replaceChildren(svg(icons.spinner));
        try { await fn(); status.textContent = ''; } catch (e) {
          status.textContent = '';
          toast('Preview failed: ' + e.message, { bad: true });
        } finally { btn.classList.remove('busy'); refreshButtons(); }
      };

      const groups = {};
      for (const v of VOICES) (groups[v.group] ||= []).push(v);
      const rows = new Map();
      const list = h('div', {});
      for (const [group, voices] of Object.entries(groups)) {
        list.append(h('h3', {}, group));
        const box = h('div', { class: 'list' });
        for (const v of voices) {
          const playBtn = h('button', { class: 'play-mini', 'aria-label': `Play ${v.name}` });
          playBtn.addEventListener('click', (e) => { e.stopPropagation(); run(playBtn, () => playSample(v.id, setStatus)); });
          const row = h('button', { class: 'voice-row', onclick: () => { selected = v.id; refreshRows(); } },
            h('span', { class: 'avatar', style: { background: `hsl(${hashHue(v.id) % 360} 35% 45%)` } }, v.name.slice(0, 2)),
            h('span', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, v.name), h('div', { class: 'sub' }, `Quality ${v.grade}`)),
            h('span', { class: 'check' }),
            playBtn);
          rows.set(v.id, { row, playBtn });
          box.append(row);
        }
        list.append(box);
      }

      const textArea = h('textarea', { rows: 3, placeholder: 'Type or paste a passage to hear it read.' });
      textArea.value = sampleText || 'It was the kind of evening that made the whole town feel like a story waiting to be told.';
      const bookBtn = h('button', { class: 'btn block', style: { marginTop: '8px' } });
      bookBtn.addEventListener('click', () => {
        const text = textArea.value.trim();
        if (!text) return;
        bookBtn.disabled = true;
        const reset = () => { bookBtn.disabled = false; refreshButtons(); };
        playText(selected, text.slice(0, 220), setStatus).then(() => { status.textContent = ''; }).catch((e) => {
          status.textContent = '';
          toast('Preview failed: ' + e.message, { bad: true });
        }).finally(reset);
        bookBtn.replaceChildren(svg(icons.spinner), 'Preparing…');
      });

      const confirmBtn = h('button', { class: 'btn primary', onclick: () => { result = selected; close(); } });

      function refreshRows() {
        for (const [id, { row }] of rows) {
          row.classList.toggle('on', id === selected);
          row.querySelector('.check').replaceChildren(id === selected ? svg(icons.check) : '');
        }
        confirmBtn.textContent = `${confirmLabel} ${voiceById(selected).name}`;
        refreshButtons();
      }
      function refreshButtons() {
        const playing = previewPlaying();
        for (const [id, { playBtn }] of rows) {
          if (playBtn.classList.contains('busy')) continue;
          playBtn.replaceChildren(svg(playing === `sample:${id}` ? icons.stop : icons.play));
        }
        if (!bookBtn.disabled) {
          bookBtn.replaceChildren(svg(playing === `text:${selected}` ? icons.stop : icons.sparkle),
            playing === `text:${selected}` ? 'Stop' : `Hear ${voiceById(selected).name} read this`);
        }
      }
      offPreview = onPreviewChange(refreshButtons);
      refreshRows();

      return [
        h('h2', {}, title),
        h('p', { class: 'lead' }, lead || 'Tap ▶ for a quick sample. Pick one, then try it on a passage from your book.'),
        h('h3', {}, 'Hear it with your book'),
        h('label', { class: 'field' }, textArea),
        h('div', { class: 'small muted' }, 'Made on your phone, so it takes a few seconds (longer the first time).'),
        bookBtn,
        status,
        list,
        h('div', { class: 'actions', style: { position: 'sticky', bottom: '0', background: 'var(--surface)', padding: '12px 0 4px' } },
          h('button', { class: 'btn', onclick: close }, 'Cancel'), confirmBtn),
      ];
    }, { onClose: () => { stopPreview(); offPreview?.(); resolve(result); } });
    // Scroll the selected voice into view.
    setTimeout(() => s.el.querySelector('.voice-row.on')?.scrollIntoView({ block: 'center' }), 320);
  });
}
