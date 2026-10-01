import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { RECEIVER_SEQUENCE } from '../../src/receiver.ts';

test.beforeEach(async ({ page }) => {
  // UI tests must never send mode-switch rumble to attached physical devices.
  await page.addInitScript(() => Object.defineProperty(navigator, 'getGamepads', { value: () => [], configurable: true }));
});

async function expectNoScrolling(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const clippedControls = Array.from(document.querySelectorAll<HTMLElement>('button, input:not([hidden]), select')).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1);
    }).map(element => element.id || element.getAttribute('aria-label') || element.textContent);
    const overflow = Array.from(document.querySelectorAll<HTMLElement>('body, #app, main, section, .workspace, .connection-actions, .mapping-editor, .preset-row, .profile-tools, .apply-footer, .advanced-fields, .settings-card')).filter(element => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1).map(element => element.id || element.className || element.tagName);
    return { clippedControls, overflow, pageFits: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth };
  });
  expect(layout).toEqual({ clippedControls: [], overflow: [], pageFits: true });
}

async function expectControlsOnShell(page: Page): Promise<void> {
  const outside = await page.evaluate(() => {
    const shell = document.querySelector<SVGPathElement>('.controller-shape > path')!;
    const matrix = shell.getScreenCTM();
    if (!matrix || !shell.getBoundingClientRect().width) return [];
    const inverse = matrix.inverse();
    const keys = ['LS', 'RS', 'A', 'B', 'X', 'Y'];
    return keys.filter(key => {
      const rect = document.querySelector(`.key-${key}`)!.getBoundingClientRect();
      // Test the rendered circular outline against the actual shell, not its bounding box.
      return Array.from({ length: 32 }, (_, i) => i * Math.PI / 16).some(angle => {
        const point = new DOMPoint(rect.left + rect.width / 2 + Math.cos(angle) * rect.width / 2, rect.top + rect.height / 2 + Math.sin(angle) * rect.height / 2).matrixTransform(inverse);
        return !shell.isPointInFill(point);
      });
    });
  });
  expect(outside).toEqual([]);
}

test('editor maps buttons, persists drafts, imports profiles, and explains offline writes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'BEITONG REMAP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to controller' })).toBeDisabled();
  await page.getByRole('button', { name: 'Map A', exact: true }).click();
  await page.getByLabel('SEND THIS INSTEAD').selectOption('1');
  await expect(page.locator('#changes')).toHaveText('1 CHANGE');
  await page.reload();
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('1');
  await page.getByRole('button', { name: 'Action backkey', exact: true }).click();
  await page.getByRole('button', { name: 'Map M1', exact: true }).click();
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('0');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: false }).first().click();
  expect((await download).suggestedFilename()).toBe('beitong-layout.json');
  await page.locator('#import-file').setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, name: '<img src=x onerror=alert(1)>', mappings: { A: 2 } })) });
  await expect(page.getByLabel('Layout name')).toHaveValue('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"name":"bad","mappings":{"A":254}}') });
  await expect(page.locator('#notice')).toContainText('Invalid mapping');
  expect(errors).toEqual([]);
});

test('mobile editor fits the viewport and supports keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Map A', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Map A', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Physical button')).toHaveValue('A');
});

test('controller stick caps follow selected gamepad axes and reset when input disappears', async ({ page }) => {
  await page.addInitScript(() => {
    const pads = [
      { index: 0, id: 'BEITONG A1N3 XINPUT', mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) },
      { index: 1, id: 'Second gamepad', mapping: 'standard', axes: [-1, 1, 1, -1], buttons: [] },
    ];
    Object.assign(window, { stickTestPads: pads });
    Object.defineProperty(navigator, 'getGamepads', { value: () => pads, configurable: true });
  });
  await page.goto('/');
  const capOffsets = () => page.evaluate(() => ['LS', 'RS'].map(key => {
    const socket = document.querySelector(`.key-${key}`)!.getBoundingClientRect();
    const cap = document.querySelector(`.key-${key} .stick-cap`)!.getBoundingClientRect();
    // Measure actual rendered movement relative to the fixed socket.
    return {
      x: Math.round(((cap.left + cap.width / 2) - (socket.left + socket.width / 2)) / cap.width * 100) / 100,
      y: Math.round(((cap.top + cap.height / 2) - (socket.top + socket.height / 2)) / cap.height * 100) / 100,
    };
  }));
  await expect.poll(capOffsets).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  await page.evaluate(() => {
    const pads = (window as unknown as { stickTestPads: { axes: number[]; buttons: { pressed: boolean }[] }[] }).stickTestPads;
    pads[0].axes = [0.8, -0.4, -1, 1];
    pads[0].buttons[10].pressed = true;
  });
  await expect.poll(capOffsets).toEqual([{ x: 0.2, y: -0.1 }, { x: -0.25, y: 0.25 }]);
  await expect(page.getByRole('button', { name: 'Map LS', exact: true })).toHaveClass(/pressed/);
  await page.getByRole('button', { name: 'Map LS', exact: true }).click();
  await expect(page.getByLabel('Physical button')).toHaveValue('LS');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(capOffsets).toEqual([{ x: 0.2, y: -0.1 }, { x: -0.25, y: 0.25 }]);
  await expectNoScrolling(page);
  await page.getByLabel('Live input controller').selectOption('1');
  await expect.poll(capOffsets).toEqual([{ x: -0.25, y: 0.25 }, { x: 0.25, y: -0.25 }]);
  await page.evaluate(() => {
    const pads = (window as unknown as { stickTestPads: { axes: number[]; mapping: string }[] }).stickTestPads;
    pads[1].mapping = '';
  });
  await expect.poll(capOffsets).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  await page.evaluate(() => {
    const pads = (window as unknown as { stickTestPads: { axes: number[]; mapping: string }[] }).stickTestPads;
    pads[1].mapping = 'standard';
    pads[1].axes = [NaN, Infinity, 2, -2];
  });
  await expect.poll(capOffsets).toEqual([{ x: 0, y: 0 }, { x: 0.25, y: -0.25 }]);
  await page.evaluate(() => (window as unknown as { stickTestPads: unknown[] }).stickTestPads.splice(0));
  await expect.poll(capOffsets).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  await expect(page.getByRole('button', { name: 'Map LS', exact: true })).not.toHaveClass(/pressed/);
});

test('triggers grow independently with analog pressure and reset for unavailable input', async ({ page }) => {
  await page.addInitScript(() => {
    const pads = [
      { index: 0, id: 'BEITONG A1N3 XINPUT', mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })) },
      { index: 1, id: 'Second gamepad', mapping: 'standard', axes: [], buttons: Array.from({ length: 17 }, (_, i) => ({ value: i === 6 ? 1 : 0, pressed: i === 6 })) },
    ];
    Object.assign(window, { triggerTestPads: pads });
    Object.defineProperty(navigator, 'getGamepads', { value: () => pads, configurable: true });
  });
  await page.goto('/');
  const sizes = () => page.evaluate(() => ['LT', 'RT'].map(key => {
    const rect = document.querySelector(`.key-${key}`)!.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  const base = await sizes();
  const growth = async () => (await sizes()).map((size, i) => Math.round(size.height / base[i].height * 100) / 100);
  await page.evaluate(() => {
    const pads = (window as unknown as { triggerTestPads: { buttons: { value: number; pressed: boolean }[] }[] }).triggerTestPads;
    pads[0].buttons[6].value = 0.25;
    pads[0].buttons[7] = { value: 1, pressed: true };
  });
  await expect.poll(growth).toEqual([1.25, 2]);
  expect((await sizes()).map(size => size.width)).toEqual(base.map(size => size.width));
  await expect(page.getByRole('button', { name: 'Map LT', exact: true })).not.toHaveClass(/pressed/);
  await expect(page.getByRole('button', { name: 'Map RT', exact: true })).toHaveClass(/pressed/);
  await page.getByRole('button', { name: 'Map RT', exact: true }).click();
  await expect(page.getByLabel('Physical button')).toHaveValue('RT');
  await expectNoScrolling(page);
  await page.getByLabel('Live input controller').selectOption('1');
  await expect.poll(growth).toEqual([2, 1]);
  await page.evaluate(() => {
    const pads = (window as unknown as { triggerTestPads: { buttons: { value: number }[]; mapping: string }[] }).triggerTestPads;
    pads[1].mapping = '';
  });
  await expect.poll(growth).toEqual([1, 1]);
  await page.evaluate(() => {
    const pads = (window as unknown as { triggerTestPads: { buttons: { value: number }[]; mapping: string }[] }).triggerTestPads;
    pads[1].mapping = 'standard';
    pads[1].buttons[6].value = NaN;
    pads[1].buttons[7].value = Infinity;
  });
  await expect.poll(growth).toEqual([1, 1]);
  await page.evaluate(() => {
    const pads = (window as unknown as { triggerTestPads: { buttons: { value: number }[] }[] }).triggerTestPads;
    pads[1].buttons[6].value = -1;
    pads[1].buttons[7].value = 2;
  });
  await expect.poll(growth).toEqual([1, 2]);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expectNoScrolling(page);
    await expectControlsOnShell(page);
    const geometry = await page.evaluate(() => {
      const lt = document.querySelector('.key-LT')!.getBoundingClientRect();
      const rt = document.querySelector('.key-RT')!.getBoundingClientRect();
      const stage = document.querySelector('.controller-stage')!.getBoundingClientRect();
      const lb = document.querySelector('.key-LB')!.getBoundingClientRect();
      const rb = document.querySelector('.key-RB')!.getBoundingClientRect();
      return { growth: Math.round(rt.height / lt.height * 100) / 100, fits: lt.top >= stage.top && rt.top >= stage.top && lt.bottom < lb.top && rt.bottom < rb.top };
    });
    expect(geometry).toEqual({ growth: 2, fits: true });
  }
  await page.evaluate(() => (window as unknown as { triggerTestPads: unknown[] }).triggerTestPads.splice(0));
  await expect.poll(async () => {
    const [lt, rt] = await sizes();
    return Math.round(rt.height / lt.height * 100) / 100;
  }).toBe(1);
  await expect(page.getByRole('button', { name: 'Map LT', exact: true })).not.toHaveClass(/pressed/);
});

for (const viewport of [
  { width: 1440, height: 900 }, { width: 1280, height: 720 },
  { width: 1024, height: 600 }, { width: 768, height: 1024 },
  { width: 390, height: 844 }, { width: 360, height: 640 },
  { width: 320, height: 568 }, { width: 844, height: 390 },
]) {
  test(`editor requires no scrolling at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expectNoScrolling(page);
    await expectControlsOnShell(page);
    await page.getByRole('button', { name: 'Connect receiver' }).click();
    await expect(page.locator('#notice')).toContainText('Turn on the controller');
    await expectNoScrolling(page);
    await page.getByLabel('Physical button').selectOption('M1');
    await page.getByLabel('SEND THIS INSTEAD').selectOption('0');
    await expect(page.locator('#changes')).toHaveText('1 CHANGE');
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expectNoScrolling(page);
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply settings', exact: true })).toBeDisabled();
    for (const name of ['General', 'Sticks', 'Triggers', 'Lighting']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expectNoScrolling(page);
      await page.mouse.wheel(0, 600);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    }
    await page.getByRole('tab', { name: 'Remap', exact: true }).click();
    await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('0');
  });
}

test('receiver errors are actionable and do not pretend to connect', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect receiver' }).click();
  await expect(page.locator('#notice')).toContainText('Turn on the controller');
  await expect(page.locator('#connection-status')).toHaveText('Not connected');
  await expect(page.locator('#apply')).toBeDisabled();
});

for (const variant of [{ productId: 0x505b, slot: 1 }, { productId: 0x507f, slot: 2 }]) {
  test(`advanced exposes model capabilities for ${variant.productId.toString(16)} slot ${variant.slot}`, async ({ page }) => {
    await page.addInitScript(({ productId, slot }) => {
      const legacy = productId === 0x505b;
      class ReadOnlyHid extends EventTarget {
        opened = false; vendorId = 0x20bc; productId = productId;
        collections = [{ children: [], outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }], inputReports: [{ reportId: 3, items: [{ reportSize: 8, reportCount: 63 }] }] }];
        async open() { this.opened = true; }
        async close() { this.opened = false; }
        async sendReport(_reportId: number, packet: Uint8Array) {
          const data = legacy ? packet : packet.slice(1);
          if (!data[0] && !data[1]) return;
          const command = data[2];
          let params: number[];
          if (command === 0x10) params = [slot, 5, 1, 90, 0, 0];
          else if (command === 0x22) params = [0, legacy ? 21 : 33, slot, ...Array(legacy ? 21 : 33).fill(255)];
          else if (command === 0x20) params = [slot, ...(legacy ? [0, 7, 4, 2, 2, 2, 8, 0, 10] : [0, 7, 4, 2, 2, 2, 0, 10, 0, 10, 100, 5, 100, 5, 100, 0, 100, 0, 0, 0, 0])];
          else if (command === 0x26 || command === 0x28) params = [slot, 10, 1, 255, 0, 30, 30, 110, 74, 128, 128, ...(legacy ? [] : [0, 1])];
          else throw new Error('Read-only mock received an unexpected write.');
          const response = new Uint8Array(63); response.set([...(legacy ? [] : [0x90]), data[0], data[1], command, ...params]);
          queueMicrotask(() => { const event = new Event('inputreport'); Object.assign(event, { reportId: 3, data: new DataView(response.buffer) }); this.dispatchEvent(event); });
        }
      }
      Object.defineProperty(navigator, 'hid', { value: Object.assign(new EventTarget(), { requestDevice: async () => [new ReadOnlyHid()] }), configurable: true });
    }, variant);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose configuration HID' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    // Keyboard navigation selects the tab and triggers the same lazy read.
    await page.getByRole('tab', { name: 'Remap', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Advanced', exact: true })).toBeFocused();
    await expect(page.getByLabel('Left motor', { exact: true })).toHaveValue('2');
    if (variant.productId === 0x505b) await expect(page.getByLabel('Pro mode', { exact: true })).toHaveCount(0);
    else await expect(page.getByLabel('Pro mode', { exact: true })).toBeDisabled();
    await expectNoScrolling(page);
    await page.getByRole('button', { name: 'Sticks', exact: true }).click();
    if (variant.productId === 0x505b) await expect(page.getByLabel('Left stick pro deadzone', { exact: true })).toHaveCount(0);
    else await expect(page.getByLabel('Left stick pro deadzone', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Left stick deadzone', { exact: true })).toBeEnabled();
    await expectNoScrolling(page);
    await page.getByRole('button', { name: 'Triggers', exact: true }).click();
    if (variant.productId === 0x505b) await expect(page.getByLabel('Trigger deadzone', { exact: true })).toHaveValue('0');
    else await expect(page.getByLabel('LT quick trigger', { exact: true })).toBeEnabled();
    await expectNoScrolling(page);
  });
}

test('receiver flow reads, applies, exports the saved layout, and handles unplugging', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { rumble: [] as number[][], commands: [] as number[], saved: false, denyOpen: true, map: Array(33).fill(255) as number[], blocks: {
      base: [0, 7, 4, 2, 2, 2, 0, 10, 0, 10, 100, 5, 100, 5, 100, 0, 100, 0, 0, 0, 0],
      left: [10, 1, 255, 0, 30, 30, 110, 74, 128, 128, 0, 1],
      right: [12, 1, 255, 0, 30, 30, 110, 74, 128, 128, 1, 1],
    } };
    state.map[9] = 254; // Existing macro, outside the profile editor's scope.
    state.map[21] = 17; // Sensor entry must survive button edits.
    class Receiver extends EventTarget {
      opened = false;
      vendorId = 0x20bc;
      productId = 0x507f;
      productName = 'Mock receiver';
      collections = [{ children: [], outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 63 }] }], inputReports: [{ reportId: 3, items: [{ reportSize: 8, reportCount: 63 }] }] }];
      async open() {
        if (state.denyOpen) throw new DOMException('Failed to open the device.', 'NotAllowedError');
        this.opened = true;
      }
      async close() { this.opened = false; }
      async sendReport(reportId: number, packet: Uint8Array) {
        if (reportId !== 2 || packet[0] !== 0x90 || packet.length !== 63) throw new Error('Incorrect receiver transport');
        const data = packet.slice(1);
        const command = data[2];
        if (!data[0] && !data[1]) return;
        state.commands.push(command);
        let parameters: number[] = [];
        if (command === 0x10) parameters = [1, 5, 1, 100, 0, 0];
        if (command === 0x22 || command === 0x23) {
          if (command === 0x23) state.map = Array.from(data.slice(6, 39));
          parameters = [0, 33, 1, ...state.map];
        }
        if (command === 0xa0) state.saved = true;
        const block = ({ 0x20: 'base', 0x21: 'base', 0x26: 'left', 0x27: 'left', 0x28: 'right', 0x29: 'right' } as const)[command as 0x20];
        if (block) {
          if (command & 1) state.blocks[block] = Array.from(data.slice(4, 4 + state.blocks[block].length));
          else parameters = [1, ...state.blocks[block]];
        }
        const response = new Uint8Array(63);
        response.set([0x90, data[0], data[1], command, ...parameters]);
        queueMicrotask(() => {
          const event = new Event('inputreport');
          Object.assign(event, { reportId: 3, data: new DataView(response.buffer) });
          this.dispatchEvent(event);
        });
      }
    }
    const receiver = new Receiver();
    let chooserAttempts = 0;
    const hid = Object.assign(new EventTarget(), { requestDevice: async () => {
      if (state.rumble.length !== 14) throw new Error('Receiver has not switched');
      if (++chooserAttempts === 1) return []; // Empty chooser / cancelled selection.
      return [receiver];
    } });
    Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
    Object.defineProperty(navigator, 'getGamepads', { value: () => [{
      index: 0, id: 'BEITONG A1N3 XINPUT DONGLE (Vendor: 045e Product: 028e)', mapping: 'standard',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
      vibrationActuator: {
        playEffect: async (_type: string, p: { strongMagnitude: number; weakMagnitude: number }) => {
          state.rumble.push([Math.trunc(p.strongMagnitude * 65535) >> 8, Math.trunc(p.weakMagnitude * 65535) >> 8]);
          return 'preempted';
        }, reset: async () => 'complete',
      },
    }], configurable: true });
    Object.assign(window, { receiverTestState: state, unplugReceiver: () => {
      const event = new Event('disconnect'); Object.assign(event, { device: receiver }); hid.dispatchEvent(event);
    } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Live input controller')).toContainText('BEITONG');
  await expect(page.locator('#connection-status')).toHaveText('Input only');
  await page.getByRole('button', { name: 'Map A', exact: true }).click();
  await page.getByLabel('SEND THIS INSTEAD').selectOption('1');
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#save-detail')).toHaveText('Connect receiver, then choose HID.');
  await page.getByRole('button', { name: 'Connect receiver' }).click();
  await expect(page.locator('#notice')).toContainText('Mode-switch sequence sent');
  await expect(page.locator('#connection-status')).toHaveText('Choose HID');
  await expect(page.locator('#save-detail')).toHaveText('Choose HID to read the onboard map.');
  await expect(page.locator('#apply')).toBeDisabled();
  await page.getByRole('button', { name: 'Choose configuration HID' }).click();
  await expect(page.locator('#notice')).toContainText('Receiver switching is unconfirmed');
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('1');
  await expect(page.locator('#apply')).toBeDisabled();
  await page.getByRole('button', { name: 'Choose configuration HID' }).click();
  await expect(page.locator('#notice')).toContainText('Cannot open 20bc:507f');
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('1');
  await expect(page.locator('#apply')).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { receiverTestState: { denyOpen: boolean } }).receiverTestState.denyOpen = false; });
  await page.getByRole('button', { name: 'Choose configuration HID' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('1');
  await expect(page.locator('#apply')).toBeEnabled();
  const backup = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Apply to controller' }).click();
  expect((await backup).suggestedFilename()).toBe('beitong-before-apply.json');
  await expect(page.locator('#save-state')).toHaveText('Save acknowledged');
  await expect(page.locator('#apply')).toBeDisabled();
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expectNoScrolling(page);
  }
  const state = await page.evaluate(() => (window as unknown as { receiverTestState: { rumble: number[][]; commands: number[]; map: number[]; saved: boolean } }).receiverTestState);
  expect(state.rumble).toEqual(RECEIVER_SEQUENCE);
  expect(state.commands).toEqual([0x10, 0x22, 0x10, 0x22, 0x23, 0x10, 0xa0, 0x22]);
  expect(state.saved).toBe(true);
  expect([state.map[0], state.map[9], state.map[21]]).toEqual([1, 254, 17]);
  const exported = page.waitForEvent('download');
  await page.locator('#export').click();
  const exportPath = await (await exported).path();
  expect(exportPath).not.toBeNull();
  const profile = JSON.parse(await readFile(exportPath!, 'utf8'));
  expect(profile.mappings.A).toBe(1);
  expect(profile.mappings.LB).toBeUndefined();
  await page.getByLabel('Physical button').selectOption('B');
  await page.getByLabel('SEND THIS INSTEAD').selectOption('0'); // Remap draft remains separate.
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Left motor', { exact: true })).toHaveValue('2');
  await page.getByLabel('Left motor', { exact: true }).selectOption('4');
  await page.getByLabel('Pro mode', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Sticks', exact: true }).click();
  await page.getByLabel('Left stick pro deadzone', { exact: true }).fill('3');
  await page.getByLabel('Left stick pro deadzone', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Triggers', exact: true }).click();
  await page.getByLabel('LT start', { exact: true }).fill('95');
  await page.getByLabel('LT start', { exact: true }).press('Tab');
  await expect(page.locator('#advanced-apply')).toBeDisabled();
  await page.getByRole('button', { name: 'General', exact: true }).click(); // Hidden invalid edits still block Apply.
  await expect(page.locator('#advanced-apply')).toBeDisabled();
  await page.getByRole('button', { name: 'Triggers', exact: true }).click();
  await page.getByLabel('LT start', { exact: true }).fill('8');
  await page.getByLabel('LT start', { exact: true }).press('Tab');
  await page.getByLabel('LT quick trigger', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  await page.getByLabel('Light effect', { exact: true }).selectOption('1');
  const advancedBackup = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
  const backupPath = await (await advancedBackup).path();
  const raw = JSON.parse(await readFile(backupPath!, 'utf8'));
  expect(raw.settings.base[4]).toBe(2);
  expect(raw.rawMap[0]).toBe(1);
  await expect(page.locator('#advanced-save-state')).toHaveText('Save acknowledged');
  const advancedState = await page.evaluate(() => (window as unknown as { receiverTestState: { map: number[]; blocks: { base: number[]; left: number[]; right: number[] } } }).receiverTestState);
  expect(advancedState.map).toEqual(state.map);
  expect([advancedState.blocks.base[0], advancedState.blocks.base[4], advancedState.blocks.base[11], advancedState.blocks.base[18], advancedState.blocks.base[19], advancedState.blocks.left[10]]).toEqual([1, 4, 8, 1, 1, 3]);
  expect(advancedState.blocks.right).toEqual([12, 1, 255, 0, 30, 30, 110, 74, 128, 128, 1, 1]);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['General', 'Sticks', 'Triggers', 'Lighting']) { await page.getByRole('button', { name, exact: true }).click(); await expectNoScrolling(page); }
  }
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Left motor', { exact: true }).selectOption('3');
  const writesBeforeConflict = await page.evaluate(() => {
    const state = (window as unknown as { receiverTestState: { blocks: { right: number[] }; commands: number[] } }).receiverTestState;
    state.blocks.right[5] = 99;
    return state.commands.filter(c => [0x21, 0x27, 0x29, 0xa0].includes(c)).length;
  });
  await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('settings changed since the last read');
  await expect(page.locator('#advanced-save-state')).toHaveText('Read required');
  expect(await page.evaluate(() => (window as unknown as { receiverTestState: { commands: number[] } }).receiverTestState.commands.filter(c => [0x21, 0x27, 0x29, 0xa0].includes(c)).length)).toBe(writesBeforeConflict);
  await page.getByRole('button', { name: 'Read settings', exact: true }).click();
  await expect(page.getByLabel('Left motor', { exact: true })).toHaveValue('3');
  await expect(page.locator('#advanced-apply')).toBeEnabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Left motor', { exact: true })).toHaveValue('4');
  await page.getByRole('tab', { name: 'Remap', exact: true }).click();
  await expect(page.getByLabel('Physical button')).toHaveValue('B');
  await expect(page.getByLabel('SEND THIS INSTEAD')).toHaveValue('0');
  await page.getByRole('button', { name: 'Action backkey', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText('Editor draft');
  await page.evaluate(() => (window as unknown as { unplugReceiver: () => void }).unplugReceiver());
  await expect(page.locator('#connection-status')).toHaveText('Input only');
  await expect(page.locator('#apply')).toBeDisabled();
});
