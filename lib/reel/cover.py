"""แพ็ค: make the reel cover in her approved style (MD Service / BTU covers).
usage: python3 lib/reel/cover.py cover.json
cover.json = {"video": "<source clip or final mp4>", "time": 4.3, "rot": -90|90|0,
  "brighten": true, "small": "ผลงานทาซากิ ที่โรงเรียน", "big": "เย็นสบาย",
  "sub": "มากเลยค่ะ!", "out": "<project dir>/<reel name> - ปก"}
Layout: white Tasaki logo top centre (y≈160), small cyan line, big blue-gradient
word with white stroke + blue glow, white sub line; navy fade behind the text
only (top ~36 %), so faces and the product below stay clear. Pick a frame
with real faces/product and nothing covering them; text stays above y≈600.
Writes <out>.png and <out>.jpg."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def esc(s): return str(s).replace('&', '&amp;').replace('<', '&lt;')


def main(spec):
    c = json.load(open(spec)); out = os.path.expanduser(c['out'])
    d = tempfile.mkdtemp()
    turn = {90: 'transpose=1,', -90: 'transpose=2,'}.get(c.get('rot', 0), '')
    eq = ',eq=brightness=0.06:gamma=1.15' if c.get('brighten', True) else ''
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(c['time']), '-i', os.path.expanduser(c['video']), '-frames:v', '1', '-vf', f'{turn}scale=1080:1920{eq}', f'{d}/bg.png'], check=True)
    logo = os.path.join(HERE, 'logo_white.png')
    t = lambda y, s, txt, fill, stroke, sw, f='sh': (f'<g filter="url(#{f})"><text x="540" y="{y}" font-size="{s}" text-anchor="middle" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" paint-order="stroke">{esc(txt)}</text></g>')
    html = f'''<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;width:1080px;height:1920px;overflow:hidden;font-family:"Frutiger Neue LT Pro";font-weight:700}}svg{{position:absolute;left:0;top:0}}</style></head><body><svg width="1080" height="1920" viewBox="0 0 1080 1920"><defs>
<linearGradient id="blue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2BA8DE"/><stop offset=".55" stop-color="#0074A2"/><stop offset="1" stop-color="#004E75"/></linearGradient>
<linearGradient id="dim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#001222" stop-opacity=".85"/><stop offset=".22" stop-color="#001222" stop-opacity=".5"/><stop offset=".36" stop-color="#001222" stop-opacity="0"/></linearGradient>
<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#001222" flood-opacity=".55"/></filter>
<filter id="tg" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur in="SourceAlpha" stdDeviation="18" result="b"/><feFlood flood-color="#2BA8DE" flood-opacity=".9"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs><image href="bg.png" x="0" y="0" width="1080" height="1920"/><rect width="1080" height="1920" fill="url(#dim)"/>
<image href="{logo}" x="445" y="160" width="190" height="50"/>
{t(300, 50, c.get('small', ''), '#8FE3FF', '#001222', 9) if c.get('small') else ''}
{t(490, c.get('bigSize', 160), c['big'], 'url(#blue)', '#FFFFFF', 18, 'tg')}
{t(580, 76, c.get('sub', ''), '#FFFFFF', '#001222', 13) if c.get('sub') else ''}
</svg></body></html>'''
    open(f'{d}/cover.html', 'w').write(html)
    subprocess.run([CH, '--headless', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--window-size=1080,1920', f'--screenshot={out}.png', f'file://{d}/cover.html'], capture_output=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{out}.png', '-q:v', '2', f'{out}.jpg'], check=True)
    print(f'{out}.png\n{out}.jpg')


if __name__ == '__main__':
    main(sys.argv[1])
