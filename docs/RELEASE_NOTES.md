# DayPane v0.3.4

Hardening release. No new features: 45 fixes from four code-review rounds across the local Node service, the Python renderer, the cloud build and the KOReader plugin.

Highlights:
- The English image now fails the build if any Chinese text reaches the canvas; font checks run on every render instead of CI only.
- Cached provider data falls back to the last known good value with a stale flag, and a stale value can never be re-cached as fresh.
- The HTTP API accepts GET/HEAD only, returns uniform 503 errors without leaking internal messages, and no longer sends a wildcard CORS header.
- The quota reporter refuses to push to source branches, encodes API parameters and writes its acknowledgement only after a successful upload.
- Kindle plugin: network timeouts back off, image metadata is written atomically, the new widget is shown before the old one is closed, and a failed download keeps the last good image.
- Release packaging is reproducible: the version comes from package.json, is checked against main.lua, and archives contain no absolute local paths.

Upgrade: replace the whole `KindleDash.koplugin` folder after backing up `koreader/settings/kindledash.lua`. Both `main.lua` and `sha256.lua` are required; do not copy only one file. Restart KOReader, then run Tools → DayPane → Setup / test image. See docs/UPGRADE.md for rollback.

This remains a prerelease. Automated tests cover code paths, not battery life or cross-device wake reliability.
