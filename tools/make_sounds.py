"""Synthesises the background sounds in app/sounds/ (rain, fire, ocean, brown
noise, and original lofi and bossa nova loops). Everything is generated from
scratch here, so there are no licensing questions.

Needs numpy, scipy and av:  python tools/make_sounds.py
"""

from __future__ import annotations

import json
import os

import numpy as np
from scipy import signal

SR = 32000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "sounds")
rng = np.random.default_rng(7)


# ---------------------------------------------------------------- helpers


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def shaped_noise(n, shape, channels=2):
    """Noise with the given spectral shape (a function of frequency in Hz).
    Made in the frequency domain, so it loops perfectly."""
    out = []
    f = np.fft.rfftfreq(n, 1 / SR)
    gain = shape(np.maximum(f, 1.0))
    for _ in range(channels):
        spec = np.fft.rfft(rng.standard_normal(n)) * gain
        x = np.fft.irfft(spec, n)
        out.append(x / (np.std(x) + 1e-9))
    return np.stack(out)


def smooth_random(n, points, lo, hi):
    """A slow random curve that loops (for flicker, swells...)."""
    k = rng.uniform(lo, hi, points)
    k = np.concatenate([k, k[:1]])
    x = np.linspace(0, points, n, endpoint=False)
    i = np.floor(x).astype(int)
    frac = x - i
    frac = (1 - np.cos(np.pi * frac)) / 2
    return k[i] * (1 - frac) + k[i + 1] * frac


def add_wrapped(buf, start, sig, pan=0.0):
    """Add a mono signal into a stereo loop buffer, wrapping past the end."""
    n = buf.shape[1]
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    idx = (start + np.arange(len(sig))) % n
    np.add.at(buf[0], idx, sig * left * 1.41)
    np.add.at(buf[1], idx, sig * right * 1.41)


def bandpass(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def lowpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype="low", fs=SR, output="sos"), x)


def highpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype="high", fs=SR, output="sos"), x)


def reverb(buf, seconds=1.6, mix=0.18):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.empty_like(buf)
    for c in range(buf.shape[0]):
        ir = rng.standard_normal(n) * np.exp(-t * 6.9 / seconds)
        ir = lowpass(ir, 5000)
        ir /= np.sqrt(np.sum(ir**2))
        wet = signal.fftconvolve(buf[c], ir)[: buf.shape[1]]
        out[c] = buf[c] * (1 - mix) + wet * mix * 1.4
    return out


def fold_loop(buf, length):
    """Fold the tail past the loop point back onto the start, so it loops seamlessly."""
    out = buf[:, :length].copy()
    tail = buf[:, length:]
    out[:, : tail.shape[1]] += tail
    return out


def level(buf, rms_db=-23.0):
    rms = np.sqrt(np.mean(buf**2))
    buf = buf * (10 ** (rms_db / 20) / rms)
    peak = np.max(np.abs(buf))
    return buf * (0.95 / peak) if peak > 0.95 else buf


def save(name, buf, bitrate):
    import av

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.m4a")
    pcm = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
    c = av.open(path, "w", format="mp4", options={"movflags": "+faststart"})
    s = c.add_stream("aac", rate=SR, layout="stereo")
    s.bit_rate = bitrate
    step = 4096
    for i in range(0, pcm.shape[1], step):
        chunk = np.ascontiguousarray(pcm[:, i : i + step].T).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout="stereo")
        frame.sample_rate = SR
        for p in s.encode(frame):
            c.mux(p)
    for p in s.encode(None):
        c.mux(p)
    c.close()
    print(f"  {name}: {buf.shape[1] / SR:.1f}s, {os.path.getsize(path) / 1e6:.2f} MB")
    return buf.shape[1] / SR


# ---------------------------------------------------------------- nature


def rain(seconds=60):
    n = seconds * SR
    hiss = shaped_noise(n, lambda f: np.exp(-((np.log(f / 2800)) ** 2) / 1.1) * np.exp(-f / 9000))
    body = shaped_noise(n, lambda f: 1 / np.sqrt(f) * (f > 60) * np.exp(-f / 1800))
    buf = hiss * 0.6 + body * 0.6
    buf *= smooth_random(n, 12, 0.85, 1.1)
    for _ in range(int(seconds * 45)):  # drops on leaves and the window
        dur = rng.uniform(0.004, 0.02)
        t = np.arange(int(dur * SR)) / SR
        drop = highpass(rng.standard_normal(len(t)), rng.uniform(1500, 5000), 1) * np.exp(-t / (dur / 4))
        add_wrapped(buf, rng.integers(n), drop * rng.uniform(0.2, 1.2) ** 2 * 0.9, rng.uniform(-0.8, 0.8))
    return level(buf, -24)


def fire(seconds=60):
    n = seconds * SR
    rumble = shaped_noise(n, lambda f: 1 / f * (f > 30) * np.exp(-f / 350))
    roar = shaped_noise(n, lambda f: 1 / np.sqrt(f) * np.exp(-((np.log(f / 900)) ** 2) / 0.8))
    buf = rumble * smooth_random(n, 90, 0.5, 1.0) + roar * 0.22 * smooth_random(n, 140, 0.4, 1.0)
    t_all = 0.0
    while t_all < seconds:  # crackles come in little clusters
        t_all += rng.exponential(0.16)
        dur = rng.uniform(0.0015, 0.012)
        t = np.arange(max(8, int(dur * SR))) / SR
        crack = highpass(rng.standard_normal(len(t)), rng.uniform(1200, 4000), 2) * np.exp(-t / (dur / 3))
        amp = rng.pareto(2.2) * 0.35
        add_wrapped(buf, int(t_all * SR) % n, crack * min(amp, 2.5), rng.uniform(-0.6, 0.6))
    for _ in range(int(seconds * 0.6)):  # a few bigger pops
        t = np.arange(int(0.05 * SR)) / SR
        pop = bandpass(rng.standard_normal(len(t)), 600, 2500) * np.exp(-t / 0.008)
        add_wrapped(buf, rng.integers(n), pop * rng.uniform(1.5, 3.5), rng.uniform(-0.5, 0.5))
    return level(buf, -24)


def ocean(seconds=64):
    n = seconds * SR
    low = shaped_noise(n, lambda f: 1 / np.sqrt(f) * (f > 40) * np.exp(-f / 700))
    high = shaped_noise(n, lambda f: np.exp(-((np.log(f / 2500)) ** 2) / 1.2))
    env = np.zeros(n)
    t = 0.0
    while t < seconds:  # each wave: a slow rise, a crash, a long wash
        rise, fall = rng.uniform(2.5, 4), rng.uniform(4, 6.5)
        k = np.arange(int((rise + fall) * SR)) / SR
        shape = np.where(k < rise, (k / rise) ** 2, np.exp(-(k - rise) / (fall / 3)))
        idx = (int(t * SR) + np.arange(len(k))) % n
        np.add.at(env, idx, shape * rng.uniform(0.6, 1.0))
        t += rng.uniform(7, 10.5)
    env = 0.15 + env / env.max()
    buf = low * env + high * env**2 * 0.6
    return level(buf, -24)


def brown(seconds=60):
    n = seconds * SR
    buf = shaped_noise(n, lambda f: 1 / f * (f > 25) * np.exp(-f / 4000))
    return level(buf, -25)


# ---------------------------------------------------------------- instruments


def e_piano(freq, dur, vel):
    """A soft Rhodes-like electric piano (FM synthesis)."""
    t = np.arange(int(dur * SR)) / SR
    wobble = 0.0025 * freq / 0.7 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * freq * t + wobble
    index = 1.3 * np.exp(-t * 5) + 0.25 * vel
    tone = np.sin(phase + index * np.sin(phase))
    tine = 0.12 * np.sin(14 * phase) * np.exp(-t * 30) if freq * 14 < SR / 2.2 else 0
    env = np.exp(-t * 1.1) * (1 - np.exp(-t * 400))
    rel = np.clip((dur - t) / 0.12, 0, 1)
    return (tone + tine) * env * rel * vel


def sub_bass(freq, dur, vel):
    t = np.arange(int(dur * SR)) / SR
    x = np.sin(2 * np.pi * freq * t)
    x = np.tanh(1.6 * x) + 0.2 * np.sin(4 * np.pi * freq * t)
    env = (1 - np.exp(-t * 150)) * np.exp(-t * 1.2) * np.clip((dur - t) / 0.05, 0, 1)
    return x * env * vel


def nylon(freq, dur, vel, bright=0.5):
    """Plucked nylon string (Karplus-Strong at 4x rate, then downsampled)."""
    up = 4
    sr2 = SR * up
    period = int(round(sr2 / freq))
    total = int(dur * sr2)
    y = np.zeros(total + period + 1)
    exc = rng.standard_normal(period)
    exc = signal.lfilter([1 - bright], [1, -bright], exc)  # softer pluck = darker
    y[1 : period + 1] = exc
    decay = 0.9985 if freq < 200 else 0.9975
    k = period + 1
    while k < total:
        end = min(k + period, total)
        y[k:end] = decay * 0.5 * (y[k - period : end - period] + y[k - period - 1 : end - period - 1])
        k = end
    x = signal.resample_poly(y[1:total], 1, up)
    t = np.arange(len(x)) / SR
    x *= np.clip((dur - t) / 0.08, 0, 1)
    return lowpass(x, 3200) * vel / (np.max(np.abs(x)) + 1e-9)


def kick(vel):
    t = np.arange(int(0.45 * SR)) / SR
    f = 46 + 70 * np.exp(-t * 28)
    x = np.sin(np.cumsum(2 * np.pi * f / SR)) * np.exp(-t * 7.5)
    return x * vel


def snare(vel):
    t = np.arange(int(0.25 * SR)) / SR
    noise = bandpass(rng.standard_normal(len(t)), 900, 5000) * np.exp(-t * 20)
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 30)
    return (noise * 0.75 + tone * 0.4) * vel


def hat(vel, open_=False):
    t = np.arange(int((0.18 if open_ else 0.05) * SR)) / SR
    x = highpass(rng.standard_normal(len(t)), 7000) * np.exp(-t * (18 if open_ else 70))
    return x * vel


def shaker(vel):
    t = np.arange(int(0.07 * SR)) / SR
    env = np.sin(np.pi * np.clip(t / 0.07, 0, 1)) ** 2
    return bandpass(rng.standard_normal(len(t)), 4000, 8000) * env * vel


def rim(vel):
    t = np.arange(int(0.06 * SR)) / SR
    x = bandpass(rng.standard_normal(len(t)), 1500, 4000) * np.exp(-t * 90) + np.sin(2 * np.pi * 1700 * t) * np.exp(-t * 120)
    return x * vel


# ---------------------------------------------------------------- lofi


def lofi():
    bpm = 74
    beat = 60 / bpm
    bar = beat * 4
    swing = 0.17 * beat / 2
    # (bass root, chord voicing) per bar
    prog_a = [(38, [53, 57, 60, 64]), (43, [53, 59, 64, 69]), (36, [52, 55, 59, 62]), (45, [55, 61, 65, 70])]
    prog_b = [(41, [57, 60, 64, 67]), (40, [55, 59, 62, 66]), (38, [53, 57, 60, 65]), (43, [53, 59, 62, 67])]
    form = prog_a * 2 + prog_b + prog_a + prog_b * 2 + prog_a * 2
    bars = len(form)
    length = int(bars * bar * SR)
    music = np.zeros((2, length + int(4 * SR)))
    drums = np.zeros_like(music)

    def at(sec):
        return int(sec * SR)

    melody_bars = set(range(8, 16)) | set(range(24, 32))
    for b, (root, chord) in enumerate(form):
        t0 = b * bar
        hum = rng.uniform(0, 0.02)
        for k, note in enumerate(chord):  # chords, gently strummed
            add_wrapped(music, at(t0 + hum + k * 0.012), e_piano(midi(note), bar * 0.98, 0.22), pan=-0.3 + k * 0.2)
        if b % 2 == 1:
            for k, note in enumerate(chord[1:]):
                add_wrapped(music, at(t0 + 2.5 * beat + swing + k * 0.01), e_piano(midi(note), beat * 1.4, 0.1), pan=0.2)
        add_wrapped(music, at(t0), sub_bass(midi(root), beat * 2.4, 0.5))
        add_wrapped(music, at(t0 + 2.5 * beat + swing), sub_bass(midi(root + (7 if b % 2 else 12)), beat * 1.3, 0.35))
        if b in melody_bars:  # a sparse, soft melody from the chord tones
            pool = sorted({n + 12 for n in chord} | {n + 24 for n in chord[:2]})
            for slot in sorted(rng.choice(8, size=rng.integers(2, 4), replace=False)):
                note = int(rng.choice(pool))
                when = t0 + slot * beat / 2 + (swing if slot % 2 else 0)
                add_wrapped(music, at(when), e_piano(midi(note), beat * 1.2, 0.13), pan=0.35)
        # drums: laid-back boom-bap
        for s in range(8):
            when = t0 + s * beat / 2 + (swing if s % 2 else 0) + rng.uniform(-0.006, 0.006)
            if s in (0, 5) or (s == 3 and b % 4 == 3):
                add_wrapped(drums, at(when), kick(0.9 if s == 0 else 0.7))
            if s in (2, 6):
                add_wrapped(drums, at(when + 0.012), snare(0.55), pan=0.05)
            add_wrapped(drums, at(when), hat(0.22 if s % 2 else 0.32, open_=(s == 7 and b % 4 == 1)), pan=0.3)

    music = fold_loop(music, length)
    drums = fold_loop(drums, length)
    music = reverb(music, 1.8, 0.22)
    mix = music * 1.0 + drums * 0.55
    for c in range(2):
        mix[c] = lowpass(mix[c], 4200, 2)  # warm, slightly muffled tape tone
    vinyl = shaped_noise(length, lambda f: np.exp(-f / 3000)) * 0.004
    for _ in range(int(bars * bar * 2.5)):
        add_wrapped(vinyl, rng.integers(length), highpass(rng.standard_normal(24), 2000) * rng.uniform(0.002, 0.03))
    return level(mix + vinyl, -22)


# ---------------------------------------------------------------- bossa nova


def bossa():
    bpm = 132
    eighth = 60 / bpm / 2
    bar = eighth * 8
    chords = {  # bass root, guitar voicing
        "Gmaj7": (43, [54, 59, 62, 66]), "Am7": (45, [55, 60, 64, 67]), "D7": (38, [54, 60, 64, 69]),
        "G#dim7": (44, [53, 59, 62, 65]), "Bm7": (47, [57, 62, 66, 69]), "E7": (40, [56, 62, 66, 71]),
        "Em7": (40, [55, 62, 66, 71]), "D7b9": (38, [54, 60, 63, 69]), "Cmaj7": (36, [52, 59, 64, 67]),
        "Cm6": (36, [51, 57, 60, 67]),
    }
    form = ["Gmaj7", "Gmaj7", "Am7", "D7", "Gmaj7", "G#dim7", "Am7", "D7",
            "Bm7", "E7", "Am7", "D7", "Cmaj7", "Cm6", "Am7", "D7b9"] * 2
    length = int(len(form) * bar * SR)
    buf = np.zeros((2, length + int(4 * SR)))
    perc = np.zeros_like(buf)
    clave = [0, 3, 6, 10, 13]  # the bossa rhythm over two bars, in eighths

    def at(sec):
        return int(sec * SR)

    cache = {}

    def pluck(note, dur, vel, bright):
        key = (note, round(dur, 2), round(bright, 1))
        if key not in cache:
            cache[key] = nylon(midi(note), dur, 1.0, bright)
        return cache[key] * vel

    for b, name in enumerate(form):
        root, voicing = chords[name]
        t0 = b * bar
        fifth = root + 7 if root + 7 <= 47 else root - 5
        for pos, note, vel in [(0, root, 0.55), (3, root, 0.18), (4, fifth, 0.5), (7, fifth, 0.16)]:
            add_wrapped(buf, at(t0 + pos * eighth + rng.uniform(0, 0.008)), pluck(note, 1.2, vel, 0.3), pan=-0.1)
        for pos in clave:
            if pos // 8 != b % 2:
                continue
            when = t0 + (pos % 8) * eighth
            for k, note in enumerate(voicing):  # quick finger pluck, low to high
                add_wrapped(buf, at(when + k * 0.006 + rng.uniform(0, 0.004)), pluck(note, eighth * 2.6, 0.28, 0.45), pan=0.15 + k * 0.05)
            add_wrapped(perc, at(when), rim(0.22), pan=-0.4)
        for s in range(16):
            when = t0 + s * eighth / 2 + rng.uniform(-0.004, 0.004)
            add_wrapped(perc, at(when), shaker(0.22 if s % 4 == 2 else 0.1), pan=0.45)
        if b % 2 == 0:
            add_wrapped(perc, at(t0), kick(0.35))

    buf = fold_loop(buf, length)
    perc = fold_loop(perc, length)
    mix = reverb(buf, 1.5, 0.2) + perc * 0.6
    return level(mix, -22)


SOUNDS = [
    ("rain", "Rain", "nature", rain, 64000),
    ("fire", "Fireplace", "nature", fire, 64000),
    ("ocean", "Ocean waves", "nature", ocean, 64000),
    ("brown", "Brown noise", "nature", brown, 48000),
    ("lofi", "Lofi beats", "music", lofi, 96000),
    ("bossa", "Bossa nova guitar", "music", bossa, 96000),
]

if __name__ == "__main__":
    index = []
    for sid, name, kind, make, bitrate in SOUNDS:
        duration = save(sid, make(), bitrate)
        index.append({"id": sid, "name": name, "kind": kind, "file": f"sounds/{sid}.m4a", "loop": round(duration, 4)})
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
