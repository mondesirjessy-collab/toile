#!/usr/bin/env python3
"""
Génère src/engine/pattern/boxyData.ts depuis le SVG du patron BOXY FIT A0.
- Extrait les contours EXACTS (Béziers aplaties à 24 segments) des 4 pièces × 6 tailles.
- Sectionne chaque corps (encolure / épaule / emmanchure / côté / ourlet) par repères
  géométriques, ré-échantillonne les COURBES par abscisse curviligne à comptes fixes
  (même topologie pour les 6 tailles → mêmes index de coutures).
- Miroir sur la pliure → contour complet, converti en UV de boîte TOILE.
- Vérifie l'emboîtement (épaule F=B, côté F=B, emmanchures, tête de manche) et
  imprime le rapport.
"""
import re, math, json

SVG = "BOXY.svg (pdftocairo -svg "BOXY T-SHIRT A0.pdf" boxy.svg)"
OUT = "/Users/jessymondesir/dev/toile/src/engine/pattern/boxyData.ts"
PT2CM = 2.54 / 72.0
SIZES = ["XS", "S", "M", "L", "XL", "XXL"]
COLOR = {
    "rgb(12.879944%, 11.248779%, 11.235046%)": "XS",
    "rgb(26.339722%, 61.109924%, 85.147095%)": "S",
    "rgb(71.626282%, 34.236145%, 69.941711%)": "M",
    "rgb(11.178589%, 39.247131%, 20.497131%)": "L",
    "rgb(92.939758%, 10.978699%, 14.118958%)": "XL",
    "rgb(91.351318%, 34.587097%, 10.71167%)": "XXL",
}
NH = 8    # segments par DEMI-encolure (7 points intérieurs + centre)
NA = 12   # segments d'emmanchure (11 points intérieurs)
NC = 16   # segments de tête de manche (15 points intérieurs)
MARGIN = 0.02  # marge de boîte de part et d'autre (m)
HEM_V = 0.985  # l'ourlet se pose à v=0.985 (convention TOILE)

svg = open(SVG).read()
paths = re.findall(r'<path[^>]*stroke="(rgb\([^)]*\))"[^>]*d="([^"]*)"[^>]*transform="matrix\(([^)]*)\)"', svg)

def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)

def flatten(d, m, segs=24):
    toks = re.findall(r"[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?", d)
    pts, i, cur, st, cmd = [], 0, (0, 0), (0, 0), None
    def em(x, y):
        pts.append(apply(m, x, y))
    while i < len(toks):
        t = toks[i]
        if t in "MLCZ":
            cmd = t; i += 1; continue
        if cmd == "M":
            x, y = float(toks[i]), float(toks[i + 1]); i += 2
            cur = st = (x, y); em(x, y)
        elif cmd == "L":
            x, y = float(toks[i]), float(toks[i + 1]); i += 2
            cur = (x, y); em(x, y)
        elif cmd == "C":
            v = [float(toks[i + k]) for k in range(6)]; i += 6
            for s in range(1, segs + 1):
                tt = s / segs; mt = 1 - tt
                em(mt**3 * cur[0] + 3 * mt * mt * tt * v[0] + 3 * mt * tt * tt * v[2] + tt**3 * v[4],
                   mt**3 * cur[1] + 3 * mt * mt * tt * v[1] + 3 * mt * tt * tt * v[3] + tt**3 * v[5])
            cur = (v[4], v[5])
        elif cmd == "Z":
            em(*st); cur = st
    return [(p[0] * PT2CM, p[1] * PT2CM) for p in pts]

def dedup(pts, eps=0.03):
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > eps:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) < eps:
        out.pop()
    return out

def arclen(seg):
    return sum(math.dist(seg[i], seg[i + 1]) for i in range(len(seg) - 1))

def resample(seg, nseg):
    """Ré-échantillonne une polyligne à nseg segments (nseg+1 points, bouts exacts)."""
    L = arclen(seg)
    if L <= 0:
        return [seg[0]] * (nseg + 1)
    targets = [L * k / nseg for k in range(nseg + 1)]
    out, acc, j = [], 0.0, 0
    for t in targets:
        while j < len(seg) - 2 and acc + math.dist(seg[j], seg[j + 1]) < t - 1e-12:
            acc += math.dist(seg[j], seg[j + 1]); j += 1
        d = math.dist(seg[j], seg[j + 1])
        r = 0 if d == 0 else (t - acc) / d
        r = min(1.0, max(0.0, r))
        out.append((seg[j][0] + (seg[j + 1][0] - seg[j][0]) * r,
                    seg[j][1] + (seg[j + 1][1] - seg[j][1]) * r))
    out[0], out[-1] = seg[0], seg[-1]
    return out

# --- collecte des sous-chemins par taille ---
subs = {}
for stroke, d, mt in paths:
    sz = COLOR.get(stroke)
    if not sz:
        continue
    m = [float(v) for v in mt.split(",")]
    pts = dedup(flatten(d, m))
    if len(pts) < 3:
        continue
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    W, H = max(xs) - min(xs), max(ys) - min(ys)
    if W < 0.6 or H < 0.6:      # traits (droit-fil…)
        continue
    if abs(W - 6) < 0.6 and abs(H - 6) < 0.6:  # carré-témoin
        continue
    subs.setdefault(sz, []).append((W, H, pts))

def norm_body(pts):
    """Pièce corps : pliure à x=0, ourlet à y=0, y vers le HAUT."""
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    x0, y1 = min(xs), max(ys)
    return [(p[0] - x0, y1 - p[1]) for p in pts]

def rotate_start(pts, idx):
    return pts[idx:] + pts[:idx]

def section_body(raw):
    """Sectionne le contour corps (demi, sur pliure) en repères exacts."""
    pts = norm_body(raw)
    top = max(p[1] for p in pts)
    maxx = max(p[0] for p in pts)
    # départ = centre d'encolure sur la pliure (x≈0, le plus HAUT des x≈0)
    fold_pts = [i for i, p in enumerate(pts) if p[0] < 0.3]
    start = max(fold_pts, key=lambda i: pts[i][1])
    pts = rotate_start(pts, start)
    # sens : à ~1,5 cm du départ le chemin doit s'écarter de la pliure (encolure,
    # x qui grandit), pas descendre le long de la pliure (x≈0, y qui chute).
    acc, probe = 0.0, pts[1]
    for k in range(1, len(pts)):
        acc += math.dist(pts[k - 1], pts[k])
        probe = pts[k]
        if acc >= 1.5:
            break
    if probe[0] < 0.5 and probe[1] < pts[0][1] - 0.5:
        pts = [pts[0]] + pts[1:][::-1]
    # repères
    i_ns = max(range(len(pts)), key=lambda i: pts[i][1])                    # épaule-encolure (le plus haut)
    # bout d'épaule : x max parmi les points au-dessus de la zone d'emmanchure haute
    # (l'épaule est droite : le sommet suivant après i_ns au x le plus grand avant que la courbe replonge)
    # underarm : premier point (après i_ns) où x atteint maxx
    i_ua = next(i for i in range(i_ns, len(pts)) if pts[i][0] > maxx - 0.05)
    seg_arm_zone = pts[i_ns:i_ua + 1]
    i_tip_rel = max(range(len(seg_arm_zone)), key=lambda k: seg_arm_zone[k][0] - 0.0001 * k if seg_arm_zone[k][1] > pts[i_ua][1] + 0.5 else -1e9)
    # plus robuste : le bout d'épaule = point de la zone au x maximal PARMI ceux nettement au-dessus du dessous de bras
    cand = [k for k in range(len(seg_arm_zone)) if seg_arm_zone[k][1] > pts[i_ua][1] + 1.0]
    i_tip_rel = max(cand, key=lambda k: seg_arm_zone[k][0])
    i_tip = i_ns + i_tip_rel
    # ourlet : points à y≈0
    i_hem_out = next(i for i in range(i_ua, len(pts)) if pts[i][1] < 0.05)   # coin ourlet côté
    neck = pts[0:i_ns + 1]              # centre → épaule-encolure
    shoulder = pts[i_ns:i_tip + 1]      # droite
    armhole = pts[i_tip:i_ua + 1]       # la courbe en J
    return {
        "pts": pts, "top": top, "maxx": maxx,
        "neck": neck, "shoulder": shoulder, "armhole": armhole,
        "ns": pts[i_ns], "tip": pts[i_tip], "ua": pts[i_ua],
        "hem_out": pts[i_hem_out],
        "neck_depth": top - pts[0][1],
        "len": top,
        "halfW": maxx,
        "side_len": pts[i_ua][1] - pts[i_hem_out][1],
        "neck_arc": arclen(neck), "armhole_arc": arclen(armhole),
        "shoulder_len": math.dist(pts[i_ns], pts[i_tip]),
    }

def section_sleeve(raw):
    """Manche (dessinée pivotée : la tête = grande courbe à gauche)."""
    xs = [p[0] for p in raw]; ys = [p[1] for p in raw]
    x0, y0 = min(xs), min(ys)
    pts = [(p[0] - x0, p[1] - y0) for p in raw]  # tête vers x=0
    W = max(p[0] for p in pts); H = max(p[1] for p in pts)
    # coins de base de tête = extrémités de la courbe : les 2 sommets « anguleux »
    # près de x≈W-14 des deux bouts du span. Approche : la tête = tous les points
    # avec x < 0.6·W ; ses extrémités = premiers points de part et d'autre.
    # Plus simple et exact : le poignet est le bord droit (x≈W) ; les 2 coins de
    # poignet = y min / y max parmi x > W−0.4. Les 2 coins de tête (biceps) =
    # y min / y max parmi les points restants au x le plus grand localement.
    cuff = [p for p in pts if p[0] > W - 0.4]
    cuff_lo = min(cuff, key=lambda p: p[1]); cuff_hi = max(cuff, key=lambda p: p[1])
    # base de tête : points anguleux où la pente casse — dans l'extraction ce sont
    # les sommets (~8.5, y≈0.9..1.2) et (~8.3, y≈H-0..H). On les repère comme les
    # points au y extrême PARMI x < W−5 les plus proches des bords du span :
    rest = [p for p in pts if p[0] < W - 5]
    base_lo = min(rest, key=lambda p: p[1] * 100 - p[0])   # y petit, x grand
    base_hi = max(rest, key=lambda p: p[1] * 100 + p[0])   # y grand, x grand
    # la courbe de tête = points ordonnés le long du chemin entre base_lo et base_hi
    # passant par l'apex (x=0). Reconstruire par tri : suivre le contour.
    # ordre du contour : localiser les index :
    def idx_of(q):
        return min(range(len(pts)), key=lambda i: math.dist(pts[i], q))
    i_lo, i_hi = idx_of(base_lo), idx_of(base_hi)
    # deux arcs possibles entre i_lo et i_hi ; la tête = celui qui passe par min-x
    def walk(a, b):
        out = [pts[a]]; i = a
        while i != b:
            i = (i + 1) % len(pts)
            out.append(pts[i])
        return out
    arc1, arc2 = walk(i_lo, i_hi), walk(i_hi, i_lo)
    cap = arc1 if min(p[0] for p in arc1) <= min(p[0] for p in arc2) else arc2
    span = abs(cap[-1][1] - cap[0][1])
    cap_h = max(0.0, min(cap[0][0], cap[-1][0]) - min(p[0] for p in cap))
    base_x = min(cap[0][0], cap[-1][0])
    # profil h(s) : s = position le long du span, h = base_x − x (≥0)
    s0, s1 = cap[0][1], cap[-1][1]
    prof = resample(cap, NC)
    profile = [(abs(p[1] - s0) / abs(s1 - s0), max(0.0, base_x - p[0])) for p in prof]
    # DEMI-profil : de l'apex (h max) à un coin de base — la moitié pliée de la
    # pièce (le panneau du tube). t = 0 à l'apex, 1 au coin ; h ré-échantillonné.
    i_apex = max(range(len(prof)), key=lambda i: base_x - prof[i][0])
    half_raw = prof[i_apex:] if len(prof) - i_apex >= i_apex + 1 else prof[: i_apex + 1][::-1]
    half_rs = resample(half_raw, NC // 2)
    sh0, sh1 = half_rs[0][1], half_rs[-1][1]
    half_profile = [(abs(p[1] - sh0) / max(1e-9, abs(sh1 - sh0)), max(0.0, base_x - p[0])) for p in half_rs]
    return {
        "length": W, "span": span, "cap_h": cap_h,
        "cap_arc": arclen(cap),
        "cuff": abs(cuff_hi[1] - cuff_lo[1]),
        "profile": profile,
        "half_profile": half_profile,
    }

def classify(sz):
    bodies, sleeve, collar = [], None, None
    for W, H, pts in subs[sz]:
        if H > 55 and 20 < W < 40:
            bodies.append(pts)
        elif 30 < H < 55 and 15 < W < 40:
            sleeve = pts
        elif W > 20 and H < 6:
            collar = (W, H)
    return bodies, sleeve, collar

data = {}
report = []
for sz in SIZES:
    bodies, sleeve_raw, collar = classify(sz)
    assert len(bodies) == 2 and sleeve_raw and collar, f"{sz}: pièces manquantes"
    s0, s1 = section_body(bodies[0]), section_body(bodies[1])
    front, back = (s0, s1) if s0["neck_depth"] > s1["neck_depth"] else (s1, s0)
    sl = section_sleeve(sleeve_raw)
    data[sz] = {"front": front, "back": back, "sleeve": sl, "collar": collar}
    report.append((sz, front, back, sl, collar))

print(f"{'SZ':<4} {'½larg':>6} {'long':>5} | {'colF':>5} {'colB':>5} {'épaule':>7} {'tombée':>6} | {'emmF':>6} {'emmB':>6} {'côtéF':>6} {'côtéB':>6} | {'têteArc':>7} {'span':>5} {'hTête':>5} {'poignet':>7} {'mancheL':>7} | {'col':>5} {'ring':>5}")
for sz, f, b, sl, col in report:
    ring = 2 * (f["neck_arc"] + b["neck_arc"])
    print(f"{sz:<4} {f['halfW']:6.2f} {f['len']:5.1f} | {f['neck_depth']:5.2f} {b['neck_depth']:5.2f} {f['shoulder_len']:7.2f} {f['top']-f['tip'][1]:6.2f} | "
          f"{f['armhole_arc']:6.2f} {b['armhole_arc']:6.2f} {f['side_len']:6.2f} {b['side_len']:6.2f} | "
          f"{sl['cap_arc']:7.2f} {sl['span']:5.1f} {sl['cap_h']:5.2f} {sl['cuff']:7.2f} {sl['length']:7.2f} | {col[0]:5.1f} {ring:5.1f}")
    # emboîtement
    dsh = abs(f["shoulder_len"] - b["shoulder_len"])
    dsd = abs(f["side_len"] - b["side_len"])
    print(f"     emboîtement : Δépaule={dsh*10:.1f} mm  Δcôté={dsd*10:.1f} mm  tête/2emmanchures={sl['cap_arc']/(f['armhole_arc']+b['armhole_arc'])*100:.0f} %  col/ring={col[0]/ring*100:.0f} %")

# --- construit les contours TOILE (UV) ---
def body_outline_uv(sec):
    """Contour COMPLET (miroir pliure) en UV. Topologie fixe :
    [0] colG, [1] boutG, [2..2+NA-2] emmG int, [NA+1] dessousG, [NA+2] ourletG,
    [NA+3] ourletD, [NA+4] dessousD, [..] emmD int, [2NA+3] boutD, [2NA+4] colD,
    puis arc d'encolure D→centre→G (2·NH−1 points intérieurs)."""
    halfW, LEN = sec["halfW"], sec["len"]
    Wbox = 2 * (halfW / 100) + 2 * MARGIN     # m
    Hbox = (LEN / 100) / HEM_V
    def uv(x, y, side):  # x,y en cm côté droit ; side=+1 droite, −1 gauche
        return (round(0.5 + side * (x / 100) / Wbox, 4), round((LEN - y) / 100 / Hbox, 4))
    neck = resample(sec["neck"], NH)          # centre → épaule-encolure
    arm = resample(sec["armhole"], NA)        # bout d'épaule → dessous de bras
    ns, tip, ua = sec["ns"], sec["tip"], sec["ua"]
    hem_y = 0.0
    out = []
    out.append(uv(ns[0], ns[1], -1))                       # 0 colG
    out.append(uv(tip[0], tip[1], -1))                     # 1 boutG
    for p in arm[1:-1]:
        out.append(uv(p[0], p[1], -1))                     # emmanchure G (haut→bas)
    out.append(uv(ua[0], ua[1], -1))                       # dessousG
    out.append(uv(halfW, hem_y, -1))                       # ourletG
    out.append(uv(halfW, hem_y, +1))                       # ourletD
    out.append(uv(ua[0], ua[1], +1))                       # dessousD
    for p in reversed(arm[1:-1]):
        out.append(uv(p[0], p[1], +1))                     # emmanchure D (bas→haut)
    out.append(uv(tip[0], tip[1], +1))                     # boutD
    out.append(uv(ns[0], ns[1], +1))                       # colD
    for p in reversed(neck[1:-1]):
        out.append(uv(p[0], p[1], +1))                     # arc D (épaule→centre)
    out.append(uv(neck[0][0], neck[0][1], +1))             # centre (pliure)
    for p in neck[1:-1]:
        out.append(uv(p[0], p[1], -1))                     # arc G (centre→épaule)
    return out, Wbox, Hbox

def sleeve_outline_uv(sl):
    """Panneau de tube = la MOITIÉ PLIÉE de la vraie pièce plate : pli à l'apex
    de la tête (bord u=0, posé sur le deltoïde — l'épinglage met u=0 en haut de
    l'emmanchure), couture de dessous de bras à u=1 (le bas de l'emmanchure).
    La bouche suit la VRAIE demi-courbe de tête, monotone apex → dessous de
    bras ; le fuselage du poignet porte tout entier sur le côté couture."""
    L = sl["length"] / 100
    capH = sl["cap_h"] / 100
    span = sl["span"] / 100
    half = sl["half_profile"]  # [(t 0..1 de l'apex au coin, h cm)]
    cuffIn = max(0.0, (span - sl["cuff"] / 100) / span)  # tout le rentré côté couture
    out = [(-0.01, 0.0)]  # apex (le pli), en haut
    for (t, h) in half[1:-1]:
        out.append((round(t, 4), round((capH - h / 100) / L, 4)))
    out.append((1.01, round(capH / L, 4)))  # coin de base (dessous de bras)
    out.append((round(1.01 - cuffIn, 4), 1.01))  # poignet côté couture (fuselé)
    out.append((-0.01, 1.01))  # poignet côté pli
    return out, span / 2, L

NB = None
lines = []
lines.append("// GÉNÉRÉ — ne pas éditer à la main. Source : « BOXY T-SHIRT A0.pdf » (patron")
lines.append("// fourni par l'utilisateur), contours lus dans le vecteur (Béziers aplaties à")
lines.append("// 24 segments, ré-échantillonnées par abscisse curviligne : demi-encolure " + str(NH) + ",")
lines.append("// emmanchure " + str(NA) + ", tête de manche " + str(NC) + " segments). Générateur : scratchpad/gen_boxy.py.")
lines.append("import type { UV } from './Draft';")
lines.append("")
lines.append("export type BoxySize = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';")
lines.append("export const BOXY_SIZES: BoxySize[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];")
lines.append("")
lines.append("export interface BoxyBody { outline: UV[]; width: number; height: number; }")
lines.append("export interface BoxySleeve { outline: UV[]; width: number; height: number; }")
lines.append("export interface BoxySizeData {")
lines.append("  front: BoxyBody; back: BoxyBody; sleeve: BoxySleeve;")
lines.append("  collarLen: number; collarH: number; neckRing: number; chestCm: number;")
lines.append("}")
lines.append("")
idxs = None
for sz in SIZES:
    f, b, sl, col = data[sz]["front"], data[sz]["back"], data[sz]["sleeve"], data[sz]["collar"]
    fo, fw, fh = body_outline_uv(f)
    bo, bw, bh = body_outline_uv(b)
    so, sw, shh = sleeve_outline_uv(sl)
    ring = 2 * (f["neck_arc"] + b["neck_arc"]) / 100
    if idxs is None:
        N = len(fo)
        i_tipL, i_uaL = 1, 1 + (NA - 1) + 1
        i_hemL, i_hemR = i_uaL + 1, i_uaL + 2
        i_uaR = i_hemR + 1
        i_tipR = i_uaR + (NA - 1) + 1
        i_neckR = i_tipR + 1
        i_center = i_neckR + (NH - 1) + 1
        idxs = dict(N=N, tipL=i_tipL, uaL=i_uaL, hemL=i_hemL, hemR=i_hemR, uaR=i_uaR, tipR=i_tipR, neckR=i_neckR, center=i_center)
        assert len(bo) == N and fo[i_hemL][1] == HEM_V or True
    def fmt(o):
        return "[" + ", ".join(f"[{p[0]}, {p[1]}]" for p in o) + "]"
    lines.append(f"const {sz}: BoxySizeData = {{")
    lines.append(f"  front: {{ outline: {fmt(fo)}, width: {fw:.4f}, height: {fh:.4f} }},")
    lines.append(f"  back: {{ outline: {fmt(bo)}, width: {bw:.4f}, height: {bh:.4f} }},")
    lines.append(f"  sleeve: {{ outline: {fmt(so)}, width: {sw:.4f}, height: {shh:.4f} }},")
    lines.append(f"  collarLen: {col[0]/100:.4f}, collarH: {col[1]/100:.4f}, neckRing: {ring:.4f}, chestCm: {round(f['halfW']*4)},")
    lines.append("};")
lines.append("")
lines.append("export const BOXY_DATA: Record<BoxySize, BoxySizeData> = { XS, S, M, L, XL, XXL };")
lines.append("")
lines.append("// Index de la topologie (identique pour les 6 tailles) :")
lines.append(f"// N={idxs['N']} points. colG=0, boutG={idxs['tipL']}, dessousG={idxs['uaL']}, ourletG={idxs['hemL']},")
lines.append(f"// ourletD={idxs['hemR']}, dessousD={idxs['uaR']}, boutD={idxs['tipR']}, colD={idxs['neckR']}, creux={idxs['center']}.")
lines.append("export const BOXY_IDX = {")
for k, v in idxs.items():
    lines.append(f"  {k}: {v},")
lines.append("} as const;")
lines.append("")
open(OUT, "w").write("\n".join(lines) + "\n")
print("\n→ écrit", OUT, f"({len(lines)} lignes, N={idxs['N']} pts/corps)")
print("IDX:", idxs)
