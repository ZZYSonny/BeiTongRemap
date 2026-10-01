// SetChangeX360 flags 3/4 post message indices 3/4. The window handler sets
// flags at 102f9547/48; the worker dispatches ChangeX360(2), then (3).
// Addresses: 1000c84f, 1000cf56/70, 1000c9f0. Index 2 is a separate NS path.
// High bytes of XINPUT_VIBRATION left/right WORDs, spaced 50 ms apart.
export const RECEIVER_SEQUENCE = [
  // ChangeX360(2), 1000cc9a–1000cce4, 1000cdd4–1000cde2.
  [0, 0], [1, 6], [5, 3], [2, 4], [0, 0],
  // ChangeX360(3), 1000ccef–1000cdc4, 1000cdd4–1000cde2.
  [0, 0], [2, 1], [6, 5], [8, 3], [0, 0], [0, 0], [9, 0xf3], [0xc6, 5], [0, 0],
] as const;
export interface RumbleActuator {
  playEffect(type: string, parameters: { duration: number; startDelay: number; strongMagnitude: number; weakMagnitude: number }): Promise<string>;
  reset(): Promise<string>;
}
export function isXboxReceiver(id: string): boolean {
  return /(?:vendor:\s*045e.*product:\s*028e|045e[-:]028e|xbox\s*360|x-box\s*360|A1N3)/i.test(id);
}
export type ReceiverExit = 'xinput' | 'removed' | 'requested';

/** Mode switching can remove HID before sendReport resolves, even on success. */
export async function disconnectReceiver(
  connection: { device: HIDDevice; disconnect(): Promise<void> },
  hid: HID,
  getGamepads: () => readonly (Gamepad | null)[],
  waitMs = 1500,
): Promise<ReceiverExit> {
  const key = (pad: Gamepad) => `${pad.index}:${pad.id}`;
  const initial = new Set(getGamepads().filter((pad): pad is Gamepad => Boolean(pad)).map(key));
  let removed = false;
  const onDisconnect = (event: HIDConnectionEvent) => { if (event.device === connection.device) removed = true; };
  hid.addEventListener('disconnect', onDisconnect);
  try {
    let failure: unknown;
    try { await connection.disconnect(); } catch (error) { failure = error; }
    const deadline = performance.now() + waitMs;
    do {
      if (!removed) {
        try { removed = !(await hid.getDevices()).includes(connection.device); }
        catch { /* Lack of discovery permission cannot prove a mode change. */ }
      }
      if (removed && getGamepads().some(pad => pad && !initial.has(key(pad)) &&
        isXboxReceiver(pad.id) && !/BFM|507f/i.test(pad.id))) return 'xinput';
      if (performance.now() >= deadline) break;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    } while (true);
    // HID removal alone may be an unplug. Never label it confirmed XInput.
    if (removed) return 'removed';
    if (failure) throw failure;
    return 'requested';
  } finally { hid.removeEventListener('disconnect', onDisconnect); }
}
export async function switchReceiver(actuator: RumbleActuator, delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), signal?: AbortSignal): Promise<void> {
  // Keep each effect active until the next call replaces it. Awaiting playEffect
  // here would stretch the gaps between symbols and break the vendor sequence.
  let failure: unknown;
  const effects: Promise<void>[] = [];
  try {
    for (const [left, right] of RECEIVER_SEQUENCE) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      effects.push(actuator.playEffect('dual-rumble', {
        duration: 1000, startDelay: 0,
        // Chromium truncates magnitude * 65535. Half a unit avoids a floating
        // point underflow while retaining the vendor's zero low byte.
        strongMagnitude: left ? ((left << 8) + 0.5) / 65535 : 0,
        weakMagnitude: right ? ((right << 8) + 0.5) / 65535 : 0,
      }).then(result => { if (result !== 'complete' && result !== 'preempted') failure = new Error(`Browser vibration result: ${result}`); }, error => { failure = error; }));
      await delay(50);
    }
    signal?.throwIfAborted();
  } finally {
    try { await actuator.reset(); } catch { /* Receiver may disappear after switching. */ }
    await Promise.all(effects);
  }
  if (failure) throw failure;
}
