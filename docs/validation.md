# Validation

Automated checks cover protocol frames, variant selection, relay routing, M1/M2 order, preservation of macros/sensor entries, bad responses, slot changes, concurrent edits, failed writes, strict profile imports, and receiver symbol sequencing. Advanced tests cover all five model layouts, field/range validation, separate Pro deadzones, PC-slot restrictions, trigger ranges, preservation of hidden settings, changed-block writes, conflict detection across blocks and button maps, and readback before/after persistence.

Verified October 1, 2026: `npm test` passed 18 protocol/controller tests; the UI update passed 16 browser tests and `npm run build` (TypeScript checking and Vite production bundling). The browser suite includes a simulated complete receiver session with switching, HID relay, mapping/advanced read/write/save, backups, export of the saved layout, preservation of remap drafts and unedited settings, conflict recovery, and unplug handling. It also covers older models, PC-slot gating, keyboard tab selection, and invalid edits across categories. Gamepad access is stubbed in browser tests to isolate them from attached hardware.

The UI tests check page and panel overflow, advanced field/card overflow, visible control bounds, button dropdown mapping, and wheel scrolling across eight viewport sizes: 1440×900, 1280×720, 1024×600, 768×1024, 390×844, 360×640, 320×568, and 844×390. All four Advanced categories are checked, including connected/saved states on desktop, mobile, small-phone, and landscape screens. Screenshots of these layouts were inspected using mock devices; a separate geometry review found no overlapping controls.

Joystick tests measure the rendered stick-cap positions on desktop and mobile using simulated standard Gamepad axes. They cover independent left/right movement, selecting another controller, stick-click highlighting, continued mapping-button access, centering when disconnected or using an unverified nonstandard layout, and handling missing/nonfinite/out-of-range axis values.

Controller geometry tests check the entire circular outlines of LS, RS, and XYAB against the SVG shell at each visible viewport size. The stage and controls share the shell's 600×430 coordinates. Trigger tests measure independent analog size changes, partial pressure below the pressed threshold, fixed widths, controller selection, invalid values, and resets for nonstandard/disconnected input. Full-pressure triggers fit above the bumpers on phone and landscape layouts. Desktop, phone, and landscape screenshots were inspected with simulated stick movement and unequal LT/RT pressure.

Hardware status: the local receiver was identified read-only as `BEITONG A1N3 XINPUT DONGLE` (`045e:028e`). The user confirmed that the corrected receiver-switch sequence exposes a BeiTong HID in the chooser, but opening it failed on Linux. Real configuration replies, mapping/advanced writes, and power-cycle persistence remain unverified. Mock tests do not establish those capabilities. The prepared Linux permission rule passed `udevadm verify` but has not been installed in this session.

Following the native message dispatcher exposed and corrected an earlier mode-index error: this model enables Xbox routine modes 2 and 3, rather than mode 4. Browser regression coverage stages A → B before connection, keeps Apply disabled through switching, an empty chooser, and denied OS open, preserves the draft, then enables Apply only after a valid map read.

A 45-second Chromium Gamepad API probe found zero live gamepads. No physical mode-switch or mapping-write commands were issued during that probe.

To complete hardware validation:

1. Open the app in desktop Chrome/Edge, wake the controller with a button, and select the receiver in the connection bar.
2. Send Connect receiver; verify the receiver changes to `20bc:507f` and exposes 63-byte payload reports `3`/`2`.
3. Read the full map and retain its raw backup. First inspect M1/M2 assignments without changing anything.
4. Apply a reversible button edit, verify matching echo/readback, reconnect the receiver, and confirm output in the tester/game.
5. Power-cycle the controller and reread to establish persistence; restore the original mapping and repeat verification.
6. Read Advanced settings, back up the raw blocks, change one motor strength level, and verify saved readback and power-cycle persistence. Repeat for normal/Pro deadzones, Pro mode in PC slot 1, trigger thresholds/quick triggers, and lighting; restore original values afterward.

If mode switching fails, capture the recent vendor app's USB traffic around entry/exit of configuration mode. Compare packet timing, exact vibration byte values, HID descriptors, relay framing, and firmware identity before expanding compatibility.
