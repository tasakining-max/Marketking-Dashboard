"""คัต step 3: put graphics, SFX, music and an ending photo burst on the open sequence.
usage: python3 lib/reel/place.py place.json
place.json = {
  "graphics": [ {"png": ".../a1.png", "start": 2, "end": 60, "anim": "slam"|"soft"|"none",
                 "sfx": "poco"|"popmouth"|"stickswing"|..., "db": -8, "cycle": [png,png,png]?} ],
  "music": {"file": ".../track.mp3", "talk_db": -20, "free_db": -5, "free": [[245, 350], [605, 673]]}?,
  "photos": {"files": ["/…/IMG_1.JPG", …], "start": 605, "step": 13, "hold": 42}?,
  "end": <last frame> (optional, for music/photos)
}
Times are sequence frames (30 fps). slam = 140→95→100 % over 0/2/4 f (text);
soft = 90→100 % over 5 f + fade 2 f (pictures). "cycle" swaps the PNGs every
4 frames between start and end (moving effects such as cold air).
SFX land exactly on the graphic's first frame, on A2."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc import ex, inspect, T, F, SFX
from PIL import Image, ImageOps, ImageFilter

cache = {}


def item(path):
    if path not in cache: cache[path] = ex('file.import', {'paths': [path]})['items'][0]
    return cache[path]


def tracks(n):
    while len(inspect()['video']) < n: ex('sequence.addTracks', {'video': 1})
    return [t['id'] for t in inspect()['video']]


def free_track(vids, occ, s, e):
    for v in vids[1:]:
        if all(e <= a or s >= b for a, b in occ.setdefault(v, [])):
            occ[v].append((s, e)); return v
    raise RuntimeError('no free video track')


def K(c, eff, p, f, v): ex('effects.setParam', {'clip': c, 'effect': eff, 'param': p, 'value': v, 'time': f * F, 'keyframe': True})


def put(png, track, s, e):
    return ex('timeline.place', {'item': item(png), 'track': track, 'time': s * F, 'insert': False, 'duration': (e - s) * F})['clips'][0]


def sfx(name, f, db, track='A2'):
    path = name if os.path.isabs(name) else os.path.join(SFX, name + '.mp3')
    a = ex('timeline.place', {'item': item(path), 'track': track, 'time': max(0, f) * F, 'insert': False, 'video': False})['clips'][0]
    ex('effects.setParam', {'clip': a, 'effect': 'volume', 'param': 'level', 'value': db}); return a


def graphics(gs, vids, occ):
    for g in gs:
        s, e = g['start'], g['end']
        if g.get('cycle'):
            tr = free_track(vids, occ, s, e); f = s; k = 0
            while f < e:
                c = put(g['cycle'][k % len(g['cycle'])], tr, f, min(f + 4, e))
                if f == s:
                    for d, v in ((0, 0), (2, 100)): K(c, 'opacity', 'opacity', f + d, v)
                f += 4; k += 1
        else:
            c = put(g['png'], free_track(vids, occ, s, e), s, e)
            b = Image.open(g['png']).split()[3].point(lambda v: 255 if v > 100 else 0).getbbox()
            cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
            ex('effects.setParam', {'clip': c, 'effect': 'motion', 'param': 'anchor', 'value': [cx, cy]})
            ex('effects.setParam', {'clip': c, 'effect': 'motion', 'param': 'position', 'value': [cx, cy]})
            if g.get('anim', 'slam') == 'slam':
                for d, v in ((0, 140), (2, 95), (4, 100)): K(c, 'motion', 'scale', s + d, v)
            elif g['anim'] == 'soft':
                for d, v in ((0, 90), (5, 100)): K(c, 'motion', 'scale', s + d, v)
                for d, v in ((0, 0), (2, 100)): K(c, 'opacity', 'opacity', s + d, v)
        if g.get('sfx'): sfx(g['sfx'], s - g.get('lead', 0), g.get('db', -9))


def photos(p, gfx_dir, vids):
    """Tilted white-border cards on a blurred copy, one shutter click each."""
    os.makedirs(gfx_dir, exist_ok=True)
    shutter = os.path.join(gfx_dir, 'shutter1.wav')
    if not os.path.exists(shutter):
        os.system(f'ffmpeg -v error -y -ss 0.03 -t 0.22 -i "{SFX}/camera_burst.mp3" -af "afade=t=out:st=0.18:d=0.04" "{shutter}"')
    n = len(p['files']); end = p['start'] + (n - 1) * p['step'] + p['hold']
    vids = tracks(1 + n)
    for k, f in enumerate(p['files']):
        im = ImageOps.exif_transpose(Image.open(f)).convert('RGB')
        bg = ImageOps.fit(im, (1080, 1920)).filter(ImageFilter.GaussianBlur(40))
        bg = Image.blend(bg, Image.new('RGB', (1080, 1920), (0, 18, 34)), 0.2)
        w = 880 if im.width >= im.height else 700
        ph = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        card = Image.new('RGBA', (ph.width + 36, ph.height + 36), (255, 255, 255, 255)); card.paste(ph, (18, 18))
        card = card.rotate([-4, 3, -2, 4][k % 4], resample=Image.BICUBIC, expand=True)
        sh = Image.new('RGBA', card.size, (0, 0, 0, 0)); sh.putalpha(card.split()[3].point(lambda v: int(v * .5))); sh = sh.filter(ImageFilter.GaussianBlur(14))
        C = Image.new('RGBA', (1080, 1920), (0, 0, 0, 0)); x = (1080 - card.width) // 2; y = (1920 - card.height) // 2 - 40
        C.alpha_composite(sh, (x, y + 16)); C.alpha_composite(card, (x, y))
        bgp, cp = os.path.join(gfx_dir, f'photo{k}_bg.png'), os.path.join(gfx_dir, f'photo{k}_card.png')
        bg.save(bgp); C.save(cp)
        s = p['start'] + k * p['step']
        put(bgp, 'V1', s, end)
        c = put(cp, vids[1 + k], s, end)
        for d, v in ((0, 118), (2, 97), (4, 100)): K(c, 'motion', 'scale', s + d, v)
        for d, v in ((0, 0), (1, 100)): K(c, 'opacity', 'opacity', s + d, v)
        sfx(shutter, s, -4)
    return end


def music(m, end):
    a = ex('timeline.place', {'item': item(m['file']), 'track': 'A3', 'time': 0, 'insert': False, 'video': False, 'duration': end * F})['clips'][0]
    pts = [(0, -40), (8, m['talk_db'])]
    for s, e in m.get('free', []):
        pts += [(s - 5, m['talk_db']), (s + 5, m['free_db']), (e - 5, m['free_db']), (min(e + 5, end - 30), m['talk_db'])]
    pts += [(end - 30, pts[-1][1]), (end, -40)]
    for f, db in sorted(dict(pts).items()):
        ex('effects.setParam', {'clip': a, 'effect': 'volume', 'param': 'level', 'value': db, 'time': f * F, 'keyframe': True})


def main(spec):
    c = json.load(open(spec))
    vids = tracks(4); occ = {}
    graphics(c.get('graphics', []), vids, occ)
    end = c.get('end') or round(inspect()['duration'] / F)
    if c.get('photos'):
        d = c['photos'].get('dir') or (os.path.dirname(c['graphics'][0]['png']) if c.get('graphics') else None)
        if not d: raise SystemExit('photos.dir is required when there are no graphics')
        end = photos(c['photos'], os.path.expanduser(d), vids)
    if c.get('music'): music(c['music'], end)
    ex('file.save', {})
    print(json.dumps({'frames': end, 'seconds': round(end / 30, 2)}))


if __name__ == '__main__':
    main(sys.argv[1])
