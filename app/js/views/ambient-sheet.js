// "Background sounds" sheet: switch sounds on, set each one's volume, add your own.

import { h, svg, sheet, toast, switchEl } from '../ui.js';
import { icons } from '../icons.js';
import { ambient } from '../ambient.js';
import { settings } from '../settings.js';

const ICON = { rain: icons.drop, fire: icons.flame, ocean: icons.waves, brown: icons.noise, lofi: icons.music, bossa: icons.music };

export function openAmbientSheet() {
  sheet(({ el }) => {
    const nature = h('div', { class: 'list' });
    const music = h('div', { class: 'list' });
    const yours = h('div', { class: 'list' });

    const row = (item, removable) => {
      const slider = h('input', { type: 'range', class: 'slider', min: 0, max: 1, step: 0.01, value: ambient.volume(item.id),
        'aria-label': `${item.name} volume`, oninput: (e) => ambient.setVolume(item.id, +e.target.value) });
      const sliderRow = h('div', { style: { padding: '0 14px 10px 46px' }, hidden: !ambient.isOn(item.id) }, slider);
      const toggle = switchEl(ambient.isOn(item.id), async (on) => {
        sliderRow.hidden = !on;
        try { await ambient.toggle(item.id, on); } catch (e) { toast(e.message, { bad: true }); }
      });
      return h('div', {},
        h('div', { class: 'list-row' },
          svg(ICON[item.id] || icons.music),
          h('span', { class: 'grow' }, item.name),
          removable ? h('button', { class: 'icon-btn', style: { width: '34px', height: '34px' }, 'aria-label': `Remove ${item.name}`,
            onclick: async () => { await ambient.removeCustom(item.id); draw(); } }, svg(icons.trash)) : null,
          toggle),
        sliderRow);
    };

    const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.aac,.wav', hidden: true, onchange: async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const id = await ambient.addCustom(f);
      fileInput.value = '';
      await draw();
      try { await ambient.toggle(id, true); await draw(); } catch (e) { toast('Couldn’t play that file: ' + e.message, { bad: true }); }
    } });

    async function draw() {
      const all = await ambient.builtIns();
      nature.replaceChildren(...all.filter((s) => s.kind === 'nature').map((s) => row(s)));
      music.replaceChildren(...all.filter((s) => s.kind === 'music').map((s) => row(s)));
      const mine = await ambient.customs();
      yours.replaceChildren(...mine.map((s) => row(s, true)),
        h('label', { class: 'list-row', style: { cursor: 'pointer' } }, fileInput, svg(icons.plus),
          h('span', { class: 'grow' }, h('div', {}, 'Add a song or sound'), h('div', { class: 'sub' }, 'Any audio file from your Files app. Stays on this device.'))));
    }
    draw();

    return [
      h('h2', {}, 'Background sounds'),
      h('p', { class: 'lead' }, 'Play softly under the book. Mix as many as you like and set each one’s volume.'),
      h('h3', {}, 'Nature'), nature,
      h('h3', {}, 'Music'), music,
      h('h3', {}, 'Your sounds'), yours,
      h('div', { class: 'list', style: { marginTop: '18px' } },
        h('div', { class: 'list-row' },
          h('span', { class: 'grow' }, h('div', {}, 'Pause with the book'), h('div', { class: 'sub' }, 'Sounds stop when the book stops')),
          switchEl(settings.get('ambientFollow') !== false, (v) => settings.set({ ambientFollow: v })))),
    ];
  });
}
