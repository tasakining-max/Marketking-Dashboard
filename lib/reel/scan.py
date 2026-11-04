"""ฟุต step 1: look at every video in a shoot folder.
usage: uv run --with mlx-whisper --with opencv-python python lib/reel/scan.py <shoot folder> [clip names…]
(clip names = only scan those, e.g. MVI_8898 MVI_8899; others already in footage.json are kept)
Writes ~/Movies/FilmCraft/<folder name>/_scan/: one Whisper JSON per clip
(word timestamps), a contact sheet per clip (already turned upright),
footage.json (file, seconds, rotation, faces, transcript) and footage.txt
(the same as readable lines). Clips already scanned are skipped."""
import json, os, subprocess, sys
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO = ('.mp4', '.mov', '.m4v', '.mts')


def videos(root):
    for d, _, fs in os.walk(root):
        if '/_scan' in d or '/.' in d: continue
        for f in sorted(fs):
            if f.lower().endswith(VIDEO) and not f.startswith('._'):
                yield os.path.join(d, f)


def probe(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', p], capture_output=True, text=True)
    j = json.loads(r.stdout); s = j['streams'][0]
    return float(j['format']['duration']), s['width'], s['height']


def frame(p, t):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', p, '-frames:v', '1', '-vf', 'scale=960:-2', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    import numpy as np
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None


def orientation(p, dur, w, h):
    """Canon clips are often shot sideways: count faces at 0/90/-90 and keep the best."""
    det = cv2.FaceDetectorYN.create(os.path.join(HERE, 'yunet.onnx'), '', (320, 320), 0.6)
    score = {0: 0, 90: 0, -90: 0}
    for t in (dur * 0.25, dur * 0.5, dur * 0.75):
        im = frame(p, t)
        if im is None: continue
        for rot, code in ((0, None), (90, cv2.ROTATE_90_CLOCKWISE), (-90, cv2.ROTATE_90_COUNTERCLOCKWISE)):
            x = im if code is None else cv2.rotate(im, code)
            det.setInputSize((x.shape[1], x.shape[0])); _, f = det.detect(x)
            score[rot] += 0 if f is None else len(f)
    best = max(score, key=score.get)
    if score[best] == 0: best = 0 if w < h else None   # no people: decide by eye from the sheet
    return best, score[best]


def main(root, only=()):
    root = os.path.abspath(root.rstrip('/'))
    out = os.path.join(os.path.expanduser('~/Movies/FilmCraft'), os.path.basename(root), '_scan')
    os.makedirs(out, exist_ok=True)
    import mlx_whisper
    fj = os.path.join(out, 'footage.json')
    rows = [r for r in (json.load(open(fj)) if only and os.path.exists(fj) else []) if r['name'] not in only]
    for p in videos(root):
        name = os.path.splitext(os.path.basename(p))[0]
        if only and name not in only: continue
        js = os.path.join(out, name + '.json')
        dur, w, h = probe(p)
        if not os.path.exists(js):
            r = mlx_whisper.transcribe(p, path_or_hf_repo='mlx-community/whisper-large-v3-turbo', language='th', word_timestamps=True)
            rot, faces = orientation(p, dur, w, h)
            json.dump({'file': p, 'duration': dur, 'size': [w, h], 'rotation': rot, 'faces': faces, 'segments': r['segments']}, open(js, 'w'), ensure_ascii=False)
            turn = {90: 'transpose=1,', -90: 'transpose=2,'}.get(rot, '')
            step = max(1.0, dur / 10)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', p, '-vf', f'fps=1/{step:.2f},{turn}scale=180:-2,tile=10x1', '-frames:v', '1', os.path.join(out, name + '.jpg')])
        j = json.load(open(js))
        segs = [(round(s['start'], 2), round(s['end'], 2), s['text'].strip()) for s in j['segments'] if s['text'].strip()]
        rows.append({'name': name, 'file': p, 'duration': round(dur, 2), 'rotation': j['rotation'], 'faces': j['faces'], 'segments': segs})
        print(name, round(dur, 1), 's', 'rot', j['rotation'], flush=True)
    rows.sort(key=lambda r: r['name'])
    json.dump(rows, open(fj, 'w'), ensure_ascii=False, indent=1)
    with open(os.path.join(out, 'footage.txt'), 'w') as f:
        for r in rows:
            f.write(f"{r['name']} {r['duration']}s rot={r['rotation']} faces={r['faces']}\n")
            for a, b, t in r['segments']: f.write(f'  [{a}-{b}] {t}\n')
    print(out)


if __name__ == '__main__':
    main(sys.argv[1], tuple(sys.argv[2:]))
