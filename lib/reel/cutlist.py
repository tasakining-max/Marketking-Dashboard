"""คัต: turn the sentence ranges you chose into a tight cut list (her cutting method).
usage: python3 lib/reel/cutlist.py pick.json > cut.json
pick.json = {"dir": ..., "name": ..., "scan": "~/Movies/FilmCraft/<shoot>/_scan",
  "pick": [ {"clip": "MVI_8899", "in": 2.6, "out": 19.8, "drop": [[11.2, 11.9]]},   # speech
            {"clip": "MVI_8902", "in": 1.0, "out": 3.5, "broll": true} ] }       # no talk → muted
For speech ranges it snaps the edges to the first/last word, then cuts every
silent gap ≥ 0.10 s (found in a 10 ms energy envelope, adaptive threshold),
leaving 1 frame of air each side; "drop" removes fillers/repeats you spotted
(เออ อืม คำซ้ำ) by source time. Never re-run Whisper: words come from the scan.
Output is the cut.json build.py takes (rotation filled in from the scan)."""
import json, os, sys, array, math, subprocess

AIR = 1 / 30
MIN_GAP = 0.10


def words(scan, clip, a, b):
    j = json.load(open(os.path.join(scan, clip + '.json')))
    ws = [w for s in j['segments'] for w in s.get('words', []) if w['end'] > a and w['start'] < b and w['word'].strip()]
    return j, ws


def env(path, a, b):
    x = array.array('h', subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(a), '-to', str(b), '-i', path, '-ac', '1', '-ar', '16000', '-af', 'highpass=f=150', '-f', 's16le', '-'], capture_output=True).stdout)
    n = 160
    return [20 * math.log10(math.sqrt(sum(v * v for v in x[i:i + n]) / n) + 1) for i in range(0, len(x) - n, n)]


def gaps(e, t0):
    out = []; i = 0
    while i < len(e):
        w = sorted(e[max(0, i - 150):i + 150]); fl, pk = w[len(w) // 10], w[9 * len(w) // 10]
        thr = fl + 0.22 * (pk - fl)
        if e[i] < thr:
            j = i
            while j < len(e) and e[j] < thr: j += 1
            if (j - i) * 0.01 >= MIN_GAP: out.append((t0 + i * 0.01, t0 + j * 0.01))
            i = j
        else: i += 1
    return out


def main(spec):
    c = json.load(open(spec)); scan = os.path.expanduser(c['scan'])
    segs = []
    for p in c['pick']:
        j, ws = words(scan, p['clip'], p['in'], p['out'])
        rot = j.get('rotation') or 0
        if p.get('broll'):
            segs.append({'file': j['file'], 'in': p['in'], 'out': p['out'], 'rot': rot, 'mute': True}); continue
        a = max(p['in'], ws[0]['start'] - 0.05) if ws else p['in']
        b = min(p['out'], ws[-1]['end'] + 0.12) if ws else p['out']
        cuts = gaps(env(j['file'], a, b), a) + [tuple(d) for d in p.get('drop', [])]
        cuts = sorted((max(a, s + AIR), min(b, e - AIR)) for s, e in cuts if e - s > 2 * AIR)
        t = a
        for s, e in cuts:
            if s - t >= 0.12: segs.append({'file': j['file'], 'in': round(t, 3), 'out': round(s, 3), 'rot': rot})
            t = max(t, e)
        if b - t >= 0.12: segs.append({'file': j['file'], 'in': round(t, 3), 'out': round(b, 3), 'rot': rot})
    kept = sum(s['out'] - s['in'] for s in segs)
    print(json.dumps({'dir': c['dir'], 'name': c['name'], 'segments': segs}, ensure_ascii=False, indent=1))
    print(f'{len(segs)} pieces, {kept:.1f} s', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1])
