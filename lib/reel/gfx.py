"""คัต step 2: render keyword graphics as 1080x1920 transparent PNGs.
usage: python3 lib/reel/gfx.py gfx.json
gfx.json = {"dir": "<project dir>/gfx", "items": [ {"name": "a1", "kind": "...", ...}, … ]}
Kinds (each keyword TYPE has its own look — never one style for everything):
  check    {text, x, y, size?}            cyan check circle + outlined white word (list items)
  claim    {text, y, size?}               white word on the Tasaki blade shape (key claim)
  place    {lines:[..], x, y, size?}      map pin + white text (1–2 lines) + cyan underline
  province {text, y, size?}               cyan-gradient word inside corner brackets
  cool     {text, x, y, size?}            snowflake + big cyan-gradient word with glow
  number   {text, unit?, y, size?}        silver metallic digits + small cyan unit
  quote    {text, x, y, size?, cyan?}     plain outlined white (or cyan) line, e.g. "ไม่ใช่แค่วัด"
x/y are the text baseline start (left-anchored) or centre for centred kinds.
Keep everything inside x 54–880 and y 384–1440 (safe zone) and ≥60 px above heads."""
import json, os, subprocess, sys, math

CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
H = '''<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1920px;background:transparent;overflow:hidden;font-family:"Frutiger Neue LT Pro";font-weight:700}svg{position:absolute;left:0;top:0}</style></head><body><svg width="1080" height="1920" viewBox="0 0 1080 1920"><defs>
<linearGradient id="blue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2BA8DE"/><stop offset=".55" stop-color="#0074A2"/><stop offset="1" stop-color="#004E75"/></linearGradient>
<linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".45" stop-color="#E8EDF2"/><stop offset=".55" stop-color="#B8C8D8"/><stop offset="1" stop-color="#F0F4F8"/></linearGradient>
<linearGradient id="cyan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#8FE3FF"/></linearGradient>
<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#001222" flood-opacity=".55"/></filter>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="14" result="b"/><feFlood flood-color="#8FE3FF" flood-opacity=".8"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>'''
E = '</svg></body></html>'
BLADE = 'M128 30 C300 40 540 170 645 305 C668 335 660 350 635 352 C420 375 210 450 55 585 C40 598 28 592 29 572 C30 400 70 160 108 48 C113 34 120 30 128 30 Z'


def esc(s): return str(s).replace('&', '&amp;').replace('<', '&lt;')


def T(x, y, t, fs, fill, stroke='#001222', sw=14, anchor='middle'):
    return (f'<text x="{x}" y="{y}" font-size="{fs}" text-anchor="{anchor}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{sw}" stroke-linejoin="round" paint-order="stroke">{esc(t)}</text>')


def pin(x, y):
    return (f'<g transform="translate({x},{y})" filter="url(#sh)"><path d="M0 -60 C33 -60 58 -35 58 -2 C58 38 0 90 0 90 '
            f'C0 90 -58 38 -58 -2 C-58 -35 -33 -60 0 -60 Z" fill="url(#blue)" stroke="#fff" stroke-width="7"/><circle cx="0" cy="-4" r="20" fill="#fff"/></g>')


def snow(x, y, r):
    s = ''.join(f'<line x1="{x}" y1="{y}" x2="{x + r * math.cos(a * math.pi / 3):.1f}" y2="{y + r * math.sin(a * math.pi / 3):.1f}"/>' for a in range(6))
    return f'<g stroke="#FFFFFF" stroke-width="{max(3, r / 7):.1f}" stroke-linecap="round" filter="url(#glow)">{s}</g>'


def svg(i):
    k = i['kind']; s = i.get('size')
    if k == 'check':
        x, y, s = i['x'], i['y'], s or 104
        return (f'<g filter="url(#sh)"><circle cx="{x + 20}" cy="{y - s * .34:.0f}" r="{s * .38:.0f}" fill="#8FE3FF" stroke="#fff" stroke-width="6"/>'
                f'<path d="M{x + 2} {y - s * .34:.0f} l12 14 l24 -28" fill="none" stroke="#001222" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>'
                f'{T(x + s * .38 + 40, y, i["text"], s, "url(#cyan)", anchor="start")}</g>')
    if k == 'claim':
        y, s = i['y'], s or 74
        return (f'<g filter="url(#sh)"><g transform="translate(150,{y - 190}) scale(1.15,0.55)"><path d="{BLADE}" fill="url(#blue)" stroke="#FFFFFF" stroke-width="10"/></g>'
                f'{T(528, y, i["text"], s, "#FFFFFF", sw=0)}</g>')
    if k == 'place':
        x, y, s = i['x'], i['y'], s or 54
        lines = i['lines']; tx = x + 75
        t = ''.join(T(tx, y + n * (s + 18), l, s, '#FFFFFF', anchor='start') for n, l in enumerate(lines))
        uy = y + (len(lines) - 1) * (s + 18) + 22
        return f'<g filter="url(#sh)">{t}<rect x="{tx}" y="{uy}" width="{min(880 - tx, max(len(l) for l in lines) * s * .52):.0f}" height="10" rx="5" fill="#8FE3FF"/></g>' + pin(x, y - s * .2 + (len(lines) - 1) * (s + 18) / 2)
    if k == 'province':
        y, s = i['y'], s or 92
        return (f'<g filter="url(#sh)"><path d="M300 {y - 90} v-26 h36 M780 {y - 90} v-26 h-36 M300 {y + 20} v26 h36 M780 {y + 20} v26 h-36" '
                f'fill="none" stroke="#8FE3FF" stroke-width="8" stroke-linecap="round"/>{T(540, y, i["text"], s, "url(#cyan)")}</g>')
    if k == 'cool':
        x, y, s = i['x'], i['y'], s or 120
        return f'<g filter="url(#glow)">{snow(x - 60, y - s * .29, s * .37)}{T(x, y, i["text"], s, "url(#cyan)", anchor="start")}</g>'
    if k == 'number':
        y, s = i['y'], s or 150
        u = i.get('unit', '')
        return f'<g filter="url(#glow)">{T(560 if u else 540, y, i["text"], s, "url(#silver)", sw=12, anchor="end" if u else "middle")}{T(585, y, u, s * .47, "#8FE3FF", sw=10, anchor="start") if u else ""}</g>'
    if k == 'quote':
        x, y, s = i['x'], i['y'], s or 76
        return f'<g filter="url(#sh)">{T(x, y, i["text"], s, "url(#cyan)" if i.get("cyan") else "#FFFFFF", anchor="start")}</g>'
    raise ValueError(k)


def render(items, d):
    os.makedirs(d, exist_ok=True); outs = []
    for i in items:
        html = os.path.join(d, i['name'] + '.html'); png = os.path.join(d, i['name'] + '.png')
        open(html, 'w').write(H + i.get('raw', '') + (svg(i) if 'kind' in i else '') + E)
        subprocess.run([CH, '--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=1080,1920', f'--screenshot={png}', 'file://' + html], capture_output=True)
        os.remove(html); outs.append(png)
    return outs


if __name__ == '__main__':
    c = json.load(open(sys.argv[1]))
    print('\n'.join(render(c['items'], os.path.expanduser(c['dir']))))
