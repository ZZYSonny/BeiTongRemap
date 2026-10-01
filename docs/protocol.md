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
| Mode 2 | `00/00, 01/06, 05/03, 02/04, 00/00, 00/00, 09/f3, c6/05, 00/00` | `1000cc9a–1000cce4`, shared tail `1000cd52–1000cdc4`, initial/final zero at `1000cbce–1000cbdc` / `1000cdd4–1000cde2` |
| Mode 3 | `00/00, 02/01, 06/05, 08/03, 00/00, 00/00, 09/f3, c6/05, 00/00` | `1000ccef–1000cdc4`, same initial/final zero paths |

Both modes include the completion tail `00/00, 00/00, 09/f3, c6/05` before the final zero. For mode 2, `cmp ebx,2` at `1000ccea` sets the equality flag, then the unconditional jump at `1000cced` goes directly to the shared `jne` at `1000cd4c`. It bypasses mode 3's comparison at `1000cd49`, so the tail executes for mode 2 as well. The previous 14-symbol browser sequence incorrectly omitted this tail from mode 2. The corrected sequence has 18 symbols, nine per mode.

Each call is separated by `Sleep(50)`. The vendor performs this on every active XInput gamepad; manual mode sends only to the user-selected Xbox receiver. Optional auto mode starts the same sequence on a recognized Xbox receiver's button press, with one attempt per press. Its Gamepad identity check also matches generic Xbox 360 IDs because this receiver uses `045e:028e`; that ID alone cannot uniquely establish BeiTong hardware.

Auto mode defaults on in supported secure browser contexts and uses WebHID, with no WebUSB transport. After switching, it checks `getDevices()`, accepting only an authorized `20bc:507f` configuration collection with usage page `00ff` and output report `2`; `Controller.open()` then performs full descriptor validation and reads the active map. Ambiguous receivers require manual selection. An existing grant can also be discovered on enable or a HID connect event. When no grant is available, a still-active page gesture allows an immediate `requestDevice()` popup. Without it, discovery polls for up to 2.5 seconds before prompting and focusing Choose HID for a fresh click. The [WebHID specification](https://wicg.github.io/webhid/#dom-hid-requestdevice) requires transient activation; a controller press does not supply it. A blocked or cancelled chooser leaves the explicit button available without reopening automatically. Cancellation checks prevent a late open from becoming the active connection and always reset vibration when a sequence stops.

The browser uses `Gamepad.vibrationActuator.playEffect('dual-rumble', ...)`. Chromium's **direct XInput backend** on Windows maps strong/weak magnitude to left/right speeds by multiplying by `ffff` and truncating: [Chromium source](https://github.com/chromium/chromium/blob/main/device/gamepad/xinput_haptic_gamepad_win.cc). The previous encoding used `((symbol << 8) + 0.5) / 65535`: the half-unit guard avoids floating point underflow, and truncation yields the vendor's exact WORD, including a zero low byte. Linux's [Chromium evdev implementation](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_device_linux.cc) also converts to 16-bit rumble magnitudes; driver timing and packet behavior still need validation.

Windows Chromium also has a separate [Windows.Gaming.Input (WGI) backend](https://github.com/chromium/chromium/blob/main/device/gamepad/wgi_gamepad_device.cc). It passes normalized floating-point magnitudes to `IGamepad::put_Vibration`, rather than constructing `XINPUT_VIBRATION`. Thus the direct-XInput conversion above does not establish the bytes or timing reaching the receiver through WGI. WGI can also reuse the legacy `Xbox 360 Controller (XInput STANDARD GAMEPAD)` identity string; that display name does not identify the active backend. [Chromium 143 enables WGI by default](https://github.com/chromium/chromium/blob/143.0.7499.193/device/gamepad/public/cpp/gamepad_features.cc). Backend selection and flag availability depend on the browser version.

The user reported that Windows Chromium 154 left the receiver in XInput and produced two vibration bursts with a gap, whereas Linux produced one. Enabling and disabling the fetcher setting both failed with the same vibration pattern, so toggling it is not a verified workaround. This does not identify the active backend or isolate quantization, driver behavior, or scheduling as a cause. Rechecking the native routine then exposed the omitted mode-2 completion tail described above. The user subsequently reported that the corrected 18-symbol sequence also fails on Windows. That failure used the previous `native-word` encoding; the subsequent magnitude change succeeded on both operating systems, as described below. Successful mock calls do not prove receiver recognition. The user subsequently confirmed that the stock Windows assistant successfully switches the same receiver. The failure is therefore specific to the browser attempt or differences in its command path; the exact cause remains unverified. A local, uncommitted diagnostic probe recorded browser request timings, promise outcomes, page state and device events during the attempt; it cannot expose downstream USB bytes or establish the active Windows backend.

Further inspection of the bundled `bin/xinput1_3.dll` found Microsoft version metadata `9.18.944.0000`. Its motor-output routine at `00406e70` loads the two cached WORDs at offsets `34`/`36`, shifts each right by eight at `00406e94`/`00406ea1`, and puts the resulting bytes into the driver request. This supports the high-byte symbol interpretation. Chromium's current [direct-XInput loader](https://github.com/chromium/chromium/blob/main/device/gamepad/xinput_data_fetcher_win.cc) instead loads `xinput1_4.dll`. This library difference is a lead, not proof of differing USB output or the active backend in the user's browser. The real trace and its limits are recorded in `validation.md`.

Effects run for 1,000 ms and are replaced at 50 ms intervals, without awaiting completion (which would stretch the gaps between symbols). The final reset happens after the last zero symbol. Browser effect preemption, timer throttling, driver timing, and a receiver disconnect are material uncertainties. No arbitrary USB commands or invented vendor request codes are sent.

### Linux/Windows magnitude encoding

The same Chromium frontend does not imply the same output conversion. The Linux evdev implementation truncates `magnitude * 65535`; the kernel's [Xbox 360 xpad output](https://github.com/torvalds/linux/blob/master/drivers/input/joystick/xpad.c) divides the 16-bit strengths by 256 and emits `00 08 00 left right 00 00 00`. This agrees with the bundled XInput 1.3 DLL's extraction of high bytes. WGI passes normalized values to Windows; its downstream conversion remains unknown. Chromium's direct XInput implementation uses a different DLL from the vendor application, as noted above.

A plausible quantizer difference is direct `floor(magnitude * 255)` or rounding to an 8-bit strength. Under the floor hypothesis, every nonzero symbol in the previous `native-word` sequence becomes one too low: `01` becomes `00`, `f3` becomes `f2`, and `c6` becomes `c5`. This would preserve an almost indistinguishable rumble while corrupting the command. This is arithmetic under an explicitly hypothetical Windows conversion, not a discovery of Windows implementation details.

The default `byte-compatible` encoding chooses a magnitude strictly inside the overlap of the `floor(m*255)` and `floor(m*65535)>>8` bins: `(b/255 + ((b+1)*256)/65535)/2`, with exact zero and one for endpoint bytes. It also yields the same byte under `round(m*255)` and after float32 conversion. It changes the low bits of the 16-bit strengths while preserving their high bytes. Symbol order, 50 ms requested delays, 1000 ms effect duration, cancellation, reset, and HID discovery are unchanged. The user confirmed that this encoding connects successfully on both Windows and Linux. It is now the default without platform detection or a URL query. This is physical connection evidence, not proof of the exact Windows quantizer or validation of writing, disconnecting, or persistence.

Other plausible differences are redundant-command handling and timing. Linux's [memoryless force-feedback implementation](https://github.com/torvalds/linux/blob/master/drivers/input/ff-memless.c) invokes playback when an effect is restarted, and Chromium uploads/restarts on each call; identical motor values are therefore not sufficient to establish identical driver activity across platforms. The Windows layers could suppress or combine repeated values, including the protocol's consecutive zero pairs; that behavior has not been verified. The real Windows trace also shows 50.1–67.5 ms JavaScript intervals, but neither the receiver's tolerance nor actual native/USB intervals are known. These hypotheses remain separate from the magnitude-only experiment. Shared Chromium effect replacement reports `preempted` normally and does not insert an extra zero when `startDelay` is zero, so the recorded preemptions alone do not explain the OS difference.

## Leaving BFM configuration mode

The supplied `third/gen3/gen3.js:54–59` calls `app_enableConfig(1)` twice in `exitConfigMode()`, after disabling automatic XInput switching. `axl2pro_ns_gzt3.js:678–685` encodes this as command `80`, parameters `03 01`; its receiver transport adds the `90` relay prefix. The explicit Disconnect action sends both packets with distinct nonzero request IDs, output report `2`, and the existing 30 ms write spacing, then closes WebHID. It does not wait for command replies because switching modes can remove the configuration interface. It does not save, reload, or reset mappings/settings.

Only receiver model `20bc:507f` receives this sequence. Ordinary cleanup, unplug handling, cancelled opens, and non-receiver disconnects only close the connection. Explicit disconnect turns Auto connect off, updating the checkbox immediately. Turning it back on resumes automatic connection. The app observes HID removal and newly appearing Xbox gamepad identities for up to 1.5 seconds after closing. A mode switch can reject even the first `sendReport()` call, so a write error alone is not treated as exit failure. HID removal plus a new Xbox gamepad is reported as detected XInput; removal alone asks the user to check input, while a write failure with BFM still present remains an error. An Xbox gamepad that was already present cannot confirm the transition.

Hardware follow-up: after the user saw a failed-write message on Disconnect, the user reported XInput, and live USB sysfs inspection independently showed `BEITONG A1N3 XINPUT DONGLE`, `045e:028e`, at port `5-6.4` (USB device 114). This confirms that the receiver had returned to XInput despite the write error. It does not establish which of the two writes caused removal.

## HID command transport

All included vendor model scripts register input report `3`, output report `2`, report size `64` including the ID. Native send worker `10068ab7–10068b20` prepends the output report ID and copies raw queued command bytes; `10068c3a–10068c45` calls `hid_write`. Native receive `10068a17–10068a31` strips one report ID byte. WebHID separates the report ID already, so payloads are exactly **63 bytes**, padded with zero. The app validates both descriptor lengths before opening a protocol session and spaces output reports by 30 ms, matching the vendor's configured write delay.

Live Linux inspection on October 1, 2026 corrected the assumption that the registration's input ID describes every receiver. The `20bc:507f` **BEITONG A1N3 BFM DONGLE** exposes two HID interfaces: interface 0 has mouse/gamepad input reports (gamepad ID `3`, 10-byte payload, no output report), while interface 1 has usage page `00ff`, usage `03`, and **input `2` / output `2`, 63-byte payloads**. Its configuration descriptor is:

```text
05 ff 09 03 a1 01 85 02 19 01 29 02 15 00 26 ff 00 75 08 95 3f
81 02 19 01 29 02 15 00 26 ff 00 75 08 95 3f 91 02 c0
```

Real base-info, keymap, and advanced GET replies arrived on report `2`. Receiver report selection accepts the full-size input `3` or `2` and uses that selected ID when receiving; other models retain input `3`. The receiver chooser filters usage page `00ff` to exclude the separate gamepad interface. An incompatible descriptor error includes the discovered report IDs and sizes. The [WebHID specification](https://wicg.github.io/webhid/index.html#hidreportinfo-dictionary) defines report metadata separately from the report ID byte.

The native worker has optional byte substitution at `10068c02–10068c38`; enabled device families are not inferred from an unknown descriptor. The included identities are tested against the unencoded parser and fail closed when no valid read response arrives.

`joyconn.js:183–295` supplies a 16-bit little-endian request ID followed by command and parameters. ID `0` is unsolicited/no-callback, ID `8` is skipped, and IDs wrap before `ffff`. Configuration replies echo the request ID. Base info is an exception: `axl2pro_ns_gzt3.js:740–743` requests it without a callback, and live firmware sends `90 00 00 10 ...` even when requested with a nonzero ID. A fresh ID-zero base-info notification may satisfy a pending base-info read; it is never cached for later slot checks. All other commands, including every write/save acknowledgement, retain request-ID matching. Browser code also matches the command opcode, validates sizes, and ignores dongle packets without a `90` relay marker. There is no application-level CRC in this command path.

## Keymap commands

`axl2pro_new.js`, `axl2prow_new.js` use 21-byte maps, save `f1`. `axl2pro_ns.js` and `axl2pro_ns_gzt3.js` use 33-byte maps, save `a0`. Native report ID is not included in these frames:

| Command | Request following the request ID | Expected response following the request ID |
|---|---|---|
| Base info | `10` | `10 slot minorFW dongleFW battery ...` |
| Read keymap | `22 00 size slot` | `22 00 size slot map[size]` |
| Write keymap | `23 00 size slot map[size]` | `22 00 size slot map[size]` on observed BFM firmware; `23` echo also accepted |
| Persist | `f1 slot` or `a0 slot` | matching ID/opcode (vendor checks only reply presence) |
| Keepalive | `00` with request ID zero | ignored |

For PID `507f`, prepend `90` to the whole frame; input responses must also carry `90`. No firmware updates, factory resets, response-curve editing, sensor configuration, calibration, or slot-selection commands are implemented.

Live write validation on October 1, 2026 found that SET_KEYMAP (`23`) replies with GET_KEYMAP opcode `22`, retaining the write's request ID and full map. For example, request `90 03 40 23 00 21 01 ...` returned `90 03 40 22 00 21 01 ...`. Previously this valid reply was discarded, causing a timeout after the live mapping had already been written. The vendor's `setKeyMap` callback (`axl2pro_ns_gzt3.js:790–805`) passes the response to the same map parser as GET and does not require opcode `23`. The browser now accepts this specific `23` → `22` response alongside a `23` echo, still requiring the write's request ID, map size, slot and byte-for-byte contents before save. A full `Controller.apply({})` hardware probe rewrote the existing mapping unchanged, received save acknowledgement `a0 01 01`, and verified a fresh keymap read. Power-cycle persistence was not tested.

## Live configuration input

Switching the receiver out of Xbox mode removes or changes its standard Gamepad API entry. The configuration interface instead emits unsolicited `11` input notifications. The supplied `axl2pro_ns_gzt3.js:214–240,519–538` parses these separately from command replies; the same layout appears in the other supported model scripts. After stripping the HID report ID and optional `90` relay prefix, the packet contains:

| Byte offset | Value |
|---|---|
| 0–1 | Request ID (zero for observed notifications) |
| 2 | Opcode `11` |
| 3 | `0` mapped input, `1` raw physical input |
| 4–7 | LX, LY, RX, RY; center `80` |
| 8–9 | LT, RT pressure, `0`–`ff` |
| 10–13 | Little-endian button bitmask |

Ordered physical tests on October 1, 2026 confirmed right M1 = bit 20 and left M2 = bit 19, contrary to the vendor script's backkey constant names. Left-stick right produced X = `00`; up produced Y = `00`. LT and RT independently reached `ff`, with digital flags at bits 17 and 18. Axes are normalized to the existing tester coordinates; trigger pressure and digital button state are kept separate.

The controller stores the latest input state without putting notifications into the command-response queue. Once a raw packet is seen, interleaved mapped packets cannot replace it: this keeps the diagram on the physically pressed backkey instead of alternating with its remapped LS/RS output. Reads, writes and save acknowledgements still follow their existing correlation rules. No additional input-polling or subscription command is sent. The browser selects this input source after opening the configuration HID; its name comes from the device. The existing animation-frame renderer updates the highlights, stick caps and trigger sizes. Closing/disconnecting clears the state. The user confirmed that button detection works in the browser after this change.

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

**M2 (left) is index 19; M1 (right) is index 20.** This matches the vendor script's `KEY_DEF` and the user's physical test. Swapping the diagram labels must not swap these wire offsets: an earlier edit did both, causing Classic to produce left → RS and right → LS. Classic must write `11` (LS click) at index 19 and `12` (RS click) at index 20; Soul writes `1` (B) and `12` respectively. Vendor event-bit constants use the opposite name order and are not keymap offsets.

Targets `0–18` correspond to the first 19 entries above. Targets `19–26` are left-stick directions clockwise from up; `27–34` are right-stick directions. Special values: `ff` default, `fd` disabled, `fe` macro. The app keeps existing macro bytes unless that source is explicitly edited; it does not create or edit macro definitions. All trailing sensor values are copied from the fresh read before applying edits.

## Transaction boundaries

A successful read is mandatory. Apply checks the active slot and rereads the map to detect external edits, patches only requested button entries, sends the full map, compares the write echo, rechecks the slot, sends persist, and compares a new readback. Requests are serialized and time out without automatic write retries. Any error invalidates the snapshot, requiring a fresh read. Partial live updates are reported separately from confirmed save acknowledgements. The app cannot guarantee recovery from disconnection or an active-slot switch during a device transaction.

No acknowledgement is treated as proof of storage after power loss. Only a physical power-cycle and reread/gameplay test can establish persistence.

## Manual research

- [BeiTong manual index](https://community.betop-cn.com/) and [official downloads](https://www.betop-cn.com/en/#/down).
- [Asura 2 Pro+ dual Hall user manual](https://device.report/m/d801a5e34a260d1d57cdd7acf2cabc1be14c4dba21c45ae4c180e212d2e3608f.pdf): personalized key values and macros, SHIFT swapping stick/D-pad, TURBO repeated input. Its older PC setup uses a cable. It does not document a universal physical chord for arbitrary remapping.
- [Chrome WebHID documentation](https://developer.chrome.com/docs/capabilities/hid): secure contexts, user device chooser, input/output reports, OS/device compatibility.

The user's report that the recent Windows app supports receiver-only setup is consistent with the `507f` relay and dispatched switching paths above. Product labels alone do not uniquely identify a firmware revision.
