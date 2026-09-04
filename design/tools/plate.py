"""
Render "Reach Cartography" — Plate I.

Writes plate.html with the fonts embedded, for tools/render.mjs to rasterise
and tools/verify.mjs to check.

The composition went through three passes, and what each one removed is worth
recording because the removals are the design:

  1. The first drew the right marks and placed them badly — the outer envelope
     ran off the right edge, and eight long leader lines crossed the title and
     each other on their way to a label column.
  2. The second brought every radius inside the margin and deleted the leaders
     entirely: each observation is annotated where it sits, which is what a
     plate of this kind would actually do. It also replaced the empty field
     with what the philosophy asks for — patient accumulation of small marks,
     whose DENSITY carries the obligation of each stratum. The innermost band
     is sparse because it is meant to be almost empty; the working band is
     dense because that is where the instruments live.
  3. The third made that field visible (it had been drawn too faint to exist),
     set the threshold annotation horizontally so it could be read, and added
     the encoding key — a plate that encodes two variables and explains
     neither is decoration.

The margin and overlap constraints are asserted here and then measured again
in the browser by verify.mjs, because arithmetic about type is not the same as
type.

The data is real: eight device classes and the 44-point threshold, measured
against the listing app in this repository by `npm run check:devices`.
"""

import base64
import math
import pathlib

FONTS = pathlib.Path(
    '/root/.claude/skills/synced/'
    'd55cb59c-4bf8-48ad-8cf9-bdc2c0eae7c9_1744a000-7619-4024-bbc2-86a1c2e81f8f/'
    'canvas-design/canvas-fonts'
)


def face(name, filename, weight='400'):
    """Embed a font as base64, so the plate renders identically anywhere."""
    data = base64.b64encode((FONTS / filename).read_bytes()).decode()
    return (f"@font-face{{font-family:'{name}';font-weight:{weight};"
            f"src:url(data:font/ttf;base64,{data}) format('truetype');}}")


# ------------------------------------------------------------------ geometry
W, H = 1600, 2263
M = 96                      # nothing crosses this
PX, PY = 252, 2040          # the pivot — where the thumb's joint sits

GROUND = '#0B0B0C'
BONE   = '#E8E3D8'          # never pure white: white is a claim, bone an observation
BONE_D = '#7A756C'
BONE_F = '#3A3631'
BONE_X = '#4C443B'          # the accumulated field
ACCENT = '#EC4899'          # spent exactly three times

# radius, name, obligation, degrees between marks, points between rings
STRATA = [
    (348,  'NEAR',    'reserved',   4.0, 42),
    (684,  'NATURAL', 'working',    1.5, 22),
    (1016, 'FAR',     'ceremonial', 3.0, 30),
]
DRIFT = 1240                # beyond obligation
A0, A1 = 4.0, 90.0          # the swept sector, in degrees

assert PX + DRIFT <= W - M, 'the outer envelope would be clipped'
assert PX - 44 - 96 >= M, 'the stratum labels would break the left margin'
assert PY - DRIFT >= 700, 'the envelope would collide with the title block'


def pt(r, deg):
    a = math.radians(deg)
    return PX + r * math.cos(a), PY - r * math.sin(a)


def arc(r, a0=A0, a1=A1):
    x0, y0 = pt(r, a0)
    x1, y1 = pt(r, a1)
    return f'M {x0:.2f} {y0:.2f} A {r} {r} 0 0 0 {x1:.2f} {y1:.2f}'


DEVICES = [
    ('iPhone SE',        375,  667),
    ('iPhone 15',        393,  852),
    ('Pixel 8',          412,  915),
    ('iPhone 15 land',   852,  393),
    ('iPad mini',        744,  1133),
    ('iPad Pro 11',      834,  1194),
    ('iPad Pro 11 land', 1194, 834),
    ('iPad Pro 12.9',    1366, 1024),
]
diags = [math.hypot(w, h) for _, w, h in DEVICES]
dmin, dmax = min(diags), max(diags)
asps = [w / h for _, w, h in DEVICES]
amin, amax = min(asps), max(asps)


def place(w, h):
    """Radius from diagonal extent, angle from proportion."""
    d = (math.hypot(w, h) - dmin) / (dmax - dmin)
    a = (w / h - amin) / (amax - amin)
    return 424 + d * (984 - 424), 82.0 - a * (82.0 - 14.0)


out = []
add = out.append

# --------------------------------------------------------- the marked field
# Density is the message: how heavily a band is marked says what may live in it.
add(f'<g fill="{BONE_X}">')
inner = 96
for r_outer, _, _, dstep, rstep in STRATA:
    r = inner + rstep / 2
    while r < r_outer:
        deg = A0
        while deg <= A1:
            x, y = pt(r, deg)
            add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="0.86"/>')
            deg += dstep
        r += rstep
    inner = r_outer
# Beyond obligation: barely marked at all.
r = DRIFT - 46
while r > STRATA[-1][0]:
    deg = A0
    while deg <= A1:
        x, y = pt(r, deg)
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="0.66"/>')
        deg += 6.0
    r -= 46
add('</g>')

# ------------------------------------------------------------- the envelopes
add(f'<path d="{arc(DRIFT)}" fill="none" stroke="{BONE_F}" stroke-width="0.7"/>')
for r, *_ in STRATA:
    add(f'<path d="{arc(r)}" fill="none" stroke="{BONE_D}" stroke-width="1.05"/>')
    # Registration every fifteenth degree: the boundary is recorded, not blurred.
    for k in range(0, int((A1 - A0) / 15) + 1):
        deg = A0 + k * 15
        x0, y0 = pt(r - 11, deg)
        x1, y1 = pt(r + 11, deg)
        add(f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
            f'stroke="{BONE_D}" stroke-width="0.7"/>')

# ACCENT 1 of 3 — the 44-point threshold. Below it, nothing can be touched.
THR = 424 - 100
add(f'<path d="{arc(THR)}" fill="none" stroke="{ACCENT}" stroke-width="1.1" '
    f'stroke-dasharray="1.5 5.5" opacity="0.9"/>')
hx, hy = pt(THR, 30)
add(f'<line x1="{hx:.1f}" y1="{hy:.1f}" x2="{hx + 54:.1f}" y2="{hy:.1f}" '
    f'stroke="{ACCENT}" stroke-width="0.6" opacity="0.5"/>')
add(f'<text x="{hx + 62:.1f}" y="{hy - 3:.1f}" class="thr">44 pt</text>')
add(f'<text x="{hx + 62:.1f}" y="{hy + 13:.1f}" class="thrd">threshold of touch</text>')

# ACCENT 2 of 3 — the pivot. Every measurement on the plate begins here.
add(f'<circle cx="{PX}" cy="{PY}" r="26" fill="none" stroke="{BONE_F}" stroke-width="0.6"/>')
add(f'<circle cx="{PX}" cy="{PY}" r="13" fill="none" stroke="{ACCENT}" '
    f'stroke-width="0.7" opacity="0.55"/>')
add(f'<circle cx="{PX}" cy="{PY}" r="4" fill="{ACCENT}"/>')
add(f'<text x="{PX + 40}" y="{PY + 5}" class="pivot">pivot</text>')

# ------------------------------------------------------------ observations
# Annotated where they sit. Placement is solved, then asserted, because a plate
# with two labels on top of each other is not a plate.
LH, LW = 30, 236
placed = []
for name, w, h in DEVICES:
    r, deg = place(w, h)
    x, y = pt(r, deg)
    placed.append({'name': name, 'w': w, 'h': h, 'x': x, 'y': y,
                   'lx': x + 15, 'ly': y - 4, 'flip': False})

# Anything that would run past the right margin is annotated leftward instead.
for p in placed:
    if p['lx'] + LW > W - M:
        p['flip'] = True
        p['lx'] = p['x'] - 15


def collides(a, b):
    ax0 = a['lx'] - (LW if a['flip'] else 0)
    bx0 = b['lx'] - (LW if b['flip'] else 0)
    return abs(a['ly'] - b['ly']) < LH and abs(ax0 - bx0) < LW


for _ in range(80):
    moved = False
    for i in range(len(placed)):
        for j in range(i + 1, len(placed)):
            if collides(placed[i], placed[j]):
                lo, hi = sorted((placed[i], placed[j]), key=lambda p: p['ly'])
                lo['ly'] -= 3
                hi['ly'] += 3
                moved = True
    if not moved:
        break
assert not any(collides(placed[i], placed[j])
               for i in range(len(placed)) for j in range(i + 1, len(placed))), \
    'observation labels overlap'

for p in placed:
    add(f'<circle cx="{p["x"]:.1f}" cy="{p["y"]:.1f}" r="2.8" fill="{BONE}"/>')
    add(f'<circle cx="{p["x"]:.1f}" cy="{p["y"]:.1f}" r="8.5" fill="none" '
        f'stroke="{BONE_D}" stroke-width="0.6"/>')
    # A stub, not a leader: it ties the label to its mark without crossing the field.
    sx = p['x'] + (-8.5 if p['flip'] else 8.5)
    add(f'<line x1="{sx:.1f}" y1="{p["y"]:.1f}" x2="{p["lx"]:.1f}" y2="{p["y"]:.1f}" '
        f'stroke="{BONE_F}" stroke-width="0.6"/>')
    anchor = 'end' if p['flip'] else 'start'
    add(f'<text x="{p["lx"]:.1f}" y="{p["ly"]:.1f}" class="obs" '
        f'text-anchor="{anchor}">{p["name"]}</text>')
    add(f'<text x="{p["lx"]:.1f}" y="{p["ly"] + 15:.1f}" class="num" '
        f'text-anchor="{anchor}">{p["w"]}×{p["h"]}</text>')

# Stratum names, set upright on the axis where the field is quietest.
for r, name, obligation, _, _ in STRATA:
    add(f'<line x1="{PX - 34}" y1="{PY - r}" x2="{PX + 34}" y2="{PY - r}" '
        f'stroke="{BONE_D}" stroke-width="0.8"/>')
    add(f'<text x="{PX - 44}" y="{PY - r - 7}" class="strat" text-anchor="end">{name}</text>')
    add(f'<text x="{PX - 44}" y="{PY - r + 9}" class="stratd" text-anchor="end">{obligation}</text>')
add(f'<text x="{PX - 44}" y="{PY - DRIFT + 4}" class="stratd" text-anchor="end">beyond</text>')

# -------------------------------------------------------------- typography
add(f'<text x="{M}" y="{M + 14}" class="eyebrow">Reach Cartography</text>')
add(f'<text x="{M}" y="{M + 40}" class="eyebrow dim2">Plate I  ·  the swept envelope</text>')
add(f'<line x1="{M}" y1="{M + 62}" x2="{W - M}" y2="{M + 62}" stroke="{BONE_F}" stroke-width="0.8"/>')

# Italiana at 120px measures a 141px box, so the two lines are set 148 apart —
# clearing outright rather than by the 7px the earlier setting left.
add(f'<text x="{M}" y="{M + 196}" class="title">The territory</text>')
add(f'<text x="{M}" y="{M + 344}" class="title">of the hand</text>')
# ACCENT 3 of 3 — the last of the budget.
add(f'<rect x="{M}" y="{M + 396}" width="58" height="2.5" fill="{ACCENT}"/>')

for i, line in enumerate([
    'It is not rectangular. It is an arc — and the arc has',
    'never once matched the shape of the surfaces',
    'we ask it to govern.',
]):
    add(f'<text x="{M}" y="{M + 440 + i * 26}" class="lede">{line}</text>')

# The key, set in the clear space above the sweep where nothing else goes.
KX, KY = 986, 596
add(f'<line x1="{KX}" y1="{KY - 26}" x2="{W - M}" y2="{KY - 26}" stroke="{BONE_F}" stroke-width="0.8"/>')
add(f'<text x="{KX}" y="{KY}" class="fkey">Encoding</text>')
for i, (k, v) in enumerate([
    ('RADIUS',  'diagonal extent, in points'),
    ('ANGLE',   'proportion — upright to prone'),
    ('DENSITY', 'obligation of the stratum'),
]):
    add(f'<text x="{KX}" y="{KY + 34 + i * 30}" class="keyk">{k}</text>')
    add(f'<text x="{KX + 104}" y="{KY + 34 + i * 30}" class="keyv">{v}</text>')

fy = H - M - 52
add(f'<line x1="{M}" y1="{fy - 34}" x2="{W - M}" y2="{fy - 34}" stroke="{BONE_F}" stroke-width="0.8"/>')
cols = [('THRESHOLD', '44 pt'), ('CLASSES', '08'), ('OVERFLOW', '0 px'),
        ('ENVELOPES', '03'), ('SECTOR', '86°'), ('PIVOT', f'{PX} · {PY}')]
cw = (W - 2 * M) / len(cols)
for i, (k, v) in enumerate(cols):
    x = M + i * cw
    add(f'<text x="{x:.0f}" y="{fy}" class="fkey">{k}</text>')
    add(f'<text x="{x:.0f}" y="{fy + 30}" class="fval">{v}</text>')

css_fonts = ''.join([
    face('Italiana', 'Italiana-Regular.ttf'),
    face('Jura', 'Jura-Light.ttf', '300'),
    face('Jura', 'Jura-Medium.ttf', '500'),
    face('Geist', 'GeistMono-Regular.ttf'),
])

html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
{css_fonts}
*{{margin:0;padding:0}}
html,body{{background:{GROUND};width:{W}px;height:{H}px;overflow:hidden}}
svg{{display:block}}
.eyebrow{{font-family:Jura;font-weight:500;font-size:15px;letter-spacing:.34em;
  text-transform:uppercase;fill:{BONE}}}
.dim2{{fill:{BONE_D};letter-spacing:.26em;font-size:12.5px}}
.title{{font-family:Italiana;font-size:120px;fill:{BONE}}}
.lede{{font-family:Jura;font-weight:300;font-size:19px;fill:{BONE_D};letter-spacing:.045em}}
.obs{{font-family:Jura;font-weight:500;font-size:12px;letter-spacing:.19em;
  text-transform:uppercase;fill:{BONE}}}
.num{{font-family:Geist;font-size:11px;fill:{BONE_D};letter-spacing:.07em}}
.strat{{font-family:Jura;font-weight:500;font-size:12px;letter-spacing:.3em;
  text-transform:uppercase;fill:{BONE}}}
.stratd{{font-family:Jura;font-weight:300;font-size:10.5px;letter-spacing:.22em;
  text-transform:uppercase;fill:{BONE_F}}}
.thr{{font-family:Jura;font-weight:500;font-size:11px;letter-spacing:.26em;
  text-transform:uppercase;fill:{ACCENT};opacity:.85}}
.thrd{{font-family:Jura;font-weight:300;font-size:10px;letter-spacing:.22em;
  text-transform:uppercase;fill:{BONE_D}}}
.keyk{{font-family:Jura;font-weight:500;font-size:10.5px;letter-spacing:.26em;
  text-transform:uppercase;fill:{BONE}}}
.keyv{{font-family:Jura;font-weight:300;font-size:12px;letter-spacing:.05em;fill:{BONE_D}}}
.pivot{{font-family:Jura;font-weight:300;font-size:10.5px;letter-spacing:.3em;
  text-transform:uppercase;fill:{BONE_F}}}
.fkey{{font-family:Jura;font-weight:500;font-size:10.5px;letter-spacing:.3em;
  text-transform:uppercase;fill:{BONE_F}}}
.fval{{font-family:Geist;font-size:20px;fill:{BONE};letter-spacing:.02em}}
</style></head><body>
<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">
<rect width="{W}" height="{H}" fill="{GROUND}"/>
{chr(10).join(out)}
</svg></body></html>"""

pathlib.Path(__file__).parent.joinpath('plate.html').write_text(html)
print(f'wrote plate.html — {len(out)} marks')
