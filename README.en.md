<div align="center">

<img src="docs/assets/logo.png" alt="StealthPDF" width="128" height="128">

# StealthPDF

**A Windows PDF reader whose window shows only while you hold a trigger key with the cursor over it**

[![CI](https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
[![Release](https://img.shields.io/github/v/release/YOUR_GITHUB_USERNAME/stealth-pdf)](https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/releases)

[简体中文](README.md) | English

</div>

---

## Overview

StealthPDF is an Electron-based PDF reader for Windows. Besides the usual **tabs, annotations and saving**, it has one unusual feature:

> **The window is visible only while the trigger key is held AND the cursor is inside the window.**
> Release the key or move the cursor out, and the window hides immediately.

| Trigger key | Cursor inside window | Window |
|:---:|:---:|:---:|
| released | no | hidden |
| released | yes | hidden |
| held | no | hidden |
| **held** | **yes** | **visible** |

While hidden, the window takes up no screen space, is absent from the taskbar and Alt+Tab, and never intercepts mouse input meant for windows underneath. Its position, open documents and annotations are preserved and come back instantly.

The trigger key is **configurable**: any keyboard key, or the mouse middle / back / forward button.

## Features

- 🙈 **Trigger-to-show** with a configurable trigger key
- 📑 **Tabs**: multiple PDFs, each remembering its own zoom, scroll position and unsaved annotations; drag to reorder
- ✋ **Hand tool**: drag to pan; middle-mouse drag pans with any tool
- 🖍 **Annotations**: highlight, pen, text (CJK supported), colors, undo; written into the PDF on save
- 🔍 **Viewing**: continuous scroll, lazy rendering, zoom, fit width, page jump, keyboard paging
- 🪟 **Window opacity** 20%–100% (slider, tray menu, global hotkeys)
- 🔒 **Privacy-friendly**: no network access, no telemetry, no key logging (see [Privacy & Security](#privacy--security))
- 📂 **File association** (installer): double-click a PDF to open it as a new tab in the running window

## Screenshots

<p align="center">
  <img src="docs/screenshots/main.png" alt="Main window" width="860">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/trigger.png" alt="Trigger key dialog"></td>
    <td width="50%"><img src="docs/screenshots/empty.png" alt="Empty state"></td>
  </tr>
</table>

## Download & Install

Get the latest build from [Releases](https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/releases):

| File | Description |
|---|---|
| `StealthPDF-Setup-x.y.z.exe` | Installer (recommended). Choose the install directory; optional PDF association |
| `StealthPDF-x.y.z-win-x64.zip` | Portable. Unzip anywhere and run `StealthPDF.exe` |

Requires Windows 10/11 (64-bit). Builds are not code-signed, so SmartScreen may warn: click "More info → Run anyway", or [build from source](docs/BUILDING.md).

## Quick Start

1. After launch the window stays visible for about 4 seconds, then enters stealth mode; a tray icon appears.
2. **Set a trigger key first.** The default is **Fn**, but most keyboards handle Fn in firmware and never report it to Windows. So Fn starts out *unbound*, and while unbound the window stays **always visible** so you are never locked out. Click the trigger button on the right of the toolbar and bind a key by recording it or choosing a preset (**Right Alt** is a good one).
3. Hold the trigger key and move the cursor onto the window to show it; release or move away to hide it.

## Usage

### Choosing a trigger key

Click the trigger button in the toolbar (yellow while unbound) or use the tray menu:

- **Record**: press "Start recording" and hit the key you want within 10 seconds. Any keyboard key works, as do mouse middle / back / forward; left and right clicks are ignored. `Esc` cancels.
- **Presets**: Fn, Right Alt, Right Ctrl, ScrollLock, mouse back / forward / middle.

Right Alt, ScrollLock and F13–F24 are the least intrusive. Avoid Shift/Ctrl (too common), the Win key (opens Start on release) and character keys (they type into other apps).

### Stealth switch

The rightmost toolbar button (also in the tray menu and on `Ctrl+Alt+H`) toggles stealth on/off. With it off, the window is always visible like a normal reader. The window is also kept visible during the first 4 seconds after launch, while file dialogs are open, while a mouse button is held to draw or drag, and while the trigger is unbound.

### Tabs

| Action | Result |
|---|---|
| Open button / `Ctrl+O` / the "+" in the tab bar | Pick files (multi-select), one tab per file |
| Drag PDFs into the window | One tab per file |
| Double-click a PDF (installer, default app) | New tab in the running window |
| Click a tab / `Ctrl+Tab` / `Ctrl+1…9` | Switch tabs |
| × on the tab / middle-click / `Ctrl+W` | Close (asks first if there are unsaved annotations) |
| Drag a tab | Reorder |

Tabs with unsaved annotations show an orange dot. Opening a file that is already open just switches to its tab.

### Tools

| Tool | Key | Usage |
|---|:---:|---|
| Hand | `H` | Drag to pan (default tool) |
| Highlight | `M` | Drag a rectangle |
| Pen | `P` | Freehand drawing |
| Text | `T` | Click, type, `Enter` to confirm, `Esc` to cancel |

`Ctrl+Z` undoes the last unsaved annotation of the current tab. Saving writes annotations into the PDF and reloads it.

### Shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Alt+H** (global) | Toggle stealth |
| Ctrl+Alt+↑ / ↓ (global) | Opacity +10% / −10% |
| Ctrl+O | Open (multi-select) |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Z | Undo annotation |
| Ctrl+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PageDown / PageUp) | Next / previous tab |
| Ctrl+1 … 8 / Ctrl+9 | N-th tab / last tab |
| Ctrl + wheel / Ctrl + `+` / `-` | Zoom |
| Ctrl+0 | Fit width |
| H / M / P / T | Hand / Highlight / Pen / Text |
| Middle-mouse drag | Pan with any tool |

### Settings and data

Settings and logs live in the app's user-data directory (tray menu → "open log folder"): `settings.json` and `stealth-pdf.log` (rotated at 1 MB). The trigger is stored like this (`code: null` means unbound):

```json
"trigger": { "type": "key", "code": 3640, "label": "Right Alt" }
```

`type` is `key` or `mouse` (mouse codes: 3 middle, 4 back, 5 forward).

> Note: the UI is currently Chinese only.

## Privacy & Security

To know the trigger key state while it is not the foreground app, StealthPDF installs a system-wide input hook via [uiohook-napi](https://github.com/SnosMe/uiohook-napi). So you can audit it:

- **It only checks trigger state.** The hook callback compares key / button codes with the configured trigger; it does not store, log or forward key contents or mouse movement. See `startHook()` in [`main.js`](main.js) and [`trigger.js`](trigger.js).
- **No network.** No requests, auto-update or telemetry.
- **Local writes only**: settings, logs (startup, trigger changes, errors; may include file paths) and PDFs you explicitly save.
- **Antivirus** products may flag global hooks. This is a false positive; verify against the source or build it yourself.
- Report vulnerabilities via [SECURITY.md](SECURITY.md).

> Use it in accordance with the rules of your workplace, school and exams.

## Known Limitations

1. The trigger key's native function still fires (hooks can observe, not suppress). E.g. a mouse back button still navigates in browsers. Prefer side-effect-free keys.
2. Fn usually cannot be detected (see above).
3. If the foreground app runs elevated, a non-elevated StealthPDF receives no input events (UIPI); run StealthPDF as administrator.
4. Annotations may be offset on pages with a `/Rotate` attribute.
5. Encrypted PDFs are not supported.
6. Existing annotations/text cannot be edited; only new ones can be added.
7. CJK text annotations need `simhei.ttf` or `msyh.ttf` from Windows; otherwise non-ASCII characters become `?`.
8. Save overwrites the original file; use Save as for important documents.
9. Quitting the app does not warn about unsaved annotations (closing a tab does); tabs are not restored on next launch.
10. Windows 10/11 only.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for help.

## Build from Source

Requires Node.js ≥ 22.12.

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf.git
cd stealth-pdf
npm install
npm start        # run
npm test         # unit tests
npm run dist     # build installer (run on Windows)
```

See [docs/BUILDING.md](docs/BUILDING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Issues and PRs are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Ideas: restore tabs on launch, text search, editing existing annotations, rotation-aware annotation, i18n.

## License

[MIT](LICENSE) © StealthPDF contributors. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgments

[Electron](https://www.electronjs.org/) · [PDF.js](https://github.com/mozilla/pdf.js) · [pdf-lib](https://github.com/Hopding/pdf-lib) · [uiohook-napi](https://github.com/SnosMe/uiohook-napi) · [Lucide](https://lucide.dev/)
