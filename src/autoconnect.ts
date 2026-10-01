import { isXboxReceiver } from './receiver.ts';

/** One attempt per press; holding a button must not restart a failed handshake. */
export class AutoConnectTrigger {
  private pressed = new Set<string>();
  reset(): void { this.pressed.clear(); }
  poll(pads: readonly Gamepad[]): Gamepad | undefined {
    const pressed = pads.filter(pad => isXboxReceiver(pad.id) && pad.buttons.some(button => button.pressed));
    const next = pressed.find(pad => !this.pressed.has(`${pad.index}:${pad.id}`));
    this.pressed = new Set(pressed.map(pad => `${pad.index}:${pad.id}`));
    return next;
  }
}

/** Only the known receiver's configuration collection is eligible for auto-open. */
export function grantedReceiver(devices: readonly HIDDevice[]): HIDDevice | undefined {
  const receivers = devices.filter(device => device.vendorId === 0x20bc && device.productId === 0x507f &&
    device.collections.some(collection => collection.usagePage === 0xff && collection.outputReports?.some(report => report.reportId === 2)));
  if (receivers.length > 1) throw new Error('More than one receiver is available. Choose HID to select the receiver.');
  return receivers[0];
}

export async function waitForGrantedReceiver(hid: HID, signal: AbortSignal, waitMs = 0): Promise<HIDDevice | undefined> {
  const deadline = performance.now() + waitMs;
  do {
    signal.throwIfAborted();
    const device = grantedReceiver(await hid.getDevices());
    signal.throwIfAborted();
    if (device) return device;
    if (performance.now() >= deadline) return;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  } while (true);
}
