#!/usr/bin/env python3
"""Finds / removes another brand's name from the parts of a PDF that are not page text:
document info, XMP metadata, the editor's private data (old file paths), colour
names such as a "Midea Blue" swatch, bookmarks, link addresses and form names.
The name is swapped for Tasaki (same capitalisation); page drawing is untouched.

usage: metaBrandScrub.py scan  in.pdf  "<regex>"            -> JSON {"hits": [{"where": ..., "count": n}]}
       metaBrandScrub.py scrub in.pdf out.pdf "<regex>"     -> JSON {"replaced": n, "hits_after": [...]}
"""
import json
import re
import signal
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, DictionaryObject, NameObject, StreamObject, TextStringObject

# Never hang a caller: a huge file gets whatever was scanned in 40 s.
class Deadline(Exception):
    pass


def _alarm(*_):
    raise Deadline()


signal.signal(signal.SIGALRM, _alarm)
signal.alarm(40)
mode = sys.argv[1]
src = sys.argv[2]
dst = sys.argv[3] if mode == 'scrub' else None
# File names glue words with underscores ("PD_Midea_Chiller"), which \b treats as
# one word: use letter boundaries instead.
pat = sys.argv[-1].replace('\\b(', '(?<![A-Za-z])(').replace(')\\b', ')(?![A-Za-z])')
rx = re.compile(pat, re.I)


def swap(m):
    w = m.group(0)
    return 'TASAKI' if w.isupper() else 'Tasaki'


def bswap(m):
    return swap(re.match(r'.*', m.group(0).decode('latin1'))) .encode('latin1') if False else (b'TASAKI' if m.group(0).isupper() else b'Tasaki')


brx = re.compile(rx.pattern.encode(), re.I)


def label(obj, oid):
    if isinstance(obj, StreamObject):
        t = str(obj.get('/Type', ''))
        if t == '/Metadata':
            return 'XMP metadata'
        if t == '/ObjStm':
            return 'object stream'
        return 'embedded data (editor private data / file paths)'
    return 'document object'


def walk_fix(o, seen, counter):
    """Rename names / strings inside containers, in place."""
    if id(o) in seen:
        return
    seen.add(id(o))
    if isinstance(o, DictionaryObject):
        for k in list(o.keys()):
            v = o[k]
            vv = v.get_object() if hasattr(v, 'get_object') else v
            if isinstance(vv, NameObject) and rx.search(str(vv).replace('#20', ' ')):
                o[NameObject(k)] = NameObject(rx.sub(swap, str(vv).replace('#20', ' ')).replace(' ', '#20')) if False else NameObject(re.sub(rx, swap, str(vv).replace('#20', ' ')).replace(' ', '#20'))
                counter[0] += 1
            elif isinstance(vv, (TextStringObject,)) and rx.search(str(vv)):
                o[NameObject(k)] = TextStringObject(rx.sub(swap, str(vv)))
                counter[0] += 1
            elif isinstance(vv, (DictionaryObject, ArrayObject)) or isinstance(vv, StreamObject):
                if k not in ('/Parent', '/P', '/Prev', '/Next', '/First', '/Last'):
                    walk_fix(vv, seen, counter)
    elif isinstance(o, ArrayObject):
        for i in range(len(o)):
            vv = o[i].get_object() if hasattr(o[i], 'get_object') else o[i]
            if isinstance(vv, NameObject) and rx.search(str(vv).replace('#20', ' ')):
                o[i] = NameObject(re.sub(rx, swap, str(vv).replace('#20', ' ')).replace(' ', '#20'))
                counter[0] += 1
            elif isinstance(vv, TextStringObject) and rx.search(str(vv)):
                o[i] = TextStringObject(rx.sub(swap, str(vv)))
                counter[0] += 1
            elif isinstance(vv, (DictionaryObject, ArrayObject)):
                walk_fix(vv, seen, counter)


def scan(reader):
    hits = {}
    # Only ids the file really defines: asking pypdf for a missing id makes it
    # search the whole file each time (minutes on a 17 MB catalog).
    ids = {i for gen in reader.xref.values() for i in gen} | set(reader.xref_objStm)
    for oid in sorted(ids):
        try:
            o = reader.get_object(oid)
        except Exception:
            continue
        if o is None:
            continue
        if isinstance(o, StreamObject):
            sub = str(o.get('/Subtype', ''))
            if sub == '/Image' or sub == '/Form' or str(o.get('/Type', '')) == '/XObject':
                continue
            try:
                if int(o.get('/Length', 0)) > 3_000_000:
                    continue
            except Exception:
                pass
            try:
                data = o.get_data()
            except Exception:
                continue
            # page content streams are checked by the text scan
            n = len(brx.findall(data))
            if n and str(o.get('/Type', '')) != '/XObject' and sub != '/Form' and b' Tf' not in data[:4000]:
                hits[label(o, oid)] = hits.get(label(o, oid), 0) + n
        else:
            n = len(rx.findall(str(o).replace('#20', ' ')))
            if n and not isinstance(o, (int, float)):
                hits[label(o, oid)] = hits.get(label(o, oid), 0) + n
    info = reader.metadata or {}
    n = sum(len(rx.findall(str(v))) for v in info.values())
    if n:
        hits['document info'] = n
    return [{'where': k, 'count': v} for k, v in hits.items()]


reader = PdfReader(src)
if mode == 'scan':
    try:
        hits = scan(reader)
    except Deadline:
        hits = []
    print(json.dumps({'hits': hits}))
    sys.exit(0)

writer = PdfWriter(clone_from=reader)
counter = [0]
seen = set()
walk_fix(writer._root_object, seen, counter)
if writer._info is not None:
    walk_fix(writer._info.get_object() if hasattr(writer._info, 'get_object') else writer._info, seen, counter)
# every non-image stream (XMP, editor private data, object streams' contents are rebuilt by pypdf)
for oid in range(1, len(writer._objects) + 1):
    try:
        o = writer.get_object(oid)
    except Exception:
        continue
    if isinstance(o, StreamObject) and str(o.get('/Subtype', '')) != '/Image':
        try:
            data = o.get_data()
        except Exception:
            continue
        if brx.search(data) and b' Tf' not in data[:4000] and str(o.get('/Subtype', '')) != '/Form':
            o.set_data(brx.sub(bswap, data))
            counter[0] += len(brx.findall(data))
    elif isinstance(o, (DictionaryObject, ArrayObject)):
        walk_fix(o, seen, counter)
writer.write(dst)
print(json.dumps({'replaced': counter[0], 'hits_after': scan(PdfReader(dst))}))
