// Reads a title, author and a short passage from a PDF/EPUB right on the phone,
// used to pre-fill the Add form and for "hear it with your book" previews.

export const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

let pdfjsPromise;
export function loadPdfJs() {
  pdfjsPromise ??= import(PDFJS + 'pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

export async function bookInfo(file) {
  try {
    if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') return await epubInfo(file);
    return await pdfInfo(file);
  } catch (e) {
    console.warn('Could not read book details', e);
    return { title: '', author: '', sample: '' };
  }
}

async function pdfInfo(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const meta = await doc.getMetadata().catch(() => ({}));
  const info = meta?.info || {};
  let sample = '';
  const start = Math.min(doc.numPages, Math.max(1, Math.round(doc.numPages * 0.08)));
  for (let p = start; p <= Math.min(doc.numPages, start + 4) && !sample; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    sample = pickPassage(tc.items.map((i) => i.str + (i.hasEOL ? ' ' : '')).join(''));
  }
  const out = { title: (info.Title || '').trim(), author: (info.Author || '').trim(), sample, pages: doc.numPages };
  doc.destroy();
  return out;
}

async function epubInfo(file) {
  const { default: JSZip } = await import(JSZIP);
  const zip = await JSZip.loadAsync(file);
  const parse = (xml, type = 'application/xml') => new DOMParser().parseFromString(xml, type);
  const container = parse(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parse(await zip.file(opfPath).async('string'));
  const byTag = (tag) => opf.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() || '';
  const manifest = {};
  for (const item of opf.getElementsByTagNameNS('*', 'item')) manifest[item.getAttribute('id')] = item.getAttribute('href');
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  let sample = '';
  const start = Math.floor(spine.length * 0.15);
  for (let i = start; i < spine.length && !sample; i++) {
    const f = zip.file(decodeURIComponent(base + spine[i]));
    if (!f) continue;
    const doc = parse(await f.async('string'), 'text/html');
    const paras = [...doc.querySelectorAll('p')].map((p) => p.textContent.replace(/\s+/g, ' ').trim());
    sample = pickPassage(paras.join(' '));
  }
  return { title: byTag('title'), author: byTag('creator'), sample };
}

/** Two or three sentences of real prose from a chunk of text. */
export function pickPassage(text) {
  text = text.replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1$2').trim();
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]?/g) || [];
  const good = sentences.map((s) => s.trim()).filter((s) => s.length > 30 && /^[A-Z“"']/.test(s));
  let out = '';
  for (const s of good) {
    if ((out + ' ' + s).length > 200) break;
    out = (out + ' ' + s).trim();
  }
  return out || good[0]?.slice(0, 200) || '';
}
