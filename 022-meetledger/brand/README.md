# MeetLedger brand assets

Guidelines (in Japanese): [`docs/BRANDING.md`](../docs/BRANDING.md). Overview: [`brand-board.png`](brand-board.png).

The mark is one continuous line: the speech bubble's tail turns into a check mark, and the two
rows inside are the ledger entries. It says that what was said in a meeting becomes a recorded,
completed commitment. There is no microphone and no photograph.

## Files

| File | Use |
|---|---|
| `logo-horizontal.svg` / `logo-horizontal-dark.svg` | Primary lockup (mark + wordmark), for light / dark backgrounds |
| `logo-horizontal-auto.svg` | Light lockup that switches itself to dark colors via `prefers-color-scheme` (`<img>` use in the web app) |
| `logo-mark.svg` / `logo-mark-dark.svg` / `logo-mark-auto.svg` | Mark only, for light / dark / auto |
| `logo-mark-mono.svg` | One-color mark (`currentColor`), for inline SVG, stamps and embossing |
| `wordmark.svg` / `wordmark-dark.svg` | Wordmark only (outlined paths) |
| `app-icon.svg` | App tile master (rounded corners), source of icon-192/512 and favicon 32/48 |
| `app-icon-maskable.svg` | Full-bleed tile with the mark inside the 80% safe zone (PWA `maskable`) |
| `app-icon-touch.svg` | Full-bleed tile for `apple-touch-icon` (iOS applies its own mask) |
| `app-icon-macos.svg` | 1024 canvas on the macOS icon grid (824 tile + shadow), source of the desktop icons |
| `favicon.svg` / `favicon.ico` | 16 px optical variant (no ledger rows, mint check). The ICO holds 16 (small variant) + 32 + 48 (tile) |
| `png/` | Rasters: apple-touch-icon 180, icon-192/512, maskable-192/512, favicon 16/32/48, desktop icon 1024 / .ico / .icns, lockups 1200 px |
| `og.html` → `og.png` | 1200×630 OGP image |
| `brand-board.html` → `brand-board.png` | Brand board (1600 px wide) |
| `tokens.css` / `tokens.json` | Color tokens (palette + light/dark semantic) |
| `scripts/build.py`, `scripts/render.cjs` | Rebuild everything above (single source of truth for geometry & colors) |
| `THIRD_PARTY_FONT_NOTICE.txt` | Font provenance and license |

Copies used by the apps, written by `build.py`:

- `apps/web/public/` gets `favicon.svg`, `favicon.ico` and `og.png`
- `apps/web/public/icons/` gets `icon-192.png`, `icon-512.png`, `maskable-192.png`, `maskable-512.png`, `apple-touch-icon.png` and `icon.svg`
- `apps/web/src/assets/` gets `logo-horizontal.svg` and `logo-mark.svg`, which are copies of the `*-auto.svg` variants. Only these two go there because `Logo.tsx` picks the first `logo-*.svg` whose name contains "horizontal" or "mark". A fixed `-dark` file in that folder could be picked on a light UI.
- `apps/desktop/build/` gets `icon.png` (1024), `icon.ico` (16–256) and `icon.icns`

## Fonts and licenses

| Font | Version | License | Source | Used for |
|---|---|---|---|---|
| **Inter Display SemiBold** (Rasmus Andersson / The Inter Project Authors) | v4.1 release (`Version 4.001;git-9221beed3`) | **SIL OFL 1.1** | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip | Wordmark, converted to SVG outlines with fontTools + HarfBuzz (kerning on, tracking −0.01em) |
| **Noto Sans JP** (Adobe / Google) | 2.004 | **SIL OFL 1.1** | https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip | Japanese text when rasterizing `og.png` and `brand-board.png` only |

**No font files are committed.** They are downloaded to a temp directory at build time. The
wordmark is static paths, so the product never needs the font. The UI uses the system font stack
(`--ml-font-ui` in `tokens.css`).

## Rebuild

```bash
curl -L -o /tmp/inter.zip https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip && unzip -q /tmp/inter.zip -d /tmp/inter
curl -L -o /tmp/notojp.zip https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip && unzip -q /tmp/notojp.zip -d /tmp/notojp
pip install --user fonttools uharfbuzz pillow
python3 brand/scripts/build.py --inter-dir /tmp/inter --jp-dir /tmp/notojp   # --no-copy to skip apps/
```

Rendering uses the repo's root `playwright-core` and Chromium. Set `CHROMIUM_PATH` if Playwright's
default browser is not installed. Change geometry or colors only in `scripts/build.py` (`C`, `BUBBLE`,
`ROWS`, `SMALL_*`), then rebuild. `og.html` and `brand-board.html` reference the generated SVGs.

## Name / trademark

"MeetLedger" had no exact product conflict in a web search (`docs/research/A_market_providers_costs.md` §2).
**The official trademark databases (J-PlatPat, USPTO, WIPO) were not searched.** A person must do
that before release. See `docs/BRANDING.md` §9.
