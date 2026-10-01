import './style.css';
import { Controller } from './controller.ts';
import type { AdvancedSnapshot, Snapshot } from './controller.ts';
import { patchSettings, settingsFor } from './advanced.ts';
import type { Category, Setting, SettingsEdits } from './advanced.ts';
import { DEFAULT, DISABLED, MODELS, SOURCE_KEYS, TARGET_KEYS, mappingLabel } from './protocol.ts';
import type { SourceKey } from './protocol.ts';
import { PRESETS, validateProfile } from './profiles.ts';
import type { Profile } from './profiles.ts';
import { isXboxReceiver, switchReceiver } from './receiver.ts';
import type { RumbleActuator } from './receiver.ts';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
};
let controller: Controller | undefined;
let snapshot: Snapshot | undefined;
let selected: SourceKey = 'A';
let draft: Profile = { version: 1, name: 'My layout', mappings: {} };
let busy = false;
let liveInputAvailable = false;
let receiverSwitchSent = false;
let saveAcknowledged = false;
let activeGamepadIndex: number | undefined;
let activeTab: 'remap' | 'advanced' = 'remap';
let category: Category = 'general';
let advancedSnapshot: AdvancedSnapshot | undefined;
let advancedDraft: SettingsEdits = {};
let advancedSaved = false;
let advancedContext = '';
let advancedFieldsKey = '';
const storageKey = 'beitong-remap.profile.v1';

$('#app').innerHTML = `
  <header class="topbar"><h1>BEITONG <span>REMAP</span></h1><nav class="mode-tabs" role="tablist" aria-label="Configuration"><button id="tab-remap" role="tab" aria-selected="true" aria-controls="remap-view">Remap</button><button id="tab-advanced" role="tab" aria-selected="false" aria-controls="advanced-view" tabindex="-1">Advanced</button></nav><span id="connection-status" class="badge">Not connected</span></header>
  <main>
    <section class="connection panel" aria-label="Controller connection">
      <div class="connection-copy"><h2 id="device-name">Asura 2 Pro</h2><p id="device-detail">Turn on the controller and press a button.</p></div>
      <div id="gamepad-picker"></div>
      <div class="connection-actions"><button id="receiver-connect" class="primary">Connect receiver</button><button id="hid-connect" aria-label="Choose configuration HID">Choose HID</button><button id="disconnect" disabled>Disconnect</button></div>
    </section>
    <p id="notice" class="notice" role="status" aria-live="polite">Connect the receiver, then choose its configuration HID.</p>
    <div id="remap-view" class="workspace" role="tabpanel" aria-labelledby="tab-remap">
      <section class="panel controller-panel" aria-label="Controller buttons">
        <div class="panel-heading"><h2>Pick a button</h2><span id="slot-label" class="muted">Onboard slot —</span></div>
        <div class="controller-view"><div class="controller-stage"><svg class="controller-shape" viewBox="0 0 600 430" aria-hidden="true"><defs><linearGradient id="shell" x1="0" y1="0" x2="0.4" y2="1"><stop stop-color="#43494c"/><stop offset="1" stop-color="#202629"/></linearGradient><linearGradient id="grip"><stop stop-color="#232a2d"/><stop offset="1" stop-color="#30373b"/></linearGradient></defs><path d="M153 97 C193 68 218 79 251 85 L349 85 C382 79 407 68 447 97 C481 119 506 157 516 209 L548 341 C558 393 514 415 482 382 L393 304 L207 304 L118 382 C86 415 42 393 52 341 L84 209 C94 157 119 119 153 97Z" fill="url(#shell)" stroke="#50585d" stroke-width="2"/><path d="M85 235 L52 341 C42 393 86 415 118 382 L206 304 L155 234Z" fill="url(#grip)"/><path d="M515 235 L548 341 C558 393 514 415 482 382 L394 304 L445 234Z" fill="url(#grip)"/><path d="M208 303 Q300 325 392 303" fill="none" stroke="#555e62"/><path d="M167 95 Q195 82 224 90 M376 90 Q405 82 433 95" stroke="#6f777a" stroke-width="3" fill="none"/></svg><div id="controller-buttons"></div></div></div>
        <div class="controller-footer"><span id="input-status">Waiting for controller input</span><span class="muted">● Remapped</span></div>
      </section>
      <section class="panel mapping-panel" aria-label="Button mapping">
        <div class="panel-heading"><h2>Button mapping</h2><div class="heading-tools"><span id="changes" class="badge">0 CHANGES</span><button id="read" aria-label="Read controller" disabled>Read</button></div></div>
        <div class="mapping-editor">
          <div class="source-box"><label for="source">BUTTON</label><select id="source" aria-label="Physical button"></select></div>
          <span class="mapping-arrow" aria-hidden="true">→</span>
          <div class="target-box"><label for="target">SEND THIS INSTEAD</label><select id="target"></select></div>
        </div>
        <div class="preset-row" aria-label="Mapping presets"><button data-preset="swap">Swap AB / XY</button><button data-preset="action">Action backkey</button><button data-preset="shooter">Shooter backkey</button><button data-preset="classic" title="M1 → LS click · M2 → RS click">Classic Backkey</button><button data-preset="soul" title="M1 → B · M2 → RS click">Soul backkey</button><button id="reset">Default layout</button></div>
        <div class="profile-tools"><label for="profile-name">Layout name<input id="profile-name" maxlength="64" value="My layout" /></label><div><button id="import">Import</button><button id="export">Export</button><input id="import-file" type="file" accept="application/json,.json" hidden /></div></div>
        <div class="apply-footer"><div><strong id="save-state">Configuration required</strong><p id="save-detail">Connect receiver, then choose HID.</p></div><button id="apply" class="primary" aria-describedby="save-detail" disabled>Apply to controller</button></div>
      </section>
    </div>
    <section id="advanced-view" class="panel advanced-panel" role="tabpanel" aria-labelledby="tab-advanced" hidden>
      <div class="panel-heading"><h2>Advanced</h2><div class="heading-tools"><span id="advanced-changes" class="badge">0 CHANGES</span><button id="advanced-read" disabled>Read settings</button></div></div>
      <nav class="advanced-tabs" aria-label="Advanced settings categories">${(['general', 'sticks', 'triggers', 'lighting'] as const).map(name => `<button data-category="${name}" aria-pressed="${name === category}">${name[0].toUpperCase() + name.slice(1)}</button>`).join('')}</nav>
      <p id="advanced-hint" class="muted">Read settings to load onboard values.</p>
      <div id="advanced-fields" class="advanced-fields"></div>
      <div class="apply-footer"><div><strong id="advanced-save-state">Configuration required</strong><p id="advanced-save-detail">Connect receiver, then choose HID.</p></div><div class="advanced-actions"><button id="advanced-discard" disabled>Discard</button><button id="advanced-apply" class="primary" aria-describedby="advanced-save-detail" disabled>Apply settings</button></div></div>
    </section>
  </main>`;

const positions: Record<SourceKey, [number, number]> = {
  LT: [23, 7], RT: [77, 7], LB: [23, 20], RB: [77, 20],
  LS: [26, 43], RS: [62, 61], A: [77, 51], B: [85, 40], X: [69, 40], Y: [77, 29],
  Up: [36, 57], Down: [36, 73], Left: [30, 65], Right: [42, 65],
  Back: [43, 39], Start: [57, 39], Home: [50, 30], Turbo: [43, 49], Shift: [57, 49], M1: [18, 83], M2: [82, 83],
};
const glyphs: Partial<Record<SourceKey, string>> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Back: '▱', Start: '☰', Home: 'b' };
$('#controller-buttons').innerHTML = SOURCE_KEYS.map(key => {
  const [x, y] = positions[key];
  const content = key === 'LS' || key === 'RS' ? `<span class="stick-cap" aria-hidden="true">${key}</span>` : glyphs[key] ?? key;
  return `<button class="pad-button key-${key}" data-key="${key}" style="left:${x}%;top:${y}%" aria-label="Map ${key}">${content}</button>`;
}).join('');
const gamepadKeys: SourceKey[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
const liveSticks = [
  { cap: $('.key-LS .stick-cap'), axis: 0 },
  { cap: $('.key-RS .stick-cap'), axis: 2 },
];

function notice(message: string, error = false): void {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}
function saveLocal(): void {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { notice('Browser storage is unavailable. Export your layout to keep a copy.', true); }
}
function stageDraft(): void {
  saveLocal();
  saveAcknowledged = false;
  render();
}
function currentValue(key: SourceKey): number {
  return draft.mappings[key] ?? snapshot?.map[SOURCE_KEYS.indexOf(key)] ?? DEFAULT;
}
function render(): void {
  const sourceSelect = $<HTMLSelectElement>('#source');
  sourceSelect.replaceChildren(...SOURCE_KEYS.map(key => new Option(key, key)));
  sourceSelect.value = selected;
  document.querySelectorAll<HTMLButtonElement>('.pad-button').forEach(button => {
    const key = button.dataset.key as SourceKey;
    button.classList.toggle('selected', key === selected);
    button.classList.toggle('remapped', currentValue(key) !== DEFAULT);
    button.setAttribute('aria-pressed', String(key === selected));
    button.title = `${key} → ${mappingLabel(currentValue(key), key)}`;
  });
  const target = $<HTMLSelectElement>('#target');
  target.replaceChildren();
  const options: [number, string][] = [[DEFAULT, `${selected} · default`], ...TARGET_KEYS.map((name, index): [number, string] => [index, name]), [DISABLED, 'Disabled']];
  const value = currentValue(selected);
  if (!options.some(([n]) => n === value)) options.push([value, mappingLabel(value, selected)]);
  for (const [n, label] of options) { const option = new Option(label, String(n)); target.add(option); }
  target.value = String(value);
  const changed = Object.entries(draft.mappings).filter(([key, v]) => v !== (snapshot?.map[SOURCE_KEYS.indexOf(key as SourceKey)] ?? DEFAULT)).length;
  $('#changes').textContent = `${changed} CHANGE${changed === 1 ? '' : 'S'}`;
  const apply = $<HTMLButtonElement>('#apply');
  apply.disabled = busy || !controller || !snapshot || changed === 0;
  let state: string;
  let detail: string;
  if (busy) {
    state = 'Working…'; detail = 'Waiting for the controller operation to finish.';
  } else if (!controller) {
    state = 'Configuration required';
    detail = receiverSwitchSent ? 'Choose HID to read the onboard map.' : 'Connect receiver, then choose HID.';
  } else if (!snapshot) {
    state = 'Read required'; detail = 'Click Read before applying changes.';
  } else if (saveAcknowledged && changed === 0) {
    state = 'Save acknowledged'; detail = 'Readback matches. Power-cycle to verify persistence.';
  } else {
    state = 'Editor draft';
    detail = changed > 0 ? `Ready to save ${changed} change${changed === 1 ? '' : 's'} to slot ${snapshot.slot}.` : 'No changes to apply.';
  }
  $('#save-state').textContent = state;
  $('#save-detail').textContent = detail;
  apply.title = detail;
  $<HTMLButtonElement>('#read').disabled = busy || !controller;
  $<HTMLButtonElement>('#disconnect').disabled = busy || !controller;
  $<HTMLButtonElement>('#receiver-connect').disabled = busy || Boolean(controller);
  $<HTMLButtonElement>('#hid-connect').disabled = busy || Boolean(controller) || !('hid' in navigator) || !isSecureContext;
  $('#receiver-connect').classList.toggle('primary', !controller && !receiverSwitchSent);
  $('#hid-connect').classList.toggle('primary', !controller && receiverSwitchSent);
  $<HTMLButtonElement>('#target').disabled = busy;
  $<HTMLButtonElement>('#reset').disabled = busy;
  $<HTMLButtonElement>('#import').disabled = busy;
  $<HTMLSelectElement>('#source').disabled = busy;
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => { button.disabled = busy; });
  $('#connection-status').textContent = controller ? snapshot ? 'Connected' : 'Read required' : receiverSwitchSent ? 'Choose HID' : liveInputAvailable ? 'Input only' : 'Not connected';
  $('#connection-status').classList.toggle('connected', Boolean(controller && snapshot));
  $('#slot-label').textContent = snapshot ? `Onboard slot ${snapshot.slot}` : 'Onboard slot —';
  renderAdvanced();
}
function advancedValue(field: Setting): number | undefined {
  return advancedDraft[field.id] ?? advancedSnapshot?.blocks[field.block][field.index];
}
function renderAdvanced(): void {
  const model = controller?.model ?? MODELS[4];
  const fields = settingsFor(model);
  const key = `${model.productId}:${category}`;
  if (key !== advancedFieldsKey) {
    advancedFieldsKey = key;
    const visible = fields.filter(field => field.category === category);
    $('#advanced-fields').replaceChildren();
    const groups = category === 'sticks' ? ['left', 'right'] : category === 'triggers' && model.keymapSize === 33 ? ['LT', 'RT'] : [''];
    for (const group of groups) {
      const card = document.createElement('div'); card.className = 'settings-card';
      if (group) { const title = document.createElement('h2'); title.textContent = category === 'sticks' ? `${group === 'left' ? 'Left' : 'Right'} stick` : `${group} trigger`; card.append(title); }
      for (const field of visible.filter(f => !group || (category === 'sticks' ? f.block === group : f.label.startsWith(group)))) {
        const row = document.createElement('label'); row.className = 'setting-row'; row.htmlFor = `setting-${field.id}`;
        const label = document.createElement('span'); label.textContent = group && category === 'triggers' ? field.label.slice(3) : field.label;
        const control = field.options ? document.createElement('select') : document.createElement('input');
        control.id = row.htmlFor; control.dataset.setting = field.id;
        control.setAttribute('aria-label', category === 'sticks' ? `${group === 'left' ? 'Left' : 'Right'} stick ${field.label.toLowerCase()}` : field.label);
        if (control instanceof HTMLSelectElement) {
          control.add(new Option('—', ''));
          field.options!.forEach((label, index) => control.add(new Option(label, String(field.min + index))));
        } else { control.type = 'number'; control.min = String(field.min); control.max = String(field.max); control.step = '1'; control.placeholder = '—'; }
        const input = document.createElement('div'); input.className = 'setting-value'; input.append(control);
        if (field.unit) { const unit = document.createElement('span'); unit.textContent = field.unit; input.append(unit); }
        row.append(label, input); card.append(row);
      }
      $('#advanced-fields').append(card);
    }
  }
  let changed = 0;
  for (const field of fields) {
    if (Object.hasOwn(advancedDraft, field.id) && advancedDraft[field.id] !== advancedSnapshot?.blocks[field.block][field.index]) changed++;
    const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting="${field.id}"]`);
    if (!control) continue;
    const value = advancedValue(field);
    if (control instanceof HTMLSelectElement) {
      control.querySelector('[data-existing]')?.remove();
      if (value !== undefined && Number.isFinite(value) && !Array.from(control.options).some(o => o.value === String(value))) {
        const option = new Option(`Existing (${value})`, String(value)); option.dataset.existing = 'true'; option.disabled = true; control.add(option);
      }
    }
    if (control !== document.activeElement) control.value = value === undefined || !Number.isFinite(value) ? '' : String(value);
    control.disabled = busy || !advancedSnapshot || Boolean(field.pcOnly && advancedSnapshot.slot !== 1);
  }
  let validation = '';
  if (advancedSnapshot) {
    try { patchSettings(advancedSnapshot.blocks, model, advancedSnapshot.slot, advancedDraft); }
    catch (error) { validation = error instanceof Error ? error.message : String(error); }
  }
  $('#advanced-changes').textContent = `${changed} CHANGE${changed === 1 ? '' : 'S'}`;
  $('#advanced-hint').textContent = !advancedSnapshot ? 'Read settings to load onboard values.'
    : category === 'general' && model.productId >= 0x507e ? `Slot ${advancedSnapshot.slot} · Pro mode applies in PC slot 1; it increases power use.`
    : category === 'sticks' && model.productId >= 0x507e ? 'Pro deadzones apply in PC slot 1 with Pro mode on.'
    : category === 'triggers' && model.keymapSize === 33 ? 'Start and full press need at least 10% separation.'
    : `Onboard slot ${advancedSnapshot.slot} · Changes are saved with Apply settings.`;
  const state = busy ? 'Working…' : !controller ? 'Configuration required' : !advancedSnapshot ? 'Read required' : advancedSaved && changed === 0 ? 'Save acknowledged' : 'Editor draft';
  const detail = busy ? 'Waiting for the controller operation to finish.' : !controller ? receiverSwitchSent ? 'Choose HID to read settings.' : 'Connect receiver, then choose HID.'
    : !advancedSnapshot ? 'Read settings before applying changes.' : validation || (advancedSaved && changed === 0 ? 'Readback matches. Power-cycle to verify persistence.' : changed ? `Ready to save ${changed} change${changed === 1 ? '' : 's'} to slot ${advancedSnapshot.slot}.` : 'No changes to apply.');
  $('#advanced-save-state').textContent = state;
  $('#advanced-save-detail').textContent = detail;
  $<HTMLButtonElement>('#advanced-read').disabled = busy || !controller;
  $<HTMLButtonElement>('#advanced-apply').disabled = busy || !controller || !advancedSnapshot || !changed || Boolean(validation);
  $('#advanced-apply').title = detail;
  $<HTMLButtonElement>('#advanced-discard').disabled = busy || !Object.keys(advancedDraft).length;
  document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
}
function acceptAdvanced(value: AdvancedSnapshot): void {
  const context = `${value.model.productId}:${value.slot}`;
  if (advancedContext && advancedContext !== context) advancedDraft = {};
  advancedContext = context; advancedSnapshot = value; snapshot = value;
}
async function readAdvanced(): Promise<void> {
  if (!controller) return;
  snapshot = undefined; advancedSnapshot = undefined; advancedSaved = false; saveAcknowledged = false;
  acceptAdvanced(await controller.readAdvanced());
  notice('Advanced settings read. Your drafts are preserved.');
}
function showTab(tab: 'remap' | 'advanced'): void {
  activeTab = tab;
  $('#remap-view').hidden = tab !== 'remap'; $('#advanced-view').hidden = tab !== 'advanced';
  for (const name of ['remap', 'advanced'] as const) {
    const button = $<HTMLButtonElement>(`#tab-${name}`);
    button.setAttribute('aria-selected', String(name === tab)); button.tabIndex = name === tab ? 0 : -1;
  }
  render();
  if (tab === 'advanced' && controller && !advancedSnapshot && !busy) void run(readAdvanced);
}
for (const tab of ['remap', 'advanced'] as const) $('#tab-' + tab).addEventListener('click', () => showTab(tab));
$('.mode-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tab = event.key === 'Home' ? 'remap' : event.key === 'End' ? 'advanced' : activeTab === 'remap' ? 'advanced' : 'remap';
  showTab(tab); $('#tab-' + tab).focus();
});
$('.advanced-tabs').addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-category]');
  if (button) { category = button.dataset.category as Category; renderAdvanced(); }
});
$('#advanced-fields').addEventListener('change', event => {
  const control = event.target as HTMLInputElement | HTMLSelectElement;
  if (!control.dataset.setting || busy || !advancedSnapshot) return;
  const value = control.value === '' ? NaN : Number(control.value);
  const field = settingsFor(advancedSnapshot.model).find(f => f.id === control.dataset.setting)!;
  if (value === advancedSnapshot.blocks[field.block][field.index]) delete advancedDraft[field.id];
  else advancedDraft[field.id] = value;
  advancedSaved = false; renderAdvanced();
});
$('#advanced-read').addEventListener('click', () => void run(readAdvanced));
$('#advanced-discard').addEventListener('click', () => { advancedDraft = {}; advancedSaved = false; renderAdvanced(); });
$('#advanced-apply').addEventListener('click', () => void run(async () => {
  if (!controller || !advancedSnapshot) return;
  download('beitong-advanced-before-apply.json', { version: 1, model: advancedSnapshot.model, slot: advancedSnapshot.slot, rawMap: advancedSnapshot.map, settings: advancedSnapshot.blocks, createdAt: new Date().toISOString() });
  const edits = { ...advancedDraft };
  snapshot = undefined; advancedSnapshot = undefined; saveAcknowledged = false;
  acceptAdvanced(await controller.applyAdvanced(edits));
  advancedDraft = {}; advancedSaved = true;
  notice('Advanced save acknowledged; readback matches. Power-cycle to verify persistence.');
}));
async function run(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true; render();
  try { await operation(); } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; render(); }
}
function download(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-key]');
  if (button && !busy) { selected = button.dataset.key as SourceKey; render(); }
  const preset = (event.target as Element).closest<HTMLButtonElement>('[data-preset]');
  if (preset && !busy) {
    Object.assign(draft.mappings, PRESETS[preset.dataset.preset!]);
    stageDraft(); notice('Preset staged. Apply to save it on the controller.');
  }
});
$('#target').addEventListener('change', () => {
  const value = Number($<HTMLSelectElement>('#target').value);
  if (!(value === DEFAULT || value === DISABLED || Number.isInteger(value) && value >= 0 && value < TARGET_KEYS.length)) return;
  draft.mappings[selected] = value;
  stageDraft();
});
$('#profile-name').addEventListener('input', () => { draft.name = $<HTMLInputElement>('#profile-name').value.slice(0, 64) || 'My layout'; saveLocal(); });
$('#source').addEventListener('change', () => { selected = $<HTMLSelectElement>('#source').value as SourceKey; render(); });
$('#reset').addEventListener('click', () => { draft.mappings = { ...PRESETS.default }; stageDraft(); notice('Default buttons staged. Apply to save.'); });
$('#export').addEventListener('click', () => {
  const mappings: Profile['mappings'] = {};
  for (const key of SOURCE_KEYS) {
    const value = currentValue(key);
    if (value === DEFAULT || value === DISABLED || value >= 0 && value < TARGET_KEYS.length) mappings[key] = value;
  }
  download('beitong-layout.json', { ...draft, mappings });
});
$('#import').addEventListener('click', () => $<HTMLInputElement>('#import-file').click());
$('#import-file').addEventListener('change', () => void run(async () => {
  const file = $<HTMLInputElement>('#import-file').files?.[0];
  try {
    if (!file) return;
    if (file.size > 32_768) throw new Error('Profile is too large (maximum 32 KB).');
    draft = validateProfile(JSON.parse(await file.text()));
    $<HTMLInputElement>('#profile-name').value = draft.name;
    stageDraft(); notice('Layout imported into the editor. Apply it to change the controller.');
  } finally { $<HTMLInputElement>('#import-file').value = ''; }
}));
$('#hid-connect').addEventListener('click', () => void run(async () => {
  if (!('hid' in navigator) || !isSecureContext) throw new Error('Use desktop Chrome or Edge on localhost or HTTPS for WebHID.');
  // Chooser stays directly attached to a user gesture.
  const devices = await navigator.hid.requestDevice({ filters: MODELS.map(m => ({ vendorId: 0x20bc, productId: m.productId })) });
  if (!devices.length) {
    notice(receiverSwitchSent ? 'No configuration HID selected. Receiver switching is unconfirmed; your draft is unchanged.' : 'No configuration HID selected. Connect the receiver first; your draft is unchanged.', true);
    return;
  }
  const next = new Controller(devices[0]);
  notice('Reading the controller’s active slot and existing keymap…');
  try {
    snapshot = await next.open();
  } catch (error) {
    if (error instanceof Error && /failed to open|permission denied|access denied/i.test(error.message)) {
      const id = `20bc:${devices[0].productId.toString(16).padStart(4, '0')}`;
      throw new Error(/Linux/i.test(navigator.userAgent)
        ? `Cannot open ${id}. Linux may require the BeiTong HID permission rule; install it from README, then reconnect the receiver.`
        : `Cannot open ${id}. Reconnect the receiver and close other controller configuration apps, then try again.`);
    }
    throw error;
  }
  controller = next;
  $('#device-name').textContent = snapshot.model.name;
  $('#device-detail').textContent = `${devices[0].productName} · 20bc:${devices[0].productId.toString(16)} · slot ${snapshot.slot}`;
  notice('Controller settings read. Your draft is ready to apply.');
  if (activeTab === 'advanced') await readAdvanced();
}));
$('#receiver-connect').addEventListener('click', () => void run(async () => {
  const pad = navigator.getGamepads?.()[activeGamepadIndex ?? -1];
  if (!pad) throw new Error('Turn on the controller, press a button, and select it before connecting.');
  if (!isXboxReceiver(pad.id)) throw new Error('Select the BeiTong Xbox receiver before connecting.');
  const actuator = pad.vibrationActuator as unknown as RumbleActuator | undefined;
  if (!actuator?.playEffect || !actuator.reset) throw new Error('This browser does not expose receiver vibration. Use Chrome or Edge, or enter configuration mode with the recent official Windows assistant.');
  notice('Sending the vendor receiver configuration sequence…');
  try {
    await switchReceiver(actuator);
  } catch (error) {
    // Switching can remove the XInput device while vibration effects settle.
    // A disappearance is still unconfirmed until its configuration map is read.
    if (navigator.getGamepads?.()[pad.index]?.id === pad.id) throw error;
    receiverSwitchSent = true;
    notice('Receiver input disappeared during switching. Choose its configuration HID to confirm the connection.');
    return;
  }
  receiverSwitchSent = true;
  notice('Mode-switch sequence sent; connection is unconfirmed. Choose the BeiTong configuration HID to read its map.');
}));
$('#read').addEventListener('click', () => void run(async () => {
  if (!controller) return;
  saveAcknowledged = false;
  advancedSnapshot = undefined; advancedSaved = false;
  snapshot = undefined;
  snapshot = await controller.read();
  notice('Controller settings refreshed. Your editor draft is preserved.');
}));
$('#apply').addEventListener('click', () => void run(async () => {
  if (!controller || !snapshot) return;
  download('beitong-before-apply.json', { version: 1, model: snapshot.model, slot: snapshot.slot, rawMap: snapshot.map, createdAt: new Date().toISOString() });
  const edits = { ...draft.mappings };
  advancedSnapshot = undefined; advancedSaved = false;
  snapshot = undefined;
  snapshot = await controller.apply(edits);
  draft.mappings = {}; saveLocal();
  saveAcknowledged = true;
  notice('Save acknowledged; readback matches. Power-cycle the controller and test the layout.');
}));
async function disconnect(): Promise<void> {
  const previous = controller; controller = undefined; snapshot = undefined;
  advancedSnapshot = undefined; advancedDraft = {}; advancedContext = ''; advancedSaved = false;
  receiverSwitchSent = false; saveAcknowledged = false;
  if (previous) await previous.close();
  $('#device-name').textContent = 'Asura 2 Pro';
  $('#device-detail').textContent = 'Reconnect the receiver to return to Xbox mode if needed.';
  render();
}
$('#disconnect').addEventListener('click', () => void run(async () => { await disconnect(); notice('Disconnected. Reconnect the receiver to return to Xbox mode if needed.'); }));
if ('hid' in navigator) navigator.hid.addEventListener('disconnect', event => {
  if (controller?.device === event.device) void disconnect().then(() => notice('Controller disconnected. Reconnect and read settings before applying.', true));
});

const inputSelector = document.createElement('select');
inputSelector.id = 'gamepad-select'; inputSelector.setAttribute('aria-label', 'Live input controller');
$('#gamepad-picker').append(inputSelector);
inputSelector.addEventListener('change', () => { activeGamepadIndex = Number(inputSelector.value); });
let gamepadSignature: string | undefined;
function pollInput(): void {
  if (!document.hidden) {
    const pads = Array.from(navigator.getGamepads?.() ?? []).filter((pad): pad is Gamepad => Boolean(pad));
    const signature = pads.map(p => `${p.index}:${p.id}`).join('|');
    if (signature !== gamepadSignature) {
      gamepadSignature = signature; inputSelector.replaceChildren();
      if (!pads.length) inputSelector.add(new Option('No gamepad detected', ''));
      for (const pad of pads) inputSelector.add(new Option(`${pad.index + 1}. ${pad.id}`, String(pad.index)));
      if (!pads.some(p => p.index === activeGamepadIndex)) activeGamepadIndex = pads.find(p => isXboxReceiver(p.id))?.index ?? pads[0]?.index;
      inputSelector.value = activeGamepadIndex === undefined ? '' : String(activeGamepadIndex);
    }
    const pad = pads.find(p => p.index === activeGamepadIndex);
    if (liveInputAvailable !== Boolean(pad)) { liveInputAvailable = Boolean(pad); render(); }
    $('#input-status').textContent = pad ? pad.mapping === 'standard' ? 'Live gamepad input' : 'Nonstandard input · layout unverified' : 'Waiting for controller input';
    document.querySelectorAll<HTMLElement>('.pad-button').forEach(button => {
      const index = gamepadKeys.indexOf(button.dataset.key as SourceKey);
      button.classList.toggle('pressed', Boolean(pad?.mapping === 'standard' && index >= 0 && pad.buttons[index]?.pressed));
    });
    const axisValue = (index: number): number => {
      const value = pad?.mapping === 'standard' ? pad.axes[index] : 0;
      return typeof value === 'number' && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    };
    for (const { cap, axis } of liveSticks) {
      const transform = `translate(${axisValue(axis) * 25}%, ${axisValue(axis + 1) * 25}%)`;
      if (cap.style.transform !== transform) cap.style.transform = transform;
    }
  }
  requestAnimationFrame(pollInput);
}
try { const stored = localStorage.getItem(storageKey); if (stored) { draft = validateProfile(JSON.parse(stored)); $<HTMLInputElement>('#profile-name').value = draft.name; } }
catch { notice('The saved browser profile could not be read. Starting with a fresh draft.', true); }
if (!('hid' in navigator) || !isSecureContext) notice('The editor works here. Controller configuration requires desktop Chrome or Edge on HTTPS or localhost.', true);
render(); pollInput();
