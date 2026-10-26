"""Kokoro speech synthesis plus AAC (.m4a) encoding and decoding."""

from __future__ import annotations

import re
import threading

import numpy as np

SAMPLE_RATE = 24000
REPO_ID = "hexgrad/Kokoro-82M"

VOICES = {
    "af_heart": "Heart", "af_bella": "Bella", "af_nicole": "Nicole", "af_aoede": "Aoede",
    "af_kore": "Kore", "af_sarah": "Sarah", "af_nova": "Nova", "af_sky": "Sky",
    "af_alloy": "Alloy", "af_jessica": "Jessica", "af_river": "River",
    "am_michael": "Michael", "am_fenrir": "Fenrir", "am_puck": "Puck", "am_echo": "Echo",
    "am_eric": "Eric", "am_liam": "Liam", "am_onyx": "Onyx", "am_adam": "Adam", "am_santa": "Santa",
    "bf_emma": "Emma", "bf_isabella": "Isabella", "bf_alice": "Alice", "bf_lily": "Lily",
    "bm_george": "George", "bm_fable": "Fable", "bm_lewis": "Lewis", "bm_daniel": "Daniel",
}


class Engine:
    """Loads Kokoro once and turns text into audio with word timings."""

    def __init__(self):
        import torch
        from kokoro import KModel, KPipeline

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = KModel(repo_id=REPO_ID).to(self.device).eval()
        self.pipelines = {
            code: KPipeline(lang_code=code, repo_id=REPO_ID, model=self.model) for code in ("a", "b")
        }
        self.lock = threading.Lock()

    def speak(self, text: str, voice: str) -> tuple[np.ndarray, list[tuple[str, float, float]]]:
        """Returns float32 mono audio and (token, start, end) timings in seconds."""
        pipeline = self.pipelines["b" if voice.startswith("b") else "a"]
        chunks, tokens, offset = [], [], 0.0
        with self.lock:
            for result in pipeline(text, voice=voice, speed=1, split_pattern=None):
                if result.audio is None:
                    continue
                audio = result.audio.detach().cpu().numpy().astype(np.float32)
                for tk in result.tokens or []:
                    if tk.start_ts is not None and tk.end_ts is not None:
                        tokens.append((tk.text, offset + tk.start_ts, offset + tk.end_ts))
                chunks.append(audio)
                offset += len(audio) / SAMPLE_RATE
        if not chunks:
            return np.zeros(0, np.float32), []
        return np.concatenate(chunks), tokens


def align_words(text: str, offsets: list[tuple[int, int]], tokens, start: float, end: float):
    """Give every word of a segment a [start, end] time using Kokoro's token timings."""
    lower = text.lower()
    spans = []  # (char_start, char_end, t0, t1)
    cursor = 0
    for tok, t0, t1 in tokens:
        key = tok.strip().lower()
        if not key or not re.search(r"\w", key):
            continue
        idx = lower.find(key, cursor)
        if idx < 0 or idx - cursor > 60:
            continue
        spans.append((idx, idx + len(key), t0, t1))
        cursor = idx + len(key)

    times: list[list[float] | None] = []
    for cs, ce in offsets:
        hit = [s for s in spans if s[0] < ce and s[1] > cs]
        times.append([min(h[2] for h in hit), max(h[3] for h in hit)] if hit else None)

    # Fill words Kokoro didn't time (numbers, symbols) by interpolation.
    n = len(times)
    i = 0
    while i < n:
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < n and times[j] is None:
            j += 1
        lo = times[i - 1][1] if i > 0 else 0.0
        hi = times[j][0] if j < n else max(end - start, lo)
        step = (hi - lo) / (j - i)
        for k in range(i, j):
            times[k] = [lo + step * (k - i), lo + step * (k - i + 1)]
        i = j
    return [[cs, ce, round(start + t[0], 3), round(start + t[1], 3)] for (cs, ce), t in zip(offsets, times)]


class AacWriter:
    """Streams mono audio into an AAC .m4a file."""

    def __init__(self, path: str, bitrate: int = 48000):
        import av

        self.container = av.open(path, "w", format="mp4", options={"movflags": "+faststart"})
        self.stream = self.container.add_stream("aac", rate=SAMPLE_RATE, layout="mono")
        self.stream.bit_rate = bitrate
        self.samples = 0

    @property
    def seconds(self) -> float:
        return self.samples / SAMPLE_RATE

    def write(self, audio: np.ndarray) -> None:
        import av

        if audio.dtype != np.int16:
            audio = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
        if not len(audio):
            return
        frame = av.AudioFrame.from_ndarray(audio.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = SAMPLE_RATE
        for pkt in self.stream.encode(frame):
            self.container.mux(pkt)
        self.samples += len(audio)

    def silence(self, seconds: float) -> None:
        self.write(np.zeros(int(seconds * SAMPLE_RATE), np.int16))

    def close(self) -> None:
        for pkt in self.stream.encode(None):
            self.container.mux(pkt)
        self.container.close()


def copy_prefix(src_path: str, writer: AacWriter, seconds: float) -> None:
    """Decode the first `seconds` of an existing .m4a into the writer (used for re-voicing)."""
    import av

    want = int(round(seconds * SAMPLE_RATE))
    with av.open(src_path) as src:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        for frame in src.decode(audio=0):
            for out in resampler.resample(frame):
                arr = out.to_ndarray().reshape(-1)
                room = want - writer.samples
                if room <= 0:
                    return
                writer.write(arr[:room])
    if writer.samples < want:
        writer.silence((want - writer.samples) / SAMPLE_RATE)
