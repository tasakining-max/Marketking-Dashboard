"""Shared helpers for the reel agents: drive the live FilmCraft app over its
bridge (the app must be running with --control 7802) and read clip audio."""
import json, os, subprocess, array, math

B = os.path.expanduser('~/.local/bin/filmcraft-cli')
BRIDGE = ['--bridge', '127.0.0.1:7802', '--compact']
T = 254016000000          # FilmCraft ticks per second
F = T // 30               # one frame of a 30 fps sequence
FILMCRAFT = os.path.expanduser('~/Movies/FilmCraft')
SFX = os.path.join(FILMCRAFT, '_SFX Library')


def ex(cid, params=None):
    r = subprocess.run([B, *BRIDGE, 'exec', cid, json.dumps(params or {}, ensure_ascii=False)], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f'{cid}: {r.stderr.strip()[:300]}')
    try:
        return json.loads(r.stdout) if r.stdout.strip() else None
    except ValueError:
        return r.stdout


def inspect(what='sequence'):
    r = subprocess.run([B, *BRIDGE, 'inspect', what], capture_output=True, text=True)
    d = json.loads(r.stdout)
    return d.get(what, d) if what == 'sequence' else d


def export(path, fmt='h264', scale=None, audio=True):
    args = [B, *BRIDGE, 'export', path, '--format', fmt]
    if scale: args += ['--scale', str(scale)]
    if not audio: args += ['--no-audio']
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr[-300:])
    return path


def envelope(path, start=0.0, dur=None, hop=0.05):
    """dB energy every `hop` s (highpassed), for finding word edges."""
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start)] + (['-t', str(dur)] if dur else []) + ['-i', path, '-ac', '1', '-ar', '16000', '-af', 'highpass=f=150', '-f', 's16le', '-']
    x = array.array('h', subprocess.run(cmd, capture_output=True).stdout)
    n = int(16000 * hop)
    return [(round(start + i / 16000, 2), round(20 * math.log10(math.sqrt(sum(v * v for v in x[i:i + n]) / n) + 1), 1)) for i in range(0, len(x) - n, n)]


def luma(path, start, end, rot=0):
    vf = ('transpose=2,' if rot == -90 else 'transpose=1,' if rot == 90 else '') + 'scale=270:-2,format=gray'
    b = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-to', str(end), '-i', path, '-vf', vf, '-f', 'rawvideo', '-'], capture_output=True).stdout
    return round(sum(b) / len(b)) if b else None


def loudness(path):
    r = subprocess.run(['ffmpeg', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    lines = [l.strip() for l in r.stderr.splitlines() if l.strip().startswith(('I:', 'Peak:'))]
    return lines[-2:]
