"""แพ็ค: put a finished reel on its dashboard card.
usage: python3 lib/reel/card.py card.json
card.json = {"title": ..., "video": "<mp4>", "cover": "<jpg>", "caption": ...,
             "todos": [["ตัดต่อ", "done"], ["รอพี่ดาตรวจ", "plan"], …], "create": true}
Finds the card by exact title (or creates it in the Clip column when "create"),
then uploads the video, the cover and sets caption + todos. Existing todos with
the same text keep their id; their status is updated."""
import json, sys, base64, uuid, subprocess, urllib.request, urllib.parse

API = 'http://localhost:5050'


def req(method, path, body=None):
    r = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


def main(spec):
    c = json.load(open(spec))
    cards = req('GET', '/api/cards'); cards = cards if isinstance(cards, list) else cards.get('cards', cards)
    card = next((x for x in cards if x['title'].strip() == c['title'].strip()), None)
    if not card:
        if not c.get('create'): raise SystemExit(f'no card titled {c["title"]}')
        card = req('POST', '/api/cards', {'title': c['title'], 'column': 'clip'})
    cid = card['id']
    old = {t['text']: t for t in (card.get('todos') or [])}
    todos = [{'id': old.get(t, {}).get('id') or str(uuid.uuid4()), 'text': t, 'status': s} for t, s in c.get('todos', [])]
    todos += [t for k, t in old.items() if k not in {x['text'] for x in todos}]
    req('PATCH', f'/api/cards/{cid}', {'caption': c.get('caption', ''), 'todos': todos})
    if c.get('cover'):
        img = 'data:image/jpeg;base64,' + base64.b64encode(open(c['cover'], 'rb').read()).decode()
        req('POST', f'/api/cards/{cid}/image', {'image': img})
    if c.get('video'):
        r = subprocess.run(['curl', '-s', '-F', f'video=@{c["video"]};type=video/mp4', f'{API}/api/cards/{cid}/video'], capture_output=True, text=True)
        if '"videoUrl"' not in r.stdout: raise SystemExit(f'video upload failed: {r.stdout[:200]}')
    print(json.dumps({'card': cid, 'title': c['title']}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1])
