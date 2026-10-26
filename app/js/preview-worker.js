// Runs Kokoro on the phone for short voice previews (not whole books).
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';

let ttsPromise;

function load(post) {
  ttsPromise ??= KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) post({ status: 'loading', progress: p.loaded / p.total });
    },
  }).catch((e) => { ttsPromise = null; throw e; });
  return ttsPromise;
}

self.onmessage = async ({ data }) => {
  const { id, text, voice } = data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    post({ status: 'loading', progress: 0 });
    const tts = await load(post);
    post({ status: 'generating' });
    const audio = await tts.generate(text, { voice });
    post({ status: 'done', blob: audio.toBlob() });
  } catch (e) {
    post({ status: 'error', message: String(e?.message || e) });
  }
};
