#!/usr/bin/env python3
"""Extracteur DXF-AAMA openpattern → JSON par pièce×taille.
Layer 1 = coupe (marge incluse), 14 = COUTURE (net, ce que TOILE consomme),
2 = crans (POINT), 7 = droit-fil (LINE). Coordonnées DXF en mm."""
import re, sys, json, math

def parse_pairs(lines):
    return [(lines[i], lines[i+1]) for i in range(0, len(lines) - 1, 2)]

def rdp(pts, eps):
    if len(pts) < 3: return pts
    def d(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx-ax, by-ay
        L2 = dx*dx + dy*dy
        if L2 == 0: return math.hypot(px-ax, py-ay)
        t = max(0, min(1, ((px-ax)*dx + (py-ay)*dy) / L2))
        return math.hypot(px-(ax+t*dx), py-(ay+t*dy))
    dmax, idx = 0, 0
    for i in range(1, len(pts)-1):
        dd = d(pts[i], pts[0], pts[-1])
        if dd > dmax: dmax, idx = dd, i
    if dmax > eps:
        left = rdp(pts[:idx+1], eps); right = rdp(pts[idx:], eps)
        return left[:-1] + right
    return [pts[0], pts[-1]]

def extract(path):
    src = open(path, encoding='utf-8', errors='replace').read().replace('\r','')
    lines = [l.strip() for l in src.split('\n')]
    out = {}
    i = 0
    while i < len(lines)-1:
        if lines[i] == '0' and lines[i+1] == 'BLOCK':
            j = i
            while lines[j] != 'ENDBLK': j += 1
            seg = lines[i:j]
            name = None
            for k in range(len(seg)-1):
                if seg[k] == '2': name = seg[k+1]; break
            polys, notches, texts = [], [], []
            k = 0
            while k < len(seg)-1:
                if seg[k] == '0' and seg[k+1] == 'POLYLINE':
                    layer, verts = None, []
                    m = k+2
                    while m < len(seg)-1:
                        if seg[m] == '8' and layer is None: layer = seg[m+1]
                        if seg[m] == '0' and seg[m+1] == 'VERTEX':
                            x = y = None
                            v = m+2
                            while v < len(seg)-1 and seg[v] != '0':
                                if seg[v] == '10': x = float(seg[v+1])
                                if seg[v] == '20': y = float(seg[v+1])
                                v += 2
                            verts.append((x, y)); m = v; continue
                        if seg[m] == '0' and seg[m+1] == 'SEQEND': break
                        m += 2
                    polys.append((layer, verts)); k = m
                elif seg[k] == '0' and seg[k+1] == 'POINT':
                    layer = x = y = None
                    m = k+2
                    while m < len(seg)-1 and seg[m] != '0':
                        if seg[m] == '8': layer = seg[m+1]
                        if seg[m] == '10': x = float(seg[m+1])
                        if seg[m] == '20': y = float(seg[m+1])
                        m += 2
                    if layer == '2': notches.append((x, y))
                    k = m
                elif seg[k] == '0' and seg[k+1] == 'TEXT':
                    m = k+2
                    while m < len(seg)-1 and seg[m] != '0':
                        if seg[m] == '1': texts.append(seg[m+1])
                        m += 2
                    k = m
                else: k += 1
            # la couture (14) sinon la coupe (1) — la plus grande polyline du layer
            sew = max((v for l, v in polys if l == '14'), key=len, default=None)
            cut = max((v for l, v in polys if l == '1'), key=len, default=None)
            contour = sew or cut
            if name and contour and len(contour) > 3:
                simplified = rdp(contour, 1.5)  # 1,5 mm
                out[name] = {
                    'texts': texts,
                    'contour_mm': [[round(x,2), round(y,2)] for x, y in simplified],
                    'notches_mm': [[round(x,2), round(y,2)] for x, y in notches],
                    'nRaw': len(contour), 'nSimplified': len(simplified),
                    'source': 'sew(14)' if sew else 'cut(1)',
                }
            i = j
        else: i += 1
    return out

if __name__ == '__main__':
    data = extract(sys.argv[1])
    json.dump(data, open(sys.argv[2], 'w'), indent=1)
    for name, d in sorted(data.items()):
        w = max(p[0] for p in d['contour_mm']) - min(p[0] for p in d['contour_mm'])
        h = max(p[1] for p in d['contour_mm']) - min(p[1] for p in d['contour_mm'])
        print(f"{name:20s} {d['source']:8s} {d['nRaw']:4d}→{d['nSimplified']:3d} pts  {w/10:.1f}×{h/10:.1f} cm  {len(d['notches_mm'])} crans")
