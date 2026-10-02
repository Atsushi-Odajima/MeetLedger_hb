#!/usr/bin/env python3
"""MeetLedger brand asset builder (single source of truth for logo geometry & colors).

Generates every SVG/PNG/ICO/ICNS in brand/ and copies the app-facing files into
apps/web/public, apps/web/src/assets and apps/desktop/build.

Fonts are NEVER stored in the repo. Download them to a temp dir and pass the paths:

  # Wordmark outlines (SIL OFL 1.1) - Inter 4.1 official release
  curl -L -o /tmp/inter.zip https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
  unzip -q /tmp/inter.zip -d /tmp/inter
  # Japanese text in og.png / brand-board.png (SIL OFL 1.1) - Noto Sans JP 2.004
  curl -L -o /tmp/notojp.zip https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip
  unzip -q /tmp/notojp.zip -d /tmp/notojp

  pip install --user fonttools uharfbuzz pillow
  python3 brand/scripts/build.py --inter-dir /tmp/inter --jp-dir /tmp/notojp

Requirements: python3 + fonttools + uharfbuzz + pillow, node + the repo's playwright-core
(root devDependency) with a Chromium (set CHROMIUM_PATH if Playwright's default is absent).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
PNG = BRAND / "png"

# --------------------------------------------------------------------------------------
# Color tokens (see docs/BRANDING.md for usage & contrast)
# --------------------------------------------------------------------------------------
C = {
    "ink": "#0B2A33",          # teal-900: text / wordmark "Meet"
    "teal-800": "#0B3A46",     # primary pressed
    "teal": "#0F4C5C",         # teal-700: PRIMARY (mark, primary button)
    "teal-50": "#EAF4F3",      # tint surface
    "green": "#1E9E82",        # green-500: ACCENT graphics on light (>=3:1)
    "green-700": "#147A64",    # accent text on light (>=4.5:1)
    "mint": "#5FD4BC",         # mint-300: accent on dark / on primary
    "indigo": "#3D4FA0",       # indigo-600: secondary (links, AI/search)
    "indigo-300": "#9AA8F0",   # secondary on dark
    "amber": "#E3A33B",        # due / warning graphic
    "amber-800": "#8A5A00",    # due / warning text on light
    "red": "#B42318",          # danger on light
    "red-300": "#F97066",      # danger on dark
    "gray-600": "#51646A",     # muted text on light
    "gray-400": "#7D9196",     # strong border (form controls, >=3:1)
    "gray-300": "#C2CFD2",     # hairline border (decorative)
    "gray-100": "#EEF3F4",     # subtle fill
    "paper": "#F6F9F9",        # app background (light)
    "white": "#FFFFFF",
    "night": "#0A161B",        # night-950: app background (dark)
    "night-900": "#102229",    # surface (dark)
    "night-800": "#1A3038",    # border (dark)
    "frost": "#EAF5F3",        # text on dark / mark on dark
    "frost-300": "#9DB3B8",    # muted text on dark
}

# --------------------------------------------------------------------------------------
# Mark geometry (64 x 64 grid). One continuous line: the speech bubble's tail turns into
# a check mark ("the conversation ends in a done commitment"); two ledger rows inside.
# --------------------------------------------------------------------------------------
BUBBLE = ("M44 44A12 12 0 0 0 56 32V22A12 12 0 0 0 44 10H20A12 12 0 0 0 8 22V32"
          "A12 12 0 0 0 20 44L27 53L44 28")
ROWS = "M19.5 21.5H33M19.5 30H25"
STROKE = 6.5          # bubble/check line weight on the 64 grid
ROW_STROKE = 4.5      # ledger rows are lighter than the container line

# 16 px optical variant (16 x 16 grid): ledger rows dropped, right side opened and the
# check drawn in mint so it still reads as "bubble -> check" at favicon size.
SMALL_BUBBLE = "M13 8V5A2 2 0 0 0 11 3H5A2 2 0 0 0 3 5V8.5A2 2 0 0 0 5 10.5"
SMALL_CHECK = "M5 10.5L7 13L12.25 6.75"

HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"{extra}>'


def mark_group(line: str, rows: str, stroke: float = STROKE, row_stroke: float = ROW_STROKE,
               transform: str | None = None) -> str:
    t = f' transform="{transform}"' if transform else ""
    return (f'<g{t} fill="none" stroke-linecap="round" stroke-linejoin="round">'
            f'<path class="ml-line" d="{BUBBLE}" stroke="{line}" stroke-width="{stroke}"/>'
            f'<path class="ml-rows" d="{ROWS}" stroke="{rows}" stroke-width="{row_stroke}"/></g>')


# "auto" variants for <img> use in the web app: light colors as presentation attributes,
# dark colors applied by the SVG's own prefers-color-scheme media query.
AUTO_STYLE = ("<style>@media (prefers-color-scheme: dark){"
              f".ml-line{{stroke:{C['frost']}}}.ml-rows{{stroke:{C['mint']}}}"
              f".ml-meet{{fill:{C['frost']}}}.ml-ledger{{fill:{C['mint']}}}}}</style>")


def svg_mark(line: str, rows: str, title: str, auto: bool = False) -> str:
    return (HEAD.format(vb="0 0 64 64", extra=' role="img" aria-labelledby="t"') +
            f'<title id="t">{title}</title>' + (AUTO_STYLE if auto else "") + mark_group(line, rows) + "</svg>\n")


def svg_tile(kind: str) -> str:
    """kind: 'any' (rounded tile, transparent corners), 'maskable' (full bleed, 80% safe zone),
    'touch' (full bleed for iOS), 'mac' (1024 macOS grid with shadow)."""
    if kind == "any":
        bg = f'<rect width="64" height="64" rx="14" fill="{C["teal"]}"/>'
        g = mark_group(C["white"], C["mint"], 7, 5, "translate(32 32) scale(.75) translate(-32 -31.75)")
        return HEAD.format(vb="0 0 64 64", extra="") + bg + g + "</svg>\n"
    if kind == "maskable":
        # mark half-diagonal ~37.2u * .6 = 22.3u < safe-zone radius 25.6u (40% of 64)
        bg = f'<rect width="64" height="64" fill="{C["teal"]}"/>'
        g = mark_group(C["white"], C["mint"], 7, 5, "translate(32 32) scale(.6) translate(-32 -31.75)")
        return HEAD.format(vb="0 0 64 64", extra="") + bg + g + "</svg>\n"
    if kind == "touch":
        bg = f'<rect width="64" height="64" fill="{C["teal"]}"/>'
        g = mark_group(C["white"], C["mint"], 7, 5, "translate(32 32) scale(.7) translate(-32 -31.75)")
        return HEAD.format(vb="0 0 64 64", extra="") + bg + g + "</svg>\n"
    if kind == "mac":
        # 1024 canvas, 824 tile (Apple macOS icon grid), soft drop shadow
        s = 824 / 64
        defs = ('<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">'
                '<feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".28"/>'
                '</filter></defs>')
        bg = f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{C["teal"]}" filter="url(#s)"/>'
        g = mark_group(C["white"], C["mint"], 7, 5,
                       f"translate(512 512) scale({s * .75:.4f}) translate(-32 -31.75)")
        return HEAD.format(vb="0 0 1024 1024", extra="") + defs + bg + g + "</svg>\n"
    raise ValueError(kind)


def svg_favicon() -> str:
    return (HEAD.format(vb="0 0 16 16", extra="") +
            f'<rect width="16" height="16" rx="3.5" fill="{C["teal"]}"/>'
            '<g fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="{SMALL_BUBBLE}" stroke="{C["white"]}"/><path d="{SMALL_CHECK}" stroke="{C["mint"]}"/>'
            '</g></svg>\n')


# --------------------------------------------------------------------------------------
# Wordmark: "MeetLedger" outlined from Inter Display SemiBold (OFL 1.1) via HarfBuzz shaping
# --------------------------------------------------------------------------------------
WORD = "MeetLedger"
WORD_FONT = "InterDisplay-SemiBold.ttf"
CAP = 26.0            # cap height in mark units (mark = 64)
TRACK = -0.01         # tracking in em
GAP = CAP * 0.55      # mark-to-wordmark gap
BASELINE = 40.0       # caps centred on the bubble body (y 6.75..47.25)
MARK_RIGHT = 59.25    # right edge of the mark's ink


def wordmark_paths(inter_dir: Path) -> tuple[list[str], float, dict]:
    import uharfbuzz as hb
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont

    cands = list(inter_dir.rglob(WORD_FONT))
    if not cands:
        sys.exit(f"{WORD_FONT} not found under {inter_dir} (download Inter 4.1, see module docstring)")
    fp = cands[0]
    blob = hb.Blob.from_file_path(str(fp))
    font = hb.Font(hb.Face(blob))
    buf = hb.Buffer()
    buf.add_str(WORD)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    tt = TTFont(str(fp))
    gs, order, upm = tt.getGlyphSet(), tt.getGlyphOrder(), tt["head"].unitsPerEm
    scale = CAP / tt["OS/2"].sCapHeight
    x, out, bb = 0.0, [], [1e9, 1e9, -1e9, -1e9]
    fmt = lambda v: ("%.2f" % v).rstrip("0").rstrip(".")  # noqa: E731
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        pen = SVGPathPen(gs, ntos=fmt)
        # font units (y-up) -> mark units (y-down), baseline at y=0
        tr = (scale, 0, 0, -scale, (x + pos.x_offset) * scale, -pos.y_offset * scale)
        gs[order[info.codepoint]].draw(TransformPen(pen, tr))
        out.append(pen.getCommands())
        bp = BoundsPen(gs)
        gs[order[info.codepoint]].draw(TransformPen(bp, tr))
        if bp.bounds:
            b = bp.bounds
            bb = [min(bb[0], b[0]), min(bb[1], b[1]), max(bb[2], b[2]), max(bb[3], b[3])]
        x += pos.x_advance + TRACK * upm
    width = (x - TRACK * upm) * scale
    name = tt["name"]
    meta = {
        "family": name.getDebugName(1), "style": name.getDebugName(2),
        "version": name.getDebugName(5), "license": name.getDebugName(13), "file": fp.name,
        "bounds": [round(v, 2) for v in bb],
    }
    return out, width, meta


def svg_wordmark(glyphs: list[str], bounds: list[float], c_meet: str, c_ledger: str) -> str:
    pad = 2.0  # small breathing room around the ink box
    x0, y0, x1, y1 = bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad
    meet = "".join(glyphs[:4])
    ledger = "".join(glyphs[4:])
    vb = f"{x0:.2f} {y0:.2f} {x1 - x0:.2f} {y1 - y0:.2f}"
    return (HEAD.format(vb=vb, extra=' role="img" aria-label="MeetLedger"') +
            f'<path fill="{c_meet}" d="{meet}"/><path fill="{c_ledger}" d="{ledger}"/></svg>\n')


def svg_horizontal(glyphs: list[str], width: float, dark: bool, auto: bool = False) -> str:
    line, rows = (C["frost"], C["mint"]) if dark else (C["teal"], C["green"])
    c_meet, c_ledger = (C["frost"], C["mint"]) if dark else (C["ink"], C["teal"])
    x0 = MARK_RIGHT + GAP
    total = x0 + width + 4.75  # right padding = mark's left padding
    meet = "".join(glyphs[:4])
    ledger = "".join(glyphs[4:])
    return (HEAD.format(vb=f"0 0 {total:.2f} 64", extra=' role="img" aria-labelledby="t"') +
            '<title id="t">MeetLedger</title>' + (AUTO_STYLE if auto else "") + mark_group(line, rows) +
            f'<g transform="translate({x0:.2f} {BASELINE})">'
            f'<path class="ml-meet" fill="{c_meet}" d="{meet}"/>'
            f'<path class="ml-ledger" fill="{c_ledger}" d="{ledger}"/></g></svg>\n')


# --------------------------------------------------------------------------------------
# Tokens
# --------------------------------------------------------------------------------------
SEMANTIC = {
    "light": {
        "bg": "paper", "surface": "white", "surface-tint": "teal-50", "fg": "ink", "fg-muted": "gray-600",
        "border": "gray-300", "border-strong": "gray-400", "primary": "teal", "primary-pressed": "teal-800",
        "on-primary": "white", "accent": "green", "accent-text": "green-700", "secondary": "indigo",
        "warning": "amber", "warning-text": "amber-800", "danger": "red", "focus": "indigo",
    },
    "dark": {
        "bg": "night", "surface": "night-900", "surface-tint": "night-800", "fg": "frost", "fg-muted": "frost-300",
        "border": "night-800", "border-strong": "frost-300", "primary": "mint", "primary-pressed": "green",
        "on-primary": "night", "accent": "mint", "accent-text": "mint", "secondary": "indigo-300",
        "warning": "amber", "warning-text": "amber", "danger": "red-300", "focus": "indigo-300",
    },
}


def write_tokens() -> None:
    lines = ["/* MeetLedger color tokens - generated by brand/scripts/build.py. Do not edit by hand. */",
             ":root {"]
    lines += [f"  --ml-{k}: {v};" for k, v in C.items()]
    lines += [f"  --ml-color-{k}: var(--ml-{v});" for k, v in SEMANTIC["light"].items()]
    lines += ['  --ml-font-ui: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN",',
              '    "Yu Gothic UI", "Meiryo", "Noto Sans JP", "Noto Sans CJK JP", sans-serif;',
              "  color-scheme: light dark;", "}",
              "@media (prefers-color-scheme: dark) {", "  :root {"]
    lines += [f"    --ml-color-{k}: var(--ml-{v});" for k, v in SEMANTIC["dark"].items()]
    lines += ["  }", "}", ""]
    (BRAND / "tokens.css").write_text("\n".join(lines))
    tok = {"palette": C, "semantic": {m: {k: C[v] for k, v in s.items()} for m, s in SEMANTIC.items()}}
    (BRAND / "tokens.json").write_text(json.dumps(tok, indent=2, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------------------
# Rendering helpers
# --------------------------------------------------------------------------------------
def chromium_env() -> dict:
    env = dict(os.environ)
    if "CHROMIUM_PATH" not in env:
        for p in ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome",):
            if Path(p).exists():
                env["CHROMIUM_PATH"] = p
    return env


def render(jobs: list[dict]) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(jobs, f)
    subprocess.run(["node", str(BRAND / "scripts" / "render.cjs"), f.name], check=True, env=chromium_env())
    os.unlink(f.name)


def font_face_css(inter_dir: Path | None, jp_dir: Path | None) -> str:
    """@font-face rules pointing at TEMP font files (render time only, never committed)."""
    css = []
    if jp_dir:
        for w, n in ((400, "Regular"), (500, "Medium"), (700, "Bold"), (900, "Black")):
            for fp in jp_dir.rglob(f"NotoSansJP-{n}.otf"):
                css.append(f'@font-face{{font-family:"Noto Sans JP";font-weight:{w};src:url("file://{fp}")}}')
                break
    if inter_dir:
        for w, n in ((400, "Regular"), (500, "Medium"), (600, "SemiBold"), (700, "Bold")):
            for fp in inter_dir.rglob(f"Inter-{n}.ttf"):
                css.append(f'@font-face{{font-family:"Inter";font-weight:{w};src:url("file://{fp}")}}')
                break
    return "\n".join(css)


def render_html(src: Path, out: Path, w: int, h: int, css: str, full_page: bool = False, scale: int = 1) -> None:
    """Render an HTML page from brand/ with temp @font-face injected (copy lives in a temp dir)."""
    html = src.read_text()
    inject = f'<base href="file://{BRAND}/"><style>{css}</style>'
    html = html.replace("<head>", "<head>" + inject, 1)
    tmpdir = Path(tempfile.mkdtemp())
    tmp = tmpdir / src.name
    tmp.write_text(html)
    render([{"in": str(tmp), "out": str(out), "w": w, "h": h, "fullPage": full_page, "scale": scale, "wait": 300}])
    shutil.rmtree(tmpdir)


# --------------------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inter-dir", type=Path, required=True, help="unzipped Inter 4.1 release (temp dir)")
    ap.add_argument("--jp-dir", type=Path, help="unzipped Noto Sans JP 2.004 release (temp dir)")
    ap.add_argument("--no-copy", action="store_true", help="do not copy into apps/")
    a = ap.parse_args()

    PNG.mkdir(exist_ok=True)
    write_tokens()

    # ---- SVG masters
    glyphs, width, meta = wordmark_paths(a.inter_dir)
    files = {
        "logo-mark.svg": svg_mark(C["teal"], C["green"], "MeetLedger"),
        "logo-mark-dark.svg": svg_mark(C["frost"], C["mint"], "MeetLedger"),
        "logo-mark-mono.svg": svg_mark("currentColor", "currentColor", "MeetLedger"),
        "logo-horizontal.svg": svg_horizontal(glyphs, width, dark=False),
        "logo-horizontal-dark.svg": svg_horizontal(glyphs, width, dark=True),
        "logo-horizontal-auto.svg": svg_horizontal(glyphs, width, dark=False, auto=True),
        "logo-mark-auto.svg": svg_mark(C["teal"], C["green"], "MeetLedger", auto=True),
        "wordmark.svg": svg_wordmark(glyphs, meta["bounds"], C["ink"], C["teal"]),
        "wordmark-dark.svg": svg_wordmark(glyphs, meta["bounds"], C["frost"], C["mint"]),
        "app-icon.svg": svg_tile("any"),
        "app-icon-maskable.svg": svg_tile("maskable"),
        "app-icon-touch.svg": svg_tile("touch"),
        "app-icon-macos.svg": svg_tile("mac"),
        "favicon.svg": svg_favicon(),
    }
    for name, body in files.items():
        (BRAND / name).write_text(body)
    (BRAND / "scripts" / "wordmark-font.json").write_text(json.dumps(meta, indent=2) + "\n")
    print("font:", meta["family"], meta["style"], meta["version"])

    # ---- PNG rasters
    B = lambda n: str(BRAND / n)  # noqa: E731
    P = lambda n: str(PNG / n)    # noqa: E731
    jobs = [
        {"in": B("favicon.svg"), "out": P("favicon-16.png"), "w": 16, "h": 16, "fit": "img", "transparent": True},
        {"in": B("app-icon.svg"), "out": P("favicon-32.png"), "w": 32, "h": 32, "fit": "img", "transparent": True},
        {"in": B("app-icon.svg"), "out": P("favicon-48.png"), "w": 48, "h": 48, "fit": "img", "transparent": True},
        {"in": B("app-icon-touch.svg"), "out": P("apple-touch-icon.png"), "w": 180, "h": 180, "fit": "img"},
        {"in": B("app-icon.svg"), "out": P("icon-192.png"), "w": 192, "h": 192, "fit": "img", "transparent": True},
        {"in": B("app-icon.svg"), "out": P("icon-512.png"), "w": 512, "h": 512, "fit": "img", "transparent": True},
        {"in": B("app-icon-maskable.svg"), "out": P("maskable-192.png"), "w": 192, "h": 192, "fit": "img"},
        {"in": B("app-icon-maskable.svg"), "out": P("maskable-512.png"), "w": 512, "h": 512, "fit": "img"},
        {"in": B("app-icon-macos.svg"), "out": P("desktop-icon-1024.png"), "w": 1024, "h": 1024, "fit": "img",
         "transparent": True},
        {"in": B("logo-horizontal.svg"), "out": P("logo-horizontal-1200.png"), "w": 1200,
         "h": round(1200 * 64 / (MARK_RIGHT + GAP + width + 4.75)), "fit": "img", "transparent": True},
        {"in": B("logo-horizontal-dark.svg"), "out": P("logo-horizontal-dark-1200.png"), "w": 1200,
         "h": round(1200 * 64 / (MARK_RIGHT + GAP + width + 4.75)), "fit": "img", "transparent": True},
    ]
    for s in (16, 24, 32, 48, 64, 128, 256):
        src = "favicon.svg" if s <= 24 else "app-icon.svg"
        jobs.append({"in": B(src), "out": P(f"win-{s}.png"), "w": s, "h": s, "fit": "img", "transparent": True})
    for s in (16, 32, 64, 128, 256, 512):
        src = "favicon.svg" if s == 16 else "app-icon-macos.svg"
        jobs.append({"in": B(src), "out": P(f"mac-{s}.png"), "w": s, "h": s, "fit": "img", "transparent": True})
    render(jobs)

    from PIL import Image

    # favicon.ico: 16 (small optical variant) + 32 + 48
    ico = [Image.open(PNG / n).convert("RGBA") for n in ("favicon-48.png", "favicon-32.png", "favicon-16.png")]
    ico[0].save(BRAND / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=ico[1:])
    # desktop .ico (Windows, full tile) and .icns (macOS grid)
    win = [Image.open(PNG / f"win-{s}.png").convert("RGBA") for s in (256, 128, 64, 48, 32, 24, 16)]
    win[0].save(PNG / "desktop-icon.ico", format="ICO", sizes=[im.size for im in win], append_images=win[1:])
    mac1024 = Image.open(PNG / "desktop-icon-1024.png").convert("RGBA")
    mac1024.save(PNG / "desktop-icon.icns", format="ICNS",
                 append_images=[Image.open(PNG / f"mac-{s}.png").convert("RGBA") for s in (16, 32, 64, 128, 256, 512)])
    for s in (16, 24, 32, 48, 64, 128, 256):
        (PNG / f"win-{s}.png").unlink()
    for s in (16, 32, 64, 128, 256, 512):
        (PNG / f"mac-{s}.png").unlink()

    # ---- HTML-based rasters (temp fonts injected at render time only)
    css = font_face_css(a.inter_dir, a.jp_dir)
    render_html(BRAND / "og.html", BRAND / "og.png", 1200, 630, css)
    render_html(BRAND / "brand-board.html", BRAND / "brand-board.png", 1600, 1000, css, full_page=True)

    if a.no_copy:
        return
    # ---- Copy app-facing assets
    web_pub = ROOT / "apps/web/public"
    icons = web_pub / "icons"
    assets = ROOT / "apps/web/src/assets"
    desk = ROOT / "apps/desktop/build"
    for d in (icons, assets, desk):
        d.mkdir(parents=True, exist_ok=True)
    copies = {
        BRAND / "favicon.svg": web_pub / "favicon.svg",
        BRAND / "favicon.ico": web_pub / "favicon.ico",
        BRAND / "og.png": web_pub / "og.png",
        PNG / "apple-touch-icon.png": icons / "apple-touch-icon.png",
        PNG / "icon-192.png": icons / "icon-192.png",
        PNG / "icon-512.png": icons / "icon-512.png",
        PNG / "maskable-192.png": icons / "maskable-192.png",
        PNG / "maskable-512.png": icons / "maskable-512.png",
        BRAND / "app-icon.svg": icons / "icon.svg",
        # web app: theme-adaptive variants only, under the canonical names. Fixed dark / mono files stay
        # in brand/ because Logo.tsx picks the first logo-*.svg whose name contains "horizontal"/"mark".
        BRAND / "logo-mark-auto.svg": assets / "logo-mark.svg",
        BRAND / "logo-horizontal-auto.svg": assets / "logo-horizontal.svg",
        PNG / "desktop-icon-1024.png": desk / "icon.png",
        PNG / "desktop-icon.ico": desk / "icon.ico",
        PNG / "desktop-icon.icns": desk / "icon.icns",
    }
    for s, d in copies.items():
        shutil.copyfile(s, d)
        print("copied", d.relative_to(ROOT))


if __name__ == "__main__":
    main()
