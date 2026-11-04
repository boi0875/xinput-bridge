import { B, PRESS_THRESHOLD, PROTOCOL_LABEL } from '../protocols.js';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings } from '../settings.js';
import { connectWorker, deviceStatus, el, hex4, pairController } from './shared.js';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

let devices = [];
let settings = { ...DEFAULT_SETTINGS };
const states = new Map();     // player -> { b, a }
const views = new Map();      // player -> update(state)
const dirty = new Set();
let frame = 0;

const worker = connectWorker('dashboard', onMessage);
worker.onReconnect = () => { if (raw.on) worker.post({ t: 'raw', on: true }); };

function onMessage(msg) {
  switch (msg.t) {
    case 'devices':
      devices = msg.devices;
      renderDevices();
      break;
    case 'pads': {
      const seen = new Set();
      for (const pad of msg.pads) {
        seen.add(pad.p);
        setState(pad.p, { b: pad.b, a: pad.a });
      }
      for (const p of states.keys()) if (!seen.has(p)) states.delete(p);
      break;
    }
    case 's':
      setState(msg.p, { b: msg.b, a: msg.a });
      break;
    case 'raw':
      raw.add(msg);
      break;
    case 'nousb':
      $('nousb').hidden = false;
      break;
  }
}

function setState(p, state) {
  states.set(p, state);
  dirty.add(p);
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  for (const p of dirty) {
    const view = views.get(p);
    const state = states.get(p);
    if (view && state) view(state);
  }
  dirty.clear();
}

// ---------- controller cards ----------

function renderDevices() {
  const root = $('devices');
  root.replaceChildren();
  views.clear();
  deadzoneRings.clear();
  $('welcome').hidden = !(location.hash === '#welcome' || devices.length === 0);

  if (!devices.length) {
    root.append(el('div', { class: 'empty' },
      el('p', {}, el('b', { text: 'No controllers connected' })),
      el('p', { text: 'Plug in a controller and click Pair a controller. Paired controllers that are plugged in show up here by themselves.' })));
    return;
  }

  for (const dev of devices) {
    const status = deviceStatus(dev);
    const protocols = [...new Set(dev.pads.map(p => p.label))].join(', ');
    const meta = el('div', { class: 'meta' },
      [dev.manufacturer, el('span', { class: 'mono', text: `${hex4(dev.vid)}:${hex4(dev.pid)}` }), protocols]
        .filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part])));
    const actions = el('div', { class: 'actions' },
      dev.status === 'error'
        ? el('button', { class: 'btn small', text: 'Retry', onclick: () => worker.post({ t: 'retry', key: dev.key }) })
        : null,
      el('button', {
        class: 'btn small quiet', text: 'Forget',
        title: 'Remove Chrome’s permission for this device. You can pair it again later.',
        onclick: () => worker.post({ t: 'forget', key: dev.key }),
      }));
    const card = el('div', { class: 'device' },
      el('div', { class: 'device-head' },
        el('div', { class: 'main' },
          el('div', { class: 'name', text: dev.name }),
          meta),
        el('span', { class: `status ${status.tone === 'error' ? 'error' : ''}` },
          el('span', { class: `dot ${status.tone}` }), status.text),
        actions));
    if (dev.error) card.append(el('p', { class: 'note error', text: dev.error }));

    const present = dev.pads.filter(p => p.present);
    if (dev.status === 'open' && !present.length) {
      card.append(el('p', { class: 'note', text: 'Receiver ready. Switch a controller on, or press its connect button, to link it.' }));
    }
    for (const pad of present) {
      const view = padView(dev, pad);
      card.append(view.node);
      views.set(pad.player, view.update);
      const state = states.get(pad.player);
      if (state) view.update(state);
    }
    root.append(card);
  }
}

const KEY_GROUPS = [
  [[B.A, 'A'], [B.B, 'B'], [B.X, 'X'], [B.Y, 'Y']],
  [[B.LB, 'LB'], [B.RB, 'RB'], [B.LS, 'LS'], [B.RS, 'RS']],
  [[B.UP, '↑'], [B.DOWN, '↓'], [B.LEFT, '←'], [B.RIGHT, '→']],
  [[B.BACK, 'View'], [B.START, 'Menu'], [B.GUIDE, 'Guide']],
];

function padView(dev, pad) {
  const left = stickView('Left stick');
  const right = stickView('Right stick');
  const lt = triggerView('LT');
  const rt = triggerView('RT');
  const keys = [];
  const groups = KEY_GROUPS.map(group => el('div', { class: 'key-row' },
    group.map(([index, label]) => {
      const node = el('span', { class: 'key', text: label, title: `Button ${index}` });
      keys.push([index, node]);
      return node;
    })));
  const rumble = el('button', {
    class: 'btn small', text: 'Test rumble',
    onclick: () => worker.post({ t: 'test-rumble', p: pad.player }),
  });
  if (!settings.rumble) rumble.disabled = true;

  // The card header already names the player; a receiver also says which of its pads this is.
  const label = dev.pads.length > 1 ? `Controller ${pad.slot + 1} · Player ${pad.player + 1}` : 'Live input';
  const node = el('div', { class: 'pad' },
    el('div', { class: 'pad-label' },
      el('span', { text: label }),
      el('span', { class: 'spacer' }),
      rumble),
    el('div', { class: 'sticks' }, left.node, right.node, el('div', { class: 'triggers' }, lt.node, rt.node)),
    el('div', { class: 'buttons' }, groups));

  return {
    node,
    update({ b, a }) {
      left.update(a[0], a[1], b[B.LS]);
      right.update(a[2], a[3], b[B.RS]);
      lt.update(b[B.LT]);
      rt.update(b[B.RT]);
      for (const [index, key] of keys) key.classList.toggle('down', b[index] > PRESS_THRESHOLD);
    },
  };
}

// lucide "x"
function xIcon() {
  const icon = svg('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  icon.append(svg('path', { d: 'M18 6 6 18' }), svg('path', { d: 'm6 6 12 12' }));
  return icon;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const STICK_R = 40;
const deadzoneRings = new Set();

function stickView(label) {
  const box = svg('svg', { viewBox: '-48 -48 96 96', 'aria-hidden': 'true' });
  box.append(
    svg('circle', { class: 'ring', r: STICK_R }),
    svg('line', { class: 'cross', x1: -STICK_R, x2: STICK_R, y1: 0, y2: 0 }),
    svg('line', { class: 'cross', y1: -STICK_R, y2: STICK_R, x1: 0, x2: 0 }));
  const dz = svg('circle', { class: 'dz', r: settings.deadzone * STICK_R });
  deadzoneRings.add(dz);
  const knob = svg('circle', { class: 'knob', r: 6 });
  box.append(dz, knob);
  const vals = el('span', { class: 'vals', text: ' 0.00  0.00' });
  const node = el('div', { class: 'stick' }, box, vals, el('span', { text: label }));
  const fmt = v => (v < 0 ? '' : ' ') + v.toFixed(2);
  return {
    node,
    update(x, y, pressed) {
      knob.setAttribute('cx', (x * STICK_R).toFixed(1));
      knob.setAttribute('cy', (y * STICK_R).toFixed(1));
      vals.textContent = `${fmt(x)} ${fmt(y)}`;
      node.classList.toggle('pressed', pressed > 0);
    },
  };
}

function triggerView(label) {
  const fill = el('div', { class: 'fill' });
  const node = el('div', { class: 'trigger' }, el('div', { class: 'bar' }, fill), el('span', { text: label }));
  return { node, update(v) { fill.style.height = `${Math.round(v * 100)}%`; } };
}

// ---------- pairing ----------

async function pair(all) {
  $('pair-error').hidden = true;
  try {
    if (await pairController({ all })) worker.post({ t: 'scan' });
  } catch (e) {
    $('pair-error').textContent = `Couldn't pair: ${e.message}`;
    $('pair-error').hidden = false;
  }
}
$('pair').addEventListener('click', () => pair(false));
$('pair-all').addEventListener('click', () => pair(true));

// ---------- settings ----------

const pct = v => `${Math.round(v * 100)}%`;

function showSettings() {
  $('deadzone').value = settings.deadzone;
  $('deadzone-value').textContent = pct(settings.deadzone);
  $('rumble').checked = settings.rumble;
  $('strength').value = settings.rumbleStrength;
  $('strength-value').textContent = pct(settings.rumbleStrength);
  $('strength-row').hidden = !settings.rumble;
  $('toasts').checked = settings.toasts;
  $('identity').value = settings.identity;
  for (const ring of deadzoneRings) if (ring.isConnected) ring.setAttribute('r', settings.deadzone * STICK_R);
  for (const btn of document.querySelectorAll('.pad-label .btn')) btn.disabled = !settings.rumble;

  const sites = $('sites');
  sites.replaceChildren();
  if (!settings.disabledSites.length) sites.append(el('span', { class: 'faint', text: 'No sites' }));
  for (const host of settings.disabledSites) {
    const remove = el('button', {
      'aria-label': `Turn the bridge back on for ${host}`, title: 'Turn back on',
      onclick: () => saveSettings({ disabledSites: settings.disabledSites.filter(h => h !== host) }),
    });
    remove.append(xIcon());
    sites.append(el('span', { class: 'tag' }, host, remove));
  }
}

$('deadzone').addEventListener('input', e => {
  const v = Number(e.target.value);
  $('deadzone-value').textContent = pct(v);
  for (const ring of deadzoneRings) if (ring.isConnected) ring.setAttribute('r', v * STICK_R);
});
// Saved on release: chrome.storage.sync limits how often it can be written.
$('deadzone').addEventListener('change', e => saveSettings({ deadzone: Number(e.target.value) }));
$('strength').addEventListener('input', e => { $('strength-value').textContent = pct(Number(e.target.value)); });
$('strength').addEventListener('change', e => saveSettings({ rumbleStrength: Number(e.target.value) }));
$('rumble').addEventListener('change', e => saveSettings({ rumble: e.target.checked }));
$('toasts').addEventListener('change', e => saveSettings({ toasts: e.target.checked }));
$('identity').addEventListener('change', e => saveSettings({ identity: e.target.value }));

loadSettings().then(s => { settings = s; showSettings(); });
onSettingsChanged(patch => { settings = { ...settings, ...patch }; showSettings(); });

// ---------- raw reports ----------

const raw = {
  on: false,
  lines: [],
  pending: false,
  add(msg) {
    const dev = devices.find(d => d.key === msg.key);
    const name = dev ? (dev.pads.length > 1 ? `${dev.name} #${msg.slot + 1}` : dev.name) : `device ${msg.key}`;
    const t = (performance.now() / 1000).toFixed(3).padStart(9);
    this.lines.push(`${t}  ${name}  ${msg.hex}`);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        const pre = $('raw');
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
        pre.textContent = this.lines.join('\n');
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      });
    }
  },
};

$('raw-toggle').addEventListener('click', () => {
  raw.on = !raw.on;
  worker.post({ t: 'raw', on: raw.on });
  $('raw-toggle').textContent = raw.on ? 'Stop capture' : 'Start capture';
});
$('raw-copy').addEventListener('click', async () => {
  const header = `XInput Bridge ${chrome.runtime.getManifest().version}, ${navigator.userAgent}\n` +
    devices.map(d => `${d.name}: ${hex4(d.vid)}:${hex4(d.pid)} ${d.pads.map(p => p.protocol).join(', ')}`).join('\n');
  await navigator.clipboard.writeText(`${header}\n\n${raw.lines.join('\n')}`);
  $('raw-copy').textContent = 'Copied';
  setTimeout(() => { $('raw-copy').textContent = 'Copy'; }, 1200);
});
$('raw-clear').addEventListener('click', () => { raw.lines = []; $('raw').textContent = ''; });

$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
