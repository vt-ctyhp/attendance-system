# Attendance App

Electron + TypeScript desktop client for recording attendance activity. The app keeps a lightweight footprint, buffers actions when offline, and coordinates with the Attendance API.

## Prerequisites

- Node.js 18+ (recommended v20, matching Electron runtime)
- npm 9+

## Install

```bash
npm install
```

## Development

```bash
npm start
```

`npm start` performs a clean TypeScript build, bundles the renderer with esbuild, copies static assets, and launches Electron in development mode.

## Settings

Open the **Settings** button in the main window to view or change the server URL.

- The value defaults to `SERVER_BASE_URL` from `.env`; otherwise the packaged app uses `https://attendance.vvsjewelco.com` while development builds fall back to `http://localhost:4000`.
- Use **Test Connection** to probe the server before saving.
- Saved settings persist under the app's user-data directory; updates refresh in-memory clients immediately.

## Requests

- Click **Requests** to submit a PTO / UTO / Make-Up request with date (or date range), hours, and a reason.
- Requests include the logged-in email and the device ID in the payload (`POST /api/time-requests`).
- The **My Requests** list shows pending/approved/denied statuses via `GET /api/time-requests/my`; use **Refresh** to pull the latest state.
- When offline, new requests are queued locally and automatically retried once connectivity returns.

## Auto-launch

When packaged (macOS or Windows), the app registers itself to start automatically on user login. In development builds auto-launch is skipped.

## Offline behaviour

- Heartbeats gather system idle time from Electron's `powerMonitor` (idle ≥10 minutes marks the session idle).
- Keyboard and mouse activity is aggregated into per-minute buckets (best-effort from the renderer window).
- Failed API calls are written to an offline queue stored in the user-data directory. The queue drains automatically once connectivity returns.

## Logging

Rotating log files (1 MB max, previous copy archived) live under `<userData>/logs/attendance.log`.

## Packaging

- `npm run build` – compile main & renderer into `dist/`.
- `npm run pack` – assemble an unpacked app directory (`release/`).
- `npm run dist:mac` – unsigned DMG/ZIP artifacts for macOS (`release/AttendanceApp-<version>-mac-*.{dmg,zip}`).
- `npm run dist:win` – unsigned NSIS installer for Windows (requires Wine/Mono when invoked from macOS).
- Custom icons must live in `attendance-app/build/` using Electron Builder defaults:
  - `build/icon.icns` (macOS),
  - `build/icon.ico` (Windows),
  - `build/icon.png` (512×512, Linux/AppImage).

`electron-builder` reuses the compiled `dist/` assets each time and drops installers into `release/`.

## Auto-updates & Releases

- Packaged builds check for updates on launch and expose **Check for Updates…** in the application menu (and tray menu). Updates download in the background and prompt to restart when ready.
- Update checks are disabled while running from source (`npm start`).
- `electron-builder` is configured to publish releases to GitHub Releases (replace the placeholder `owner`/`repo` before enabling CI publishing).

### Required CI secrets

Set these secrets in your build environment before publishing signed releases:

- `GH_TOKEN` – GitHub personal access token with `repo` scope for uploading release assets.
- Apple notarization (choose one path):
  - API key: `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; or
  - Legacy credentials: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`.
- macOS code signing certificate: `CSC_LINK` (base64 PKCS12) and `CSC_KEY_PASSWORD`.
- Windows code signing certificate: `WIN_CSC_LINK` (base64 PKCS12) and `WIN_CSC_KEY_PASSWORD`.

### Cutting a release

1. Bump the version in `package.json` and commit.
2. Run `npm ci && npm test` followed by the desired `npm run dist:*` target locally if you want a smoke build.
3. Push a tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). CI should run `electron-builder` with `--publish always` to upload artifacts and the update feed (`latest*.yml`).
4. Attach release notes on GitHub if not automated.

## Additional scripts

- `npm run clean` – remove build output.
- `npm run prepare:dist` – rebuild TypeScript, bundle renderer, copy assets (used by other scripts).
