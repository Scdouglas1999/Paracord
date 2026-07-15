# Marketing & GitHub promo assets

Briefs, copy notes, and pointers for GitHub README / social presence. Product docs stay elsewhere under `docs/`.

## Folder map

| Path | Purpose |
|---|---|
| `docs/marketing/` | Briefs, messaging notes, OG/social specs |
| `docs/images/readme/` | Canonical store for README screenshots (new captures) |
| `assets/readme/` | Legacy mirror path (optional); root `README.md` now embeds `docs/images/readme/` directly |
| `docs/screenshots/` | Legacy May 2026 captures — do not use for new work |
| `docs/logo-banner.svg` | Wordmark banner already used by root `README.md` |

Capture plan details (viewports, demo seed, filename inventory): [`docs/readme-screenshot-plan.md`](../readme-screenshot-plan.md).

## Screenshots for GitHub README

1. Save new PNGs under **`docs/images/readme/`**.
2. Reference them from root `README.md` as `docs/images/readme/<name>.png` (canonical). Optionally mirror into `assets/readme/` only if something else still expects that path.
3. Prefer 1440×900 (or 1280×800 minimum), dark theme, Emerald accent. See the screenshot plan for must-haves.

**Naming:** lowercase, hyphen-separated, feature-first — e.g. `readme-home.png`, `readme-messaging.png`, `readme-sidebar.png`, `readme-rooms.png`.

**README reference pattern** (relative to repo root):

```markdown
<img src="docs/images/readme/readme-messaging.png" alt="Paracord text chat" width="100%"/>
```

Do not ship tokens, recovery phrases, private usernames, or unfinished media UI. Voice/stream shots stay deferred until media validation passes (see `docs/release-screenshot-inventory.md`).

## Logo & icon sources (for README authors)

| Asset | Path | Notes |
|---|---|---|
| **Wordmark banner (preferred for README header)** | `docs/logo-banner.svg` | 900×200 SVG; already in root README |
| App icon master | `client/app-icon.png` | 1024×1024 PNG |
| Desktop / Tauri icon | `client/src-tauri/icons/icon.png` | 512×512 PNG |
| Web / PWA icon | `client/public/pwa-512x512.png` | 512×512 PNG |
| Maskable / touch | `client/public/maskable-icon-512x512.png`, `apple-touch-icon-180x180.png` | Packaging only |

Prefer the SVG banner for README chrome. Prefer `client/app-icon.png` or `icon.png` when a square mark is needed (badges, small embeds). Do not use `client/ui_mock_screenshot.png`.

## Related briefs

- [`social-preview-brief.md`](./social-preview-brief.md) — GitHub social / Open Graph image size and crop
