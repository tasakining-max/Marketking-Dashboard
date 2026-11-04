"""คัต step 1: lay a cut list onto a new FilmCraft project.
usage: python3 lib/reel/build.py cut.json
cut.json = {
  "dir": "~/Movies/FilmCraft/<shoot>/<reel name>",   # project folder
  "name": "<reel name>",
  "segments": [ {"file": "/…/MVI_8931.MP4", "in": 0.98, "out": 3.20,
                 "rot": -90, "mute": false}, … ]       # seconds in the source
}
Every segment goes on V1/A1 back to back (30 fps, 1080x1920). Sideways
sources get rotated (rot 90/-90, scale 100.4). Dialogue clips get Essential
Sound noise + rumble reduction; "mute": true silences a b-roll piece.
Exposure is matched per segment to ~125 mean luma (exposure only, no grade).
Prints JSON {project, sequence, clips:[{seg, video, audio, start, end}], draft}."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc import ex, inspect, export, luma, T, F

TARGET_LUMA = 125
LUMA_PER_EV = 30


def main(spec):
    c = json.load(open(spec))
    d = os.path.expanduser(c['dir']); os.makedirs(d, exist_ok=True)
    name = c['name']
    proj = os.path.join(d, f'{name}.fcproj')
    ex('file.newProject', {'name': name}); ex('file.saveAs', {'path': proj})
    files = sorted({s['file'] for s in c['segments']})
    items = dict(zip(files, ex('file.import', {'paths': files})['items']))
    seq = ex('file.newSequence', {'name': name, 'width': 1080, 'height': 1920, 'fps': 30, 'video': 5, 'audio': 3})['sequence']
    t = 0; out = []
    for i, s in enumerate(c['segments']):
        a = round(s['in'] * 30); dur = round(s['out'] * 30) - a
        cl = ex('timeline.place', {'item': items[s['file']], 'track': 'V1', 'audioTrack': 'A1', 'time': t * F, 'insert': False, 'sourceIn': int(s['in'] * T), 'duration': dur * F})['clips']
        v, au = cl[0], cl[1:]
        rot = s.get('rot') or 0
        if rot:
            ex('effects.setParam', {'clip': v, 'effect': 'motion', 'param': 'rotation', 'value': rot})
            ex('effects.setParam', {'clip': v, 'effect': 'motion', 'param': 'scale', 'value': 100.4})
        y = luma(s['file'], s['in'], s['out'], rot)
        if y and y < TARGET_LUMA - 8:
            ev = round(min(1.5, (TARGET_LUMA - y) / LUMA_PER_EV), 2)
            ex('effects.apply', {'clips': [v], 'effect': 'lumetri'})
            ex('effects.setParam', {'clip': v, 'effect': 'lumetri', 'param': 'exposure', 'value': ev})
        if au:
            ex('essentialSound.setType', {'clips': au, 'type': 'dialogue'})
            for k in ('repair.noise.on', 'repair.rumble.on'): ex('essentialSound.set', {'clips': au, 'key': k, 'value': True})
            if s.get('mute'): ex('essentialSound.set', {'clips': au, 'key': 'mute', 'value': True})
        out.append({'seg': i, 'video': v, 'audio': au, 'start': t, 'end': t + dur, 'luma': y})
        t += dur
    ex('mixer.addInsert', {'strip': 'A1', 'effect': 'highpass'}); ex('mixer.setInsert', {'strip': 'A1', 'slot': 0, 'params': {'cutoff': 120}})
    ex('mixer.addInsert', {'strip': 'Mix', 'effect': 'hard_limiter'}); ex('mixer.setInsert', {'strip': 'Mix', 'slot': 0, 'params': {'max': -1.5}})
    ex('file.save', {})
    draft = export(os.path.join(d, f'{name} - ร่าง.mp4'), scale=0.5)
    print(json.dumps({'project': proj, 'sequence': seq, 'frames': t, 'seconds': round(t / 30, 2), 'clips': out, 'draft': draft}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1])
