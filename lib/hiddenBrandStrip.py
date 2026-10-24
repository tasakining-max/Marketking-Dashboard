#!/usr/bin/env python3
"""Removes another brand's name from the text layer of a PDF WITHOUT changing
how the page looks.

In some catalogs the other maker's name is still in the page's text, covered by
a small box labelled "Tasaki". Re-typesetting that text breaks the page, so this
edits the content stream directly: the glyphs of the brand word are dropped from
the TJ/Tj string and replaced by a pen move of exactly their width, so every
following glyph stays where it was.

usage: hiddenBrandStrip.py in.pdf out.pdf "<regex of brand words>"
prints JSON {"removed": {"<page>": count}, "skippedFonts": [...]}
"""
import json
import re
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, ContentStream, FloatObject, NameObject, NumberObject

src, dst, pattern = sys.argv[1:4]
rx = re.compile(pattern, re.I)
reader = PdfReader(src)
writer = PdfWriter(clone_from=reader)
removed = {}
skipped = set()


def font_widths(resources, name):
    fonts = resources.get('/Font') if resources else None
    if not fonts or name not in fonts:
        return None
    f = fonts[name].get_object()
    if f.get('/Subtype') == '/Type0' or '/Widths' not in f:
        return None
    first = int(f.get('/FirstChar', 0))
    widths = [float(w) for w in f['/Widths']]
    return lambda code: widths[code - first] if 0 <= code - first < len(widths) else float(f.get('/FontDescriptor', {}).get('/MissingWidth', 0))


def strip_array(items, width_of):
    """items: TJ array elements (bytes / numbers). Returns (new_items, count)."""
    chars = []  # (byte, item_index, pos)
    for i, it in enumerate(items):
        if isinstance(it, (ByteStringObject, bytes)) or hasattr(it, 'original_bytes'):
            b = it.original_bytes if hasattr(it, 'original_bytes') else bytes(it)
            for p, c in enumerate(b):
                chars.append((c, i, p))
    text = ''.join(chr(c) for c, _, _ in chars)
    hits = [(m.start(), m.end()) for m in rx.finditer(text)]
    if not hits:
        return items, 0
    kill = set()
    for s, e in hits:
        kill.update(range(s, e))
    out = []
    pending = 0.0
    k = 0
    for i, it in enumerate(items):
        if hasattr(it, 'original_bytes') or isinstance(it, (ByteStringObject, bytes)):
            b = it.original_bytes if hasattr(it, 'original_bytes') else bytes(it)
            keep = bytearray()
            for c in b:
                if k in kill:
                    pending += width_of(c)
                    if keep:
                        out.append(ByteStringObject(bytes(keep)))
                        keep = bytearray()
                else:
                    if pending:
                        out.append(FloatObject(-pending))
                        pending = 0.0
                    keep.append(c)
                k += 1
            if keep:
                out.append(ByteStringObject(bytes(keep)))
        else:
            out.append(it)
    if pending:
        out.append(FloatObject(-pending))
    return out, len(hits)


def process(container, resources, key):
    """container: page or form XObject; rewrites its content stream."""
    try:
        cs = ContentStream(container.get_contents() if hasattr(container, 'get_contents') else container, reader)
    except Exception:
        return 0
    font = None
    width_of = None
    total = 0
    for idx, (operands, op) in enumerate(cs.operations):
        if op == b'Tf':
            font = operands[0]
            width_of = font_widths(resources, font)
            if width_of is None:
                skipped.add(str(font))
        elif op == b'TJ' and width_of:
            new, n = strip_array(list(operands[0]), width_of)
            if n:
                cs.operations[idx] = ([ArrayObject(new)], b'TJ')
                total += n
        elif op == b'Tj' and width_of:
            new, n = strip_array([operands[0]], width_of)
            if n:
                cs.operations[idx] = ([ArrayObject(new)], b'TJ')
                total += n
        elif op == b'Do':
            xo = (resources.get('/XObject') or {}).get(operands[0]) if resources else None
            if xo is not None:
                xo = xo.get_object()
                if xo.get('/Subtype') == '/Form':
                    total += process_form(xo)
    if total:
        if hasattr(container, 'replace_contents'):
            container.replace_contents(cs)
        else:
            container.set_data(cs.get_data())
    return total


def process_form(xo):
    from pypdf.generic import StreamObject
    res = xo.get('/Resources')
    res = res.get_object() if res else None
    try:
        cs = ContentStream(xo, reader)
    except Exception:
        return 0
    font = None
    width_of = None
    total = 0
    for idx, (operands, op) in enumerate(cs.operations):
        if op == b'Tf':
            font = operands[0]
            width_of = font_widths(res, font)
        elif op in (b'TJ', b'Tj') and width_of:
            arr = list(operands[0]) if op == b'TJ' else [operands[0]]
            new, n = strip_array(arr, width_of)
            if n:
                cs.operations[idx] = ([ArrayObject(new)], b'TJ')
                total += n
    if total:
        xo.set_data(cs.get_data())
    return total


for pno, page in enumerate(writer.pages, start=1):
    res = page.get('/Resources')
    res = res.get_object() if res else None
    n = process(page, res, None)
    if n:
        removed[str(pno)] = n

writer.write(dst)
print(json.dumps({'removed': removed, 'skippedFonts': sorted(skipped)}))
