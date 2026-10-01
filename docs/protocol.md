# Asura 2 Pro protocol evidence

## Provenance

Inspected locally, October 1, 2026:

- `betopgame/vcxcUdsq/resources/app/20260922.asar`, SHA-256 `1017bf5a9ed1e9ffe21ad40eb55b06d488060a558dea86476397fef71d9f10c5`.
- `betopgame/vcxcUdsq/resources/app/20260922.node`, SHA-256 `4f5d120ce3014082540f917aac14cebba776d6714458b443b6e2d8447f1c97ac` (PE32, base address `10000000`).
- Native DLL loads `bin/xinput1_3.dll` and resolves `XInputEnable`, `XInputGetState`, `XInputSetState` (rdata at `102a2af0` through `102a2b40`).
- Initial local USB descriptor: `045e:028e`, manufacturer `BEITONG`, product `BEITONG A1N3 XINPUT DONGLE`, one class `ff`/subclass `5d`/protocol `01` interface, interrupt input `81`, output `05`, 32-byte max packets. This proves the initial receiver is XInput, not HID.

Extraction/disassembly (local-only artifacts):

```sh
mkdir -p .research/vendor
npx --yes @electron/asar extract betopgame/vcxcUdsq/resources/app/20260922.asar .research/vendor
objdump -d -M intel betopgame/vcxcUdsq/resources/app/20260922.node > .research/native-disassembly.txt
```

## Receiver-only support in the recent app

`axl2pro_ns_gzt3.js` is the relevant recent A1N3 implementation:

- Lines 73–75: controller PID `507e`, receiver PID `507f`, VID `20bc`.
- Lines 419–463: `writecb` prepends `90` in dongle mode. `readcb` routes responses with prefix `90` to the controller parser and removes that byte; unprefixed packets belong to the dongle itself.
- Lines 973–984: `checkDongle` selects dongle mode using the enumerated identity.
- Lines 1848–1859: `SetHidWriteDelay(30)`; controller registration `(20bc,507e,3,2,64)`; `RegisterAlterDev(20bc,507f,ff,3,2,64,...,0)`; adds XInput product string ` A1N3 XINPUT `; enables switch flags bits 2, 3, and 4.

## Entering configuration mode via ordinary rumble

The `SetChangeX360` flags post Windows message `401` with the bit index as `wParam` (`10067d4a–10067dc0`). The message handler at `1000c84f` writes `1` to `102f9544 + wParam`. The worker at `1000cf00` dispatches those indexed flags:

| Flag / message index | Worker address | Invoked routine |
|---|---|---|
| 2 | `1000cf38–1000cf46` | `1000ce40`: separate Switch/NS HID path |
| 3 | `1000cf4d–1000cf60` | `ChangeX360(2)` at `1000c9f0` |
| 4 | `1000cf67–1000cf7a` | `ChangeX360(3)` at `1000c9f0` |

The previous implementation incorrectly equated message index 4 with routine mode 4 and sent `55/01, 55/aa, 55/02`. The complete dispatcher trace establishes that the registered Xbox path instead uses modes 2 and 3, in order. Mode 4 is reached by message index 5, which this model does not enable.

The Xbox routine calls `XInputSetState` with a global `XINPUT_VIBRATION` at `102fa38c`, writing **byte 1 and byte 3 of that four-byte structure**: the high bytes of left and right 16-bit motor speeds. It leaves their low bytes at zero. The corrected app reproduces these ordered `(left, right)` high-byte pairs:

| Routine | Ordered pairs in hexadecimal | Native addresses |
|---|---|---|
| Mode 2 | `00/00, 01/06, 05/03, 02/04, 00/00` | `1000cc9a–1000cce4`, initial/final zero at `1000cbce–1000cbdc` / `1000cdd4–1000cde2` |
| Mode 3 | `00/00, 02/01, 06/05, 08/03, 00/00, 00/00, 09/f3, c6/05, 00/00` | `1000ccef–1000cdc4`, same initial/final zero paths |

Each call is separated by `Sleep(50)`. The vendor performs this on every active XInput gamepad; our app sends only to the user-selected Xbox receiver.

The browser uses `Gamepad.vibrationActuator.playEffect('dual-rumble', ...)`. Chromium on Windows maps strong/weak magnitude to left/right speeds by multiplying by `ffff` and truncating: [Chromium source](https://github.com/chromium/chromium/blob/main/device/gamepad/xinput_haptic_gamepad_win.cc). Our magnitude is `((symbol << 8) + 0.5) / 65535`: the half-unit guard avoids floating point underflow, and truncation yields the vendor's exact WORD, including a zero low byte. Linux's [Chromium evdev implementation](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_device_linux.cc) also converts to 16-bit rumble magnitudes; driver timing and packet behavior still need validation.

Effects run for 1,000 ms and are replaced at 50 ms intervals, without awaiting completion (which would stretch the gaps between symbols). The final reset happens after the last zero symbol. Browser effect preemption, timer throttling, driver timing, and a receiver disconnect are material uncertainties. No arbitrary USB commands or invented vendor request codes are sent.

## HID command transport

All included vendor model scripts register input report `3`, output report `2`, report size `64` including the ID. Native send worker `10068ab7–10068b20` prepends the output report ID and copies raw queued command bytes; `10068c3a–10068c45` calls `hid_write`. Native receive `10068a17–10068a31` strips one report ID byte. WebHID separates the report ID already, so payloads are exactly **63 bytes**, padded with zero. The app validates both descriptor lengths before opening a protocol session and spaces output reports by 30 ms, matching the vendor's configured write delay.

The native worker has optional byte substitution at `10068c02–10068c38`; enabled device families are not inferred from an unknown descriptor. The included identities are tested against the unencoded parser and fail closed when no valid read response arrives.

`joyconn.js:183–295` supplies a 16-bit little-endian request ID followed by command and parameters. ID `0` is unsolicited/no-callback, ID `8` is skipped, and IDs wrap before `ffff`. Replies echo the request ID. Browser code also matches the command opcode, validates sizes, and ignores dongle packets without a `90` relay marker. There is no application-level CRC in this command path.

## Keymap commands

`axl2pro_new.js`, `axl2prow_new.js` use 21-byte maps, save `f1`. `axl2pro_ns.js` and `axl2pro_ns_gzt3.js` use 33-byte maps, save `a0`. Native report ID is not included in these frames:

| Command | Request following the request ID | Expected response following the request ID |
|---|---|---|
| Base info | `10` | `10 slot minorFW dongleFW battery ...` |
| Read keymap | `22 00 size slot` | `22 00 size slot map[size]` |
| Write keymap | `23 00 size slot map[size]` | `23 00 size slot map[size]` |
| Persist | `f1 slot` or `a0 slot` | matching ID/opcode (vendor checks only reply presence) |
| Keepalive | `00` with request ID zero | ignored |

For PID `507f`, prepend `90` to the whole frame; input responses must also carry `90`. No firmware updates, factory resets, response-curve editing, sensor configuration, calibration, or slot-selection commands are implemented.

## Advanced settings

The additional commands are implemented from the same supplied archive. `axl2pro_ns_gzt3.js:293–350` defines the ordered base/left/right properties; its parser at `502–570` reads slot at byte 3 and settings at byte 4. General GET/SET builders are at `745–762`, stick builders at `847–883`. Older model layouts come from `axl2pro_new.js:230–273`, `axl2prow_new.js:230–273`, and `axl2pro_ns.js:274–328`.

| Block | GET | SET | Bytes: 504c/505b | Bytes: 505c | Bytes: 507e/507f |
|---|---|---|---:|---:|---:|
| General | `20 slot` | `21 slot settings` | 9 | 18 | 21 |
| Left stick | `26 slot` | `27 slot settings` | 10 | 10 | 12 |
| Right stick | `28 slot` | `29 slot settings` | 10 | 10 | 12 |

GET replies follow `command slot settings`, after the two request-ID bytes. SET acknowledgement is correlated by request ID and opcode; the vendor does not require a full block echo. This implementation uses fresh GETs to verify contents before persisting, then GETs again after persistence.

The ordered schema is in `src/advanced.ts`. General bytes 0–5 are light effect/color/brightness/speed and left/right vibration. The older layout then has turbo, shared trigger deadzone, and sleep. Multi-mode inserts vibration flashing at byte 6 and adds eight trigger threshold/range bytes. A1N3 appends performance and left/right quick-trigger flags at bytes 18–20. Stick byte 0 is normal deadzone; bytes 1–9 contain sensitivity switching and response curve data, which are preserved. A1N3 adds Pro deadzone at byte 10 and centering at byte 11; centering is preserved.

Ranges and meanings were checked in the supplied `third/gen3/js/app.js` UI (`esports`, `changeLever`, `Frequency.commonTurbo`, `Strength`, `dormancy`, trigger drag handlers, lighting `commonClick`/`selectItem`) and `third/gen3/tr/axl2/en.js:274–305`. Vibration levels 0–4 correspond to off/25/50/75/100%; turbo is 1–30 per second; sleep is 0–60 minutes (0 disables sleep); stick deadzones are 0–100%; light brightness/speed use levels 1–5. Trigger start/end enforce the vendor UI's 10% minimum separation. A1N3 `performance` is a 0/1 toggle shown only in PC slot 1. Its UI selects `areapro_p` when performance is enabled in that slot; other slots use `areapro`. Pro mode increases controller power use; no unverified polling-rate number is promised.

Advanced reads are lazy so an unsupported advanced response cannot prevent the original Remap connection flow. Advanced Apply checks the slot, fresh map, and all three settings blocks against the read baseline; patches only exposed fields; writes only changed blocks; checks the live blocks/map and slot; persists with the model's existing save command; and checks saved readback and slot. Any operation error invalidates both snapshots. No automatic write retries or rollback are attempted. Untouched color, response-curve, centering, sensor, and macro values are preserved. Drafts are separate from Remap and are discarded if a refreshed model/slot differs or the connection closes.

The source entry order is:

`A B X Y Back Start Turbo Shift Home LB RB LS RS Up Down Left Right LT RT M2 M1 [12 sensor entries]`.

**M2 is index 19; M1 is index 20.** Vendor event bit names use the opposite physical M convention, so keymap order must come from `KEY_DEF`, not `KEY_POS_*`.

Targets `0–18` correspond to the first 19 entries above. Targets `19–26` are left-stick directions clockwise from up; `27–34` are right-stick directions. Special values: `ff` default, `fd` disabled, `fe` macro. The app keeps existing macro bytes unless that source is explicitly edited; it does not create or edit macro definitions. All trailing sensor values are copied from the fresh read before applying edits.

## Transaction boundaries

A successful read is mandatory. Apply checks the active slot and rereads the map to detect external edits, patches only requested button entries, sends the full map, compares the write echo, rechecks the slot, sends persist, and compares a new readback. Requests are serialized and time out without automatic write retries. Any error invalidates the snapshot, requiring a fresh read. Partial live updates are reported separately from confirmed save acknowledgements. The app cannot guarantee recovery from disconnection or an active-slot switch during a device transaction.

No acknowledgement is treated as proof of storage after power loss. Only a physical power-cycle and reread/gameplay test can establish persistence.

## Manual research

- [BeiTong manual index](https://community.betop-cn.com/) and [official downloads](https://www.betop-cn.com/en/#/down).
- [Asura 2 Pro+ dual Hall user manual](https://device.report/m/d801a5e34a260d1d57cdd7acf2cabc1be14c4dba21c45ae4c180e212d2e3608f.pdf): personalized key values and macros, SHIFT swapping stick/D-pad, TURBO repeated input. Its older PC setup uses a cable. It does not document a universal physical chord for arbitrary remapping.
- [Chrome WebHID documentation](https://developer.chrome.com/docs/capabilities/hid): secure contexts, user device chooser, input/output reports, OS/device compatibility.

The user's report that the recent Windows app supports receiver-only setup is consistent with the `507f` relay and dispatched switching paths above. Product labels alone do not uniquely identify a firmware revision.
