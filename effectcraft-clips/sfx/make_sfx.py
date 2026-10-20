# Synthesised cartoon SFX for Tasaki reels — no third-party samples, safe to reuse anywhere.
# Run: uv run --with numpy --with scipy python make_sfx.py
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 48000
OUT = __file__.rsplit("/", 1)[0] + "/"


def t(d): return np.arange(int(SR * d)) / SR


def env(n, a=0.005, r=None):
    e = np.ones(n)
    k = max(1, int(SR * a)); e[:k] = np.linspace(0, 1, k)
    if r: e *= np.exp(-np.arange(n) / (SR * r))
    return e


def sweep(f0, f1, d, shape="sin"):
    f = np.geomspace(f0, f1, int(SR * d))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) if shape == "sin" else np.sign(np.sin(ph)) * 0.5


def save(name, x, gain=0.8):
    x = x / (np.max(np.abs(x)) + 1e-9) * gain
    st = np.stack([x, x], 1)
    wavfile.write(OUT + name + ".wav", SR, (st * 32767).astype(np.int16))


# pop: short pitched blip
x = sweep(900, 300, 0.08) * env(int(SR * .08), .001, .02); save("pop", x)

# boing: wobbling spring
tt = t(0.6); f = 180 + 120 * np.exp(-tt * 6) * np.sin(2 * np.pi * 14 * tt)
x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(tt), .002, .25); save("boing", x)

# whoosh: band-passed noise swell
n = np.random.default_rng(1).standard_normal(int(SR * .45))
sos = butter(2, [600, 4000], "bandpass", fs=SR, output="sos")
w = sosfilt(sos, n) * np.sin(np.linspace(0, np.pi, len(n))) ** 2; save("whoosh", w, .6)

# ding: bell partials
tt = t(1.2)
x = sum(a * np.sin(2 * np.pi * f * tt) for f, a in [(1568, 1), (3136, .4), (4704, .2), (2093, .3)]) * env(len(tt), .001, .35)
save("ding", x, .55)

# tada: two-note brass-ish fanfare
def note(f, d):
    tt = t(d); return sum(np.sin(2 * np.pi * f * k * tt) / k for k in range(1, 6)) * env(len(tt), .01, d * .6)
x = np.concatenate([note(523, .12), np.zeros(int(SR * .03)), note(784, .6)]); save("tada", x, .6)

# slide whistle up / down
for name, a, b in [("slide_up", 500, 1600), ("slide_down", 1600, 450)]:
    tt = t(.55); vib = 1 + .02 * np.sin(2 * np.pi * 7 * tt)
    f = np.geomspace(a, b, len(tt)) * vib
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(tt), .02) * np.linspace(1, .6, len(tt))
    save(name, x, .5)
print("ok")
