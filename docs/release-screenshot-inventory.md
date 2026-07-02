# Release Screenshot Inventory

This inventory tracks public-facing images that must be reviewed before a GitHub release.

## Public README Screenshots

The README now embeds one repo-local current-build screenshot:

| Section | Alt text | URL | Status |
| --- | --- | --- | --- |
| Text Chat | `Paracord text chat screenshot` | `docs/screenshots/text-chat-current.png` | Current release-candidate screenshot captured from the production client build with sanitized mocked data. |

The previous February 22, 2026 GitHub-hosted text, voice, and streaming screenshots were removed from the README because they predated the release-candidate audit. Voice and streaming screenshots should stay deferred until real media capture/view validation passes.

## Repo-Local Image Files

Repo-local raster images found during the audit:

- `docs/screenshots/dashboard-current.png`: captured from the current production client build with sanitized mocked release-preview data at 1440x900 on May 18, 2026. Candidate dashboard screenshot; currently retained for release assets but not embedded in README.
- `docs/screenshots/text-chat-current.png`: captured from the current production client build with sanitized mocked release-preview data at 1440x900 on May 18, 2026. Embedded in README as the public text-chat screenshot.
- `client/ui_mock_screenshot.png`: white/blank mock output, not suitable for public release materials.
- `client/app-icon.png`
- `client/public/*icon*.png` and `client/public/pwa-*.png`
- `client/src-tauri/icons/**/*.png`

The icon assets are packaging/app metadata, not product screenshots.

The current-build candidate screenshots were produced by:

```bash
cd client && npm run screenshots:release
```

Verification: both files are 1440x900 PNGs and sampled as nonblank (`dashboard-current.png` sampled 106 colors; `text-chat-current.png` sampled 50 colors).

## Required Release Action

Before publishing:

1. Keep voice and streaming screenshots out of the public README until real media validation passes.
2. Confirm any future screenshots do not show local secrets, private server names, access tokens, private usernames, or misleading unfinished features.
3. Replace or intentionally upload final release assets only after the release owner approves the final UI state.
