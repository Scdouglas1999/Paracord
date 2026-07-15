# Social / Open Graph preview brief

GitHub repository social preview (Open Graph) image for link unfurls on GitHub, Discord, Slack, etc.

## Spec

| Setting | Value |
|---|---|
| Canvas | **1280×640** (GitHub recommended; 2:1) |
| Safe zone | Keep logo + headline inside the center **~1200×600**; avoid critical text in the outer ~40px |
| Format | PNG or JPG; PNG preferred for sharp logo edges |
| File size | Under ~1 MB |
| Theme | Dark Emerald Commons background; match product UI, not purple/cream stock looks |

## Recommended composition

1. **Background:** Soft dark gradient or a lightly cropped product screenshot (home or rooms), dimmed so type stays readable.
2. **Mark:** Paracord wordmark from `docs/logo-banner.svg` (or square icon from `client/app-icon.png` if space is tight).
3. **Copy:** One short line max — e.g. “Self-hosted Discord alternative” — no feature laundry list.
4. **No:** Badges, version chips, QR codes, or busy UI chrome filling the frame.

## Crop notes

- If sourcing from a 1440×900 README screenshot, crop to 2:1 centered on the main workspace (sidebar + content), then scale to 1280×640.
- Prefer a dedicated composed OG asset over a raw full UI dump.

## Where to put the finished file

Suggested path once created: `docs/images/readme/social-preview.png` (or `docs/marketing/social-preview.png` if kept separate from in-README shots).

Upload in GitHub: **Settings → General → Social preview**.
