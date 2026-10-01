# BeiTong Remap

A TypeScript web app for the **北通 阿修罗2 Pro** family. Configure onboard mappings and advanced settings, keep JSON layout drafts, and test live Xbox input. No background remapping process is used during gameplay.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173** in desktop Chrome or Edge. Production: `npm run build`, then `npm run preview`, or serve `dist/` over HTTPS. All executable project code and tests are TypeScript. No account, external fonts, analytics, or network service is required.

## GitHub Pages deployment

The repository uses `main`. After adding a GitHub remote, push it with `git push -u origin main`. In the GitHub repository's **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.

The [deployment workflow](.github/workflows/deploy-pages.yml) runs on pushes to `main` or manually from the Actions tab. It uses Node.js 24, installs locked dependencies with `npm ci`, builds the app, and deploys `dist/` to GitHub Pages. **No unit or browser tests run in CI.** The build retains TypeScript checking. The asset base path comes from the Pages configuration, supporting repository URLs, user/organization sites, and custom domains without hardcoding a repository name. The deployed URL appears in the workflow's `github-pages` environment.

To check a repository-style build locally:

```sh
npm ci
npm run build -- --base /BeiTongRemap/
npm run preview -- --base /BeiTongRemap/
```

Open `http://127.0.0.1:4173/BeiTongRemap/`. Replace `BeiTongRemap` with the GitHub repository name if different. Dependencies, generated output, test reports, local environment files, research artifacts, and the supplied vendor app are ignored by Git; source, documentation, tests, and `package-lock.json` are tracked.

## Receiver-only flow

1. Plug in the receiver, turn on the controller, and press a button. Select the correct gamepad in the connection bar if more than one is connected.
2. Click **Connect receiver**. The app sends the recent Windows assistant's dispatched Xbox mode 2 and mode 3 sequences through the Gamepad vibration API. Sending the sequence leaves the connection unconfirmed.
3. Click **Choose HID** and select the BeiTong interface. The recent A1N3 receiver enumerates as `20bc:507f` and forwards controller commands with a `90` prefix. A full keymap read must succeed before applying changes.
4. Edit mappings or choose a preset. **Apply to controller** downloads a raw backup, checks for concurrent changes, writes the mapping, checks its echo, sends the model's save command, and verifies readback.
5. Disconnect and reconnect the receiver to return to Xbox mode if necessary. Close the web app. Power-cycle the controller and test in your game to confirm persistence.

**Apply remains disabled until the configuration HID has been selected and its onboard map successfully read.** A gamepad listed as **Input only** supports live input, but has no configuration connection yet. The text beside Apply identifies the missing step. If the HID chooser is empty, no mapping write is possible; the editor preserves your draft and reports that receiver switching is unconfirmed.

**Compatibility is experimental.** The receiver path is grounded in the supplied September 22, 2026 Windows app, including its native mode-switch routine. Browser vibration timing/quantization and device firmware must be checked on real hardware. A completed vibration call does not prove receiver mode switching, and a readback does not prove persistence after power loss. This checkout has automated protocol/mock/browser validation; see [validation.md](docs/validation.md) for hardware status.

If vibration is unavailable or no configuration HID appears, the recent official Windows assistant can enter receiver configuration mode. The browser can then select its exposed HID, subject to OS access permissions. This is a setup fallback, not a running remapper. Pure XInput (`045e:028e`) is not a HID configuration device and cannot be opened with WebHID before switching.

## Linux HID permissions

If the chooser lists the BeiTong device but opening it fails, the browser may lack read/write access to its Linux `hidraw` node. Browser chooser permission does not change OS permissions. [Chrome documents the required udev setup](https://developer.chrome.com/docs/capabilities/hid#dev-tips).

For a Linux desktop using systemd/logind, install the included rule once:

```sh
sudo install -m 0644 docs/linux/65-beitong-remap.rules /etc/udev/rules.d/65-beitong-remap.rules
sudo udevadm control --reload-rules
```

Then unplug/replug the receiver, reload the browser tab, click **Connect receiver**, and choose its HID again. The rule grants the active local desktop session access only to the five supported BeiTong configuration PIDs. It does not grant access to keyboards or other HID devices, and does not require a running helper or backend. Administrator authentication is needed to install the rule; the web page cannot change Linux device permissions itself.

If opening still fails, inspect the relevant `/dev/hidraw*` ACL and Chrome's `chrome://device-log`; also check whether the receiver has already returned to Xbox mode or another application has opened its configuration interface.

## What is implemented

- **Remap / Advanced** toolbar tabs. Remap keeps the button editor and controller visualization; Advanced groups extra settings without scrolling.
- **General:** independent left/right motor strength (off to 100%), turbo rate, wireless sleep timeout, and A1N3 Pro mode (the vendor's overclocking setting, PC slot 1).
- **Sticks:** independent left/right deadzones; A1N3 also exposes the separate Pro deadzones used in PC slot 1 with Pro mode on.
- **Triggers:** individual start/full-press thresholds on multi-mode/A1N3 models, quick triggers on A1N3, and the shared trigger deadzone on older models.
- **Lighting:** steady/breathing effect, brightness, breathing speed, and vibration flashing where supported. Existing colors are preserved.
- Advanced loads values on first opening while connected, preserves drafts between tabs/categories, and downloads a raw backup before saving. Apply checks the map and all settings blocks for conflicts, writes only changed blocks, and verifies readback before and after saving. Unsupported controls are omitted; PC-only controls are disabled outside slot 1. Advanced drafts last for the current connection; mapping JSON files retain their existing format.
- Receiver-first configuration and direct USB HID configuration for known variants.
- Button-to-button or stick-direction assignments, disabled buttons, and default mappings.
- Preservation of existing macros and the 12 sensor entries in 33-byte models; macro editing is outside this version's scope.
- Local drafts, strict JSON imports/exports, and raw pre-write backup. Export captures the visible button layout, including assignments read from the controller; existing macro/unknown entries are omitted from portable profiles and preserved in the raw backup.
- Live standard Gamepad API button highlights, joystick positions, and LT/RT sizes proportional to trigger pressure rendered directly on the controller, multiple-controller selection, and hot unplug handling.
- A single-screen editor with no page or panel scrolling. Choose physical buttons on the diagram or with the button dropdown; short phone screens use the dropdown alone.
- Active onboard slot detection. The editor does not switch slots, edit response curves/macros/sensors, update firmware, or run calibration. Remap leaves advanced settings untouched; Advanced preserves mappings and fields outside the chosen edits.

Only these configuration identities are enabled:

| VID:PID | Variant | Keymap bytes | Save command |
|---|---|---:|---|
| `20bc:504c` | Asura 2 Pro wired / A1T2 | 21 | `f1` |
| `20bc:505b` | Asura 2 Pro wireless / A1S2 | 21 | `f1` |
| `20bc:505c` | Asura 2 Pro multi-mode / A1N2 | 33 | `a0` |
| `20bc:507e` | Asura 2 Pro+ / A1N3 | 33 | `a0` |
| `20bc:507f` | A1N3 receiver relay | 33 | `a0` |

Other Plus/Star Flash variants intentionally require separate identification: the vendor uses overlapping PIDs with different firmware families.

## Research and development

The supplied Windows app is kept under `betopgame/` and is ignored alongside `.research/`. No vendor binaries, code, or artwork are shipped in the web bundle. [Protocol notes](docs/protocol.md) document independently implemented commands, native disassembly addresses, provenance hashes, and uncertainty.

```sh
npm test
npm run test:browser
npm run build
```

The browser tests use `/usr/bin/chromium` when present. Override `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if your Chromium executable is elsewhere, or run `npx playwright install chromium` to use Playwright's browser.

Official sources: [assistant downloads](https://www.betop-cn.com/en/#/down), [model manuals](https://community.betop-cn.com/), [Asura 2 Pro+ manual](https://device.report/m/d801a5e34a260d1d57cdd7acf2cabc1be14c4dba21c45ae4c180e212d2e3608f.pdf). The older manual describes wired PC configuration; the supplied recent app adds a receiver relay. SHIFT/TURBO recipes are not general button remapping recipes.
