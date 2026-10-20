import sys
ICONS = {
 # energy bolt + down arrow (long-term electricity savings)
 "bolt": '<path d="M130 20 L60 130 H112 L96 220 L176 100 H122 Z" fill="P" stroke="none"/>',
 # price tag
 "tag": '<path d="M30 40 V110 L130 210 L210 130 L110 30 H40 Z" fill="none" stroke="P" stroke-width="16" stroke-linejoin="round"/><circle cx="78" cy="78" r="16" fill="P"/>',
 # speaker + 1 soft wave
 "quiet": '<path d="M30 90 H70 L120 45 V195 L70 150 H30 Z" fill="P"/><path d="M150 95 Q175 120 150 145" fill="none" stroke="P" stroke-width="14" stroke-linecap="round"/>',
 # speaker + 3 waves
 "loud": '<path d="M20 90 H60 L110 45 V195 L60 150 H20 Z" fill="P"/><path d="M140 95 Q165 120 140 145" fill="none" stroke="P" stroke-width="14" stroke-linecap="round"/><path d="M165 70 Q205 120 165 170" fill="none" stroke="P" stroke-width="14" stroke-linecap="round"/><path d="M190 45 Q245 120 190 195" fill="none" stroke="P" stroke-width="14" stroke-linecap="round"/>',
 # moon + stars (all day / all night)
 "moon": '<path d="M150 30 A95 95 0 1 0 215 160 A75 75 0 1 1 150 30 Z" fill="P"/><circle cx="190" cy="55" r="9" fill="P"/><circle cx="215" cy="95" r="6" fill="P"/>',
 # clock (3-4 hours)
 "clock": '<circle cx="120" cy="120" r="95" fill="none" stroke="P" stroke-width="16"/><path d="M120 60 V120 L165 145" fill="none" stroke="P" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>',
 # chip (high tech specialist)
 "chip": '<rect x="60" y="60" width="120" height="120" rx="14" fill="none" stroke="P" stroke-width="16"/><rect x="95" y="95" width="50" height="50" rx="6" fill="P"/>' + "".join(f'<path d="M{x} 20 V60 M{x} 180 V220 M20 {x} H60 M180 {x} H220" stroke="P" stroke-width="12" stroke-linecap="round"/>' for x in (90,120,150)),
 # wrench (easy service)
 "wrench": '<path d="M150 30 A55 55 0 0 0 98 103 L30 171 A22 22 0 0 0 69 210 L137 142 A55 55 0 0 0 210 90 L178 122 L135 105 L118 62 Z" fill="P"/>',
 # rotor (compressor graphic): ring + 3 blades
 "rotor": '<circle cx="120" cy="120" r="108" fill="none" stroke="P" stroke-width="10"/>' + "".join(f'<path d="M120 120 C100 80 110 40 120 22 C150 40 150 90 120 120 Z" fill="P" transform="rotate({a} 120 120)"/>' for a in (0,120,240)) + '<circle cx="120" cy="120" r="18" fill="P"/>',
}
SILVER = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F0F4F8"/><stop offset=".5" stop-color="#B8C8D8"/><stop offset="1" stop-color="#E8EDF2"/></linearGradient></defs>'
for name, body in ICONS.items():
    for variant, paint, defs in (("white", "#FFFFFF", ""), ("silver", "url(#g)", SILVER)):
        painted = body.replace('="P"', '="%s"' % paint)
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 240 240">' + defs + painted + '</svg>'
        open(f"{name}_{variant}.svg", "w").write(svg)
