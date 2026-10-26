"""Synthesises the nature sounds in app/sounds/ (rain, fire, ocean, pink noise)
from scratch, then writes app/sounds/index.json together with the music
stations listed in tools/music.json (openly licensed tracks, credited there).

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
    """A wood fire up close: mostly crackles and snaps over a quiet glow (no wind)."""
    n = seconds * SR
    glow = shaped_noise(n, lambda f: 1 / f * (f > 40) * np.exp(-f / 250)) * 0.25 * smooth_random(n, 60, 0.6, 1.0)
    sizzle = shaped_noise(n, lambda f: np.exp(-((np.log(f / 5000)) ** 2) / 0.5)) * 0.004
    buf = glow + sizzle
    t = 0.0
    while t < seconds:  # crackles come in quick little bursts
        t += rng.exponential(0.18)
        tt = t
        for _ in range(rng.integers(1, 8)):
            tt += rng.exponential(0.022)
            dur = rng.uniform(0.0008, 0.006)
            k = np.arange(max(6, int(dur * SR))) / SR
            crack = highpass(rng.standard_normal(len(k)), rng.uniform(2000, 6000), 2) * np.exp(-k / (dur / 5))
            amp = min(rng.pareto(1.8) * 0.5 + 0.15, 3.0)
            add_wrapped(buf, int(tt * SR) % n, crack * amp, rng.uniform(-0.7, 0.7))
    for _ in range(int(seconds * 1.2)):  # sharper, woody snaps
        k = np.arange(int(0.04 * SR)) / SR
        snap = bandpass(rng.standard_normal(len(k)), 800, 4000) * np.exp(-k / 0.006)
        snap += 0.4 * np.sin(2 * np.pi * rng.uniform(300, 700) * k) * np.exp(-k / 0.01)
        add_wrapped(buf, rng.integers(n), snap * rng.uniform(1.5, 3.5), rng.uniform(-0.6, 0.6))
    return level(buf, -26)


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


def pink(seconds=60):
    n = seconds * SR
    buf = shaped_noise(n, lambda f: 1 / np.sqrt(f) * (f > 20) * np.exp(-f / 12000))
    return level(buf, -26)


SOUNDS = [
    ("rain", "Rain", rain, 64000),
    ("fire", "Fireplace", fire, 64000),
    ("ocean", "Ocean waves", ocean, 64000),
    ("pink", "Pink noise", pink, 48000),
]

if __name__ == "__main__":
    index = []
    for sid, name, make, bitrate in SOUNDS:
        duration = save(sid, make(), bitrate)
        index.append({"id": sid, "name": name, "kind": "nature", "file": f"sounds/{sid}.m4a", "loop": round(duration, 4)})
    # Music stations: openly licensed tracks listed in tools/music.json.
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "music.json")) as f:
        index.extend(json.load(f))
    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
