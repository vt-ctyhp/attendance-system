## Highlights
- Live Settings modal lets employees enter work email and server URL without editing config files.
- Schedule card now pulls each employee's default hours from payroll config and updates every sync.
- Heartbeat, presence, and request workflows rebuilt for reliable active/idle tracking.
- UI polish: remaining balance copy, idle minutes label, and scheduler hookups for real-time updates.

## macOS Gatekeeper Bypass (unsigned build)
1. Download the `.dmg` for your architecture.
2. Right-click (control-click) the `AttendanceApp` icon and choose `Open`.
3. When macOS warns about an unidentified developer, click `Open` to confirm.
4. On future launches you can double-click normally. If blocked again, visit **System Settings → Privacy & Security → Security** and click `Open Anyway`.

## Windows Install
- Run the `AttendanceApp-1.0.6-win-x64.exe` installer and follow the prompts. The build is unsigned, so Windows SmartScreen may ask you to confirm running it.

## First-Run Setup
- Launch the app, open **Settings**, set the server URL to `https://attendance-system-j9ns.onrender.com`, and enter your work email.
- After saving, the dashboard fetches your live schedule and enables clock-in.
