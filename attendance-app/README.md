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

- The value defaults to `SERVER_BASE_URL` from `.env` (or `http://localhost:4000` when unset).
- Use **Test Connection** to probe the server before saving.
- Saved settings persist under the app's user-data directory; updates refresh in-memory clients immediately.

## Requests

- Click **Requests** to submit a PTO / Non-PTO / Make-Up request with date (or date range), hours, and a reason.
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

All build artefacts land in `dist/`.

- Developer package (unpacked directory):
  ```bash
  npm run pack
  ```
- Release installers (.dmg for macOS, .exe via NSIS for Windows):
  ```bash
  npm run dist
  ```

Before packaging, `electron-builder` reuses the compiled `dist/main` and `dist/renderer` outputs produced by `npm run prepare:dist`.

## Additional scripts

- `npm run clean` – remove build output.
- `npm run prepare:dist` – rebuild TypeScript, bundle renderer, copy assets (used by other scripts).
