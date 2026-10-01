import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { RECEIVER_SEQUENCE } from '../../src/receiver.ts';

interface AutoTestState {
  pressed: boolean;
  recognized: boolean;
  padPresent: boolean;
  hidPresent: boolean;
  authorized: boolean;
  publishOnSwitch: boolean;
  failRumble: boolean;
  delayOpen: boolean;
  denyOpen: boolean;
  userActive: boolean;
  denyChooser: boolean;
  cancelChooser: boolean;
  exitRequests: number;
  failExitAt: number;
  exitSwitchOnFailure: boolean;
  exitPadAppears: boolean;
  rumble: number[][];
  resets: number;
  opens: number;
  closes: number;
  choosers: number;
  commands: number[];
}
declare global {
  interface Window {
    autoTest: AutoTestState;
    autoReleaseOpen: () => void;
    autoUnplug: () => void;
    autoConnectEvent: () => void;
  }
}
const setState = (page: Page, state: Partial<AutoTestState>) => page.evaluate(state => Object.assign(window.autoTest, state), state);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state: AutoTestState = {
      pressed: false, recognized: true, padPresent: true, hidPresent: false,
      authorized: true, publishOnSwitch: true, failRumble: false, delayOpen: false, denyOpen: false,
      userActive: false, denyChooser: false, cancelChooser: false,
      exitRequests: 0, failExitAt: 0, exitSwitchOnFailure: true, exitPadAppears: true,
      rumble: [], resets: 0, opens: 0, closes: 0, choosers: 0, commands: [],
    };
    class Receiver extends EventTarget {
      vendorId = 0x20bc; productId = 0x507f; productName = 'Auto test receiver'; opened = false;
      collections = [{ usagePage: 0xff, children: [], inputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }], outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }] }];
      async open() {
        state.opens++;
        if (state.denyOpen) throw new Error('Failed to open the device.');
        if (state.delayOpen) await new Promise<void>(resolve => { window.autoReleaseOpen = resolve; });
        this.opened = true;
      }
      async close() { state.closes++; this.opened = false; }
      async sendReport(_id: number, packet: Uint8Array) {
        const [relay, lo, hi, command] = packet;
        if (!lo && !hi) return;
        if (relay !== 0x90 || ![0x10, 0x22, 0x80].includes(command)) throw new Error('Unexpected configuration command');
        state.commands.push(command);
        if (command === 0x80) {
          if (packet[4] !== 3 || packet[5] !== 1) throw new Error('Incorrect exit command');
          state.exitRequests++;
          const leaveBfm = () => { state.padPresent = state.exitPadAppears; state.pressed = true; window.autoUnplug(); };
          if (state.exitRequests === state.failExitAt) {
            if (state.exitSwitchOnFailure) setTimeout(leaveBfm, 100);
            throw new DOMException('Failed to write the report.', 'NetworkError');
          }
          if (state.exitRequests === 2) leaveBfm();
          return;
        }
        const response = new Uint8Array(63);
        response.set([0x90, command === 0x10 ? 0 : lo, command === 0x10 ? 0 : hi, command,
          ...(command === 0x10 ? [1, 3, 70, 0, 0, 0] : [0, 33, 1, ...Array(33).fill(255)])]);
        queueMicrotask(() => {
          const event = new Event('inputreport');
          Object.assign(event, { reportId: 2, data: new DataView(response.buffer) });
          this.dispatchEvent(event);
        });
      }
    }
    const receiver = new Receiver();
    const inputOnly = { vendorId: 0x20bc, productId: 0x507f, collections: [{ usagePage: 1, outputReports: [] }] };
    const hid = Object.assign(new EventTarget(), {
      getDevices: async () => state.authorized && state.hidPresent ? [inputOnly, receiver] : [],
      requestDevice: async () => {
        state.choosers++;
        if (state.denyChooser) throw new DOMException('User gesture required', 'SecurityError');
        if (state.cancelChooser) return [];
        state.authorized = true; return state.hidPresent ? [receiver] : [];
      },
    });
    Object.assign(window, { autoTest: state, autoUnplug: () => {
      state.hidPresent = false;
      const event = new Event('disconnect'); Object.assign(event, { device: receiver }); hid.dispatchEvent(event);
    }, autoConnectEvent: () => {
      const event = new Event('connect'); Object.assign(event, { device: receiver }); hid.dispatchEvent(event);
    } });
    Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
    Object.defineProperty(navigator, 'userActivation', { value: { get isActive() { return state.userActive; } }, configurable: true });
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => state.padPresent ? [{
      index: 0, id: state.recognized ? 'BEITONG A1N3 XINPUT (Vendor: 045e Product: 028e)' : 'Unrelated controller',
      mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 && state.pressed, value: i === 0 && state.pressed ? 1 : 0 })),
      vibrationActuator: {
        playEffect: async (_type: string, params: { strongMagnitude: number; weakMagnitude: number }) => {
          state.rumble.push([Math.trunc(params.strongMagnitude * 65535) >> 8, Math.trunc(params.weakMagnitude * 65535) >> 8]);
          if (state.failRumble) throw new Error('Vibration unavailable');
          if (state.rumble.length % 18 === 0 && state.publishOnSwitch) {
            state.padPresent = false; state.hidPresent = true; window.autoConnectEvent();
          }
          return 'preempted';
        }, reset: async () => { state.resets++; return 'complete'; },
      },
    }] : [] });
  });
  await page.goto('/');
  await page.getByLabel('Auto connect', { exact: true }).uncheck();
});

test('auto mode defaults on, can show the three manual buttons, and only reacts to a recognized press', async ({ page }) => {
  const toggle = page.getByLabel('Auto connect', { exact: true });
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  for (const id of ['receiver-connect', 'hid-connect', 'disconnect']) await expect(page.locator(`#${id}`)).toBeVisible();
  await setState(page, { pressed: true });
  await expect(page.locator('.key-A')).toHaveClass(/pressed/);
  expect(await page.evaluate(() => window.autoTest.rumble)).toEqual([]);
  await setState(page, { pressed: false, recognized: false });
  await toggle.check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  for (const id of ['receiver-connect', 'hid-connect']) await expect(page.locator(`#${id}`)).toBeHidden();
  await expect(page.locator('#disconnect')).toBeVisible();
  await expect(page.locator('#disconnect')).toBeDisabled();
  await setState(page, { pressed: true });
  await expect(page.locator('.key-A')).toHaveClass(/pressed/);
  expect(await page.evaluate(() => window.autoTest.rumble)).toEqual([]);
  await setState(page, { recognized: true });
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  const result = await page.evaluate(() => window.autoTest);
  expect(result.rumble).toEqual(RECEIVER_SEQUENCE);
  expect(result.opens).toBe(1);
  expect(result.choosers).toBe(0);
  expect(result.commands).toEqual([0x10, 0x22]);
  await toggle.uncheck();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  for (const id of ['receiver-connect', 'hid-connect', 'disconnect']) await expect(page.locator(`#${id}`)).toBeVisible();
  await page.reload();
  await expect(toggle).toBeChecked();
});

test('disconnect stays visible in auto mode, requests XInput and turns automatic reconnect off', async ({ page }) => {
  const toggle = page.getByLabel('Auto connect', { exact: true });
  await toggle.check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { pressed: true });
  await expect(page.locator('#disconnect')).toBeEnabled();
  await page.locator('#disconnect').click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#connection-status')).toHaveText('Input only');
  await expect(page.locator('#notice')).toContainText('XInput gamepad detected');
  await expect(page.locator('#disconnect')).toBeVisible();
  await expect(page.locator('#disconnect')).toBeDisabled();
  await expect(page.locator('.key-A')).toHaveClass(/pressed/);
  await page.evaluate(() => window.autoConnectEvent());
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => window.autoTest);
  expect(result.commands).toEqual([0x10, 0x22, 0x80, 0x80]);
  expect(result.rumble.length).toBe(18);
  expect(result.closes).toBe(1);
  await toggle.check();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  expect(await page.evaluate(() => window.autoTest.rumble.length)).toBe(36);
});

for (const failExitAt of [1, 2]) test(`XInput return succeeds when exit write ${failExitAt} rejects during re-enumeration`, async ({ page }) => {
  await setState(page, { hidPresent: true, padPresent: false, failExitAt });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#disconnect')).toBeEnabled();
  await page.locator('#disconnect').click();
  await expect(page.locator('#notice')).toContainText('XInput gamepad detected');
  await expect(page.locator('#notice')).not.toHaveClass(/error/);
  await expect(page.getByLabel('Auto connect', { exact: true })).not.toBeChecked();
  await expect(page.locator('#connection-status')).toHaveText('Input only');
  expect(await page.evaluate(() => window.autoTest.exitRequests)).toBe(failExitAt);
  expect(await page.evaluate(() => window.autoTest.closes)).toBe(1);
});

test('a failed exit with BFM still present remains an error', async ({ page }) => {
  await setState(page, { hidPresent: true, padPresent: false, failExitAt: 1, exitSwitchOnFailure: false });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#disconnect')).toBeEnabled();
  await page.locator('#disconnect').click();
  await expect(page.locator('#notice')).toContainText('Failed to write the report');
  await expect(page.locator('#notice')).toHaveClass(/error/);
});

test('HID removal without a new gamepad does not claim confirmed XInput', async ({ page }) => {
  await setState(page, { hidPresent: true, padPresent: false, failExitAt: 1, exitPadAppears: false });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#disconnect')).toBeEnabled();
  await page.locator('#disconnect').click();
  await expect(page.locator('#notice')).toContainText('Configuration interface disconnected');
  await expect(page.locator('#notice')).not.toHaveClass(/error/);
});

test('first-time permission uses the explicit chooser and later reconnects automatically', async ({ page }) => {
  await page.getByRole('button', { name: 'Map A', exact: true }).click();
  await page.getByLabel('SEND THIS INSTEAD').selectOption('1');
  await setState(page, { authorized: false });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { pressed: true });
  await expect(page.locator('#connection-status')).toHaveText('Choose HID');
  await expect(page.locator('#hid-connect')).toBeFocused();
  expect(await page.evaluate(() => window.autoTest.choosers)).toBe(0);
  await expect(page.locator('#apply')).toBeDisabled();
  await page.getByRole('button', { name: 'Choose configuration HID' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('1');
  await expect(page.locator('#apply')).toBeEnabled();
  await page.evaluate(() => window.autoUnplug());
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { padPresent: true, pressed: true });
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  expect(await page.evaluate(() => window.autoTest.choosers)).toBe(1);
  expect(await page.evaluate(() => window.autoTest.rumble.length)).toBe(36);
});

test('auto opens the chooser after switching when browser activation remains available', async ({ page }) => {
  await setState(page, { authorized: false, userActive: true });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  expect(await page.evaluate(() => window.autoTest.choosers)).toBe(0);
  await setState(page, { pressed: true });
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  const result = await page.evaluate(() => window.autoTest);
  expect(result.choosers).toBe(1);
  expect(result.rumble).toEqual(RECEIVER_SEQUENCE);
  expect(result.commands).toEqual([0x10, 0x22]);
});

for (const outcome of ['denied', 'cancelled'] as const) test(`a ${outcome} automatic chooser falls back without reopening`, async ({ page }) => {
  await setState(page, { authorized: false, userActive: true, denyChooser: outcome === 'denied', cancelChooser: outcome === 'cancelled' });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { pressed: true });
  await expect(page.locator('#hid-connect')).toBeEnabled();
  await expect(page.locator('#connection-status')).toHaveText('Choose HID');
  await expect(page.locator('#notice')).toContainText(outcome === 'denied' ? 'fresh click' : 'No configuration HID selected');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.autoTest.choosers)).toBe(1);
  expect(await page.evaluate(() => window.autoTest.opens)).toBe(0);
  await setState(page, { denyChooser: false, cancelChooser: false });
  await page.locator('#hid-connect').click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
});

test('disabling auto connect during switching stops the sequence and never opens HID', async ({ page }) => {
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { pressed: true });
  await expect.poll(() => page.evaluate(() => window.autoTest.rumble.length)).toBeGreaterThan(0);
  await page.getByLabel('Auto connect', { exact: true }).uncheck();
  await expect(page.locator('#receiver-connect')).toBeEnabled();
  const result = await page.evaluate(() => window.autoTest);
  expect(result.rumble.length).toBeLessThan(18);
  expect(result.resets).toBe(1);
  expect(result.opens).toBe(0);
});

test('a late HID open is closed when auto mode was disabled while opening', async ({ page }) => {
  await setState(page, { hidPresent: true, delayOpen: true });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect.poll(() => page.evaluate(() => window.autoTest.opens)).toBe(1);
  await page.getByLabel('Auto connect', { exact: true }).uncheck();
  await page.evaluate(() => window.autoReleaseOpen());
  await expect.poll(() => page.evaluate(() => window.autoTest.closes)).toBe(1);
  await expect(page.locator('#connection-status')).not.toHaveText('Connected');
  await expect(page.locator('#apply')).toBeDisabled();
});

test('a failed held-button attempt does not repeat until another press', async ({ page }) => {
  await setState(page, { failRumble: true });
  await page.getByLabel('Auto connect', { exact: true }).check();
  await expect(page.locator('#connection-status')).toHaveText('Auto ready');
  await setState(page, { pressed: true });
  await expect(page.locator('#notice')).toContainText('Vibration unavailable');
  await expect(page.locator('#hid-connect')).toBeEnabled();
  const attempts = await page.evaluate(() => window.autoTest.rumble.length);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.autoTest.rumble.length)).toBe(attempts);
  await setState(page, { pressed: false });
  await expect(page.locator('.key-A')).not.toHaveClass(/pressed/);
  await setState(page, { pressed: true });
  await expect.poll(() => page.evaluate(() => window.autoTest.rumble.length)).toBeGreaterThan(attempts);
});
