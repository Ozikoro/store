# Branding, and how it was verified

Every mark the store serves comes from the official Ozikoro logo library at
`~/Projects/Ozikoro-assets/Logofiles 5`. This records the evidence, because
"we used the logo" is a claim that should be checkable.

## How it was checked

A file can differ from another in three different ways, and only one of them
matters:

- **bytes** — differ for any re-export, re-compression or metadata change
- **geometry** — the actual drawing, which is what a person recognises
- **dimensions** — how much detail a raster carries

So the SVG marks were compared by **path geometry**, not by file hash: every
`d` attribute is extracted in document order and hashed together. A matching
geometry hash means the drawing is the official one, whatever the fill colour or
the file around it.

## The marks

| Served as | Derived from | How it differs | Verified |
|---|---|---|---|
| `public/brand/ozikoro-icon-yellow.svg` | `Ozi Ikoro Icon - Yellow.svg` | **Nothing.** Byte for byte identical. | geometry `585e5243ddcd` (9 paths) |
| `public/brand/ozikoro-mark.svg` | `Ozi Ikoro Icon - Yellow.svg` | Fill `#ddb02f` → `currentColor`, plus `role="img"` and `aria-label`. | same geometry |
| `public/brand/ozikoro-square.svg` | `Ozi Ikoro Icon - Yellow.svg` | Same drawing, square crop. | same geometry |
| `public/favicon.svg` | `Ozi Ikoro Icon - Yellow.svg` | Same drawing, sized for a browser tab. | same geometry |
| `public/apple-touch-icon.png` | the icon | Raster for iOS. | served 200 |
| `public/brand/ozikoro-icon-yellow-149.png` | `Ozi Ikoro Icon - Yellow.png` | **Nothing.** Byte for byte identical, 2140×1133. | sha `fc8da0c745487249` |
| `public/brand/ozikoro-icon-yellow.png` | the same PNG | Resized to 1000×529 — a smaller copy for places that do not need 2140px. | same image, half the bytes |
| `public/brand/ozikoro-horizontal.png` | the horizontal lockup | Raster lockup for Open Graph. | served 200 |
| `public/brand/ozikoro-logo-v1.jpg`, `-v2.webp` | the full logo | Full lockups, kept for social and press. | in the repo |

**One drawing, nine presentations.** That is why the marks stay consistent: there
is a single source of geometry, and every variant is that drawing re-dressed.

## Deployment

The four files the browser actually requests were fetched from
`https://shop.ozikoro.com` and hashed against the local copies:

```
/favicon.svg                 DEPLOYED, byte-identical
/brand/ozikoro-mark.svg      DEPLOYED, byte-identical
/brand/ozikoro-square.svg    DEPLOYED, byte-identical
/apple-touch-icon.png        DEPLOYED, byte-identical
```

## To re-check

```sh
python3 - <<'PY'
import re, pathlib, hashlib
def paths(p): return re.findall(r'\bd="([^"]+)"', pathlib.Path(p).read_text(errors='replace'))
def h(p):     return hashlib.sha256('|'.join(paths(p)).encode()).hexdigest()[:12]
official = pathlib.Path.home() / 'Projects/Ozikoro-assets/Logofiles 5/Ozi Ikoro Icon - Yellow.svg'
for f in sorted(pathlib.Path('public').rglob('*.svg')):
    print(h(f), f, 'matches' if h(f) == h(official) else 'DIFFERS')
PY
```
