"""แพ็ค: put the finished reel on its dashboard card ("ใส่การ์ด").
usage: python3 lib/reel/card.py card.json
card.json = {"title": "...", "id": "<card id>"?, "video": ".../<reel>.mp4", "cover": ".../<reel> - ปก.jpg",
             "caption": "...", "todos": [["ตัดต่อ","done"], ["รอพี่ดาตรวจ","plan"], ...],
             "shootDate": "2026-09-16"?, "create": false}
Finds the card by id, else by exact title; creates it in the Clip column only
when "create" is true (she decides when cards get made). Uploads the video
(POST /video), the cover (POST /image as a data URL) and PATCHes caption/todos."""
import base64, json, subprocess, sys, urllib.request, uuid

API = 'http://localhost:5050'


def call(method, path, body=None):
    r = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(), method=method, headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


def main(spec):
    c = json.load(open(spec))
    cards = call('GET', '/api/cards'); cards = cards if isinstance(cards, list) else cards.get('cards', [])
    card = next((x for x in cards if x['id'] == c.get('id')), None) or next((x for x in cards if x['title'].strip() == c['title'].strip()), None)
    if not card:
        if not c.get('create'): raise SystemExit(f'ไม่พบการ์ด "{c["title"]}" (ใส่ "create": true ถ้าหนิงสั่งให้สร้าง)')
        card = call('POST', '/api/cards', {'title': c['title'], 'column': 'clip', 'shootDate': c.get('shootDate'), 'description': c.get('description', '')})
    cid = card['id']
    if c.get('video'):
        r = subprocess.run(['curl', '-s', '-F', f'video=@{c["video"]};type=video/mp4', f'{API}/api/cards/{cid}/video'], capture_output=True, text=True)
        if 'error' in json.loads(r.stdout or '{}'): raise SystemExit(r.stdout)
    if c.get('cover'):
        call('POST', f'/api/cards/{cid}/image', {'image': 'data:image/jpeg;base64,' + base64.b64encode(open(c['cover'], 'rb').read()).decode()})
    patch = {}
    if c.get('caption'): patch['caption'] = c['caption']
    if c.get('shootDate'): patch['shootDate'] = c['shootDate']
    if c.get('todos') is not None:
        old = {t['text']: t for t in card.get('todos') or []}
        patch['todos'] = [{'id': old.get(t, {}).get('id') or str(uuid.uuid4()), 'text': t, 'status': s} for t, s in c['todos']]
    if patch: call('PATCH', f'/api/cards/{cid}', patch)
    print(json.dumps({'card': cid, 'title': card['title']}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1])
