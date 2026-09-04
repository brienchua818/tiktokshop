# Reach Cartography

A design philosophy, and Plate I expressing it.

- `Reach Cartography — Design Philosophy.md` — the movement
- `Reach Cartography — Plate I.png` — 3200 × 4526, 2× of a 1600 × 2263 field
- `Reach Cartography — Plate I.pdf` — the same, vector

## Rebuilding it

```
python3 tools/plate.py      # writes plate.html, fonts embedded as base64
node   tools/render.mjs     # → PNG at 2× and PDF
node   tools/verify.mjs     # asserts nothing spills and no text overlaps
```

`verify.mjs` is not decoration. It measures every drawn element in the browser
against the 96px margin and checks all 52 text elements pairwise for overlap —
which caught six stratum labels breaking the left margin and the two title
lines' boxes touching by 7px. Neither was visible at a glance, and both are
the kind of flaw that only shows up once something is printed.

## What the plate plots

The data is real. Eight device classes, their actual dimensions, and the
44-point threshold below which a control cannot reliably be touched — measured
against the TikTok listing app in this repository by `npm run check:devices`.

- **radius** — diagonal extent
- **angle** — proportion, upright through prone
- **density of the field** — the obligation each stratum carries: the innermost
  band is sparsely marked because it is meant to stay almost empty; the working
  band is dense because that is where the instruments live

Colour is spent exactly three times: the threshold arc, the pivot, and the rule
under the title.
