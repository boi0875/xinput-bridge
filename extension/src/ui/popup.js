import { PROTOCOL_LABEL } from '../protocols.js';
import { hostnameOf, loadSettings, saveSettings } from '../settings.js';
import { connectWorker, deviceStatus, el, pairController } from './shared.js';

const $ = id => document.getElementById(id);
const liveTimers = new Map();
let devices = [];

const worker = connectWorker('popup', msg => {
  if (msg.t === 'devices') { devices = msg.devices; render(); }
  else if (msg.t === 's') flash(msg.p);
  else if (msg.t === 'nousb') $('nousb').hidden = false;
});

function render() {
  const list = $('list');
  list.replaceChildren();
  const rows = [];
  for (const dev of devices) {
    const present = dev.pads.filter(p => p.present);
    if (dev.status === 'open' && present.length) {
      for (const pad of present) {
        rows.push(el('div', { class: 'row' },
          el('span', { class: 'player', text: `P${pad.player + 1}` }),
          el('div', { class: 'main' },
            el('div', { class: 'name', text: dev.pads.length > 1 ? `${dev.name} #${pad.slot + 1}` : dev.name }),
            el('div', { class: 'sub', text: PROTOCOL_LABEL[pad.protocol] })),
          el('span', { class: 'dot on', 'data-player': pad.player, title: 'Lights up on input' })));
      }
    } else {
      const status = deviceStatus(dev);
      const retry = dev.status === 'error'
        ? el('button', { class: 'btn small', text: 'Retry', onclick: () => worker.post({ t: 'retry', key: dev.key }) })
        : null;
      rows.push(el('div', { class: 'row' },
        el('span', { class: `dot ${status.tone}` }),
        el('div', { class: 'main' },
          el('div', { class: 'name', text: dev.name }),
          dev.status === 'error'
            ? el('div', { class: 'err', text: dev.error })
            : el('div', { class: 'sub', text: dev.status === 'unsupported' ? 'Not a supported controller' : status.text })),
        retry));
    }
  }
  if (!rows.length) {
    list.append(el('p', { class: 'empty', text: 'No controllers yet. Plug one in and pair it. You only pair once; after that it connects by itself.' }));
  } else {
    list.append(...rows);
  }
  const n = devices.reduce((sum, d) => sum + d.pads.filter(p => p.present).length, 0);
  const count = $('count');
  count.textContent = n ? `${n} connected` : 'No controllers';
  count.className = n ? 'chip on' : 'chip';
}

function flash(player) {
  const dot = document.querySelector(`.dot[data-player="${player}"]`);
  if (!dot) return;
  dot.classList.add('live');
  clearTimeout(liveTimers.get(player));
  liveTimers.set(player, setTimeout(() => dot.classList.remove('live'), 120));
}

$('pair').addEventListener('click', async () => {
  $('pair-error').hidden = true;
  try {
    if (await pairController()) worker.post({ t: 'scan' });
  } catch (e) {
    $('pair-error').textContent = `Couldn't pair: ${e.message}`;
    $('pair-error').hidden = false;
  }
});

$('dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------- this site ----------

const tabStatus = async tab => {
  try { return await chrome.tabs.sendMessage(tab.id, { t: 'status' }, { frameId: 0 }); } catch { return null; }
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // activeTab exposes the URL once the toolbar button is clicked; the page's
  // own content script knows its hostname too.
  const host = hostnameOf(tab.url || '') || (await tabStatus(tab))?.site;
  if (!host) return;
  const settings = await loadSettings();
  $('site-section').hidden = false;
  $('host').textContent = host;
  const toggle = $('site-toggle');
  toggle.checked = !settings.disabledSites.includes(host);

  const checkTab = async () => {
    const status = await tabStatus(tab);
    $('reload-box').hidden = !!status || !toggle.checked;
  };
  checkTab();

  toggle.addEventListener('change', async () => {
    const { disabledSites } = await loadSettings();
    const next = new Set(disabledSites);
    if (toggle.checked) next.delete(host); else next.add(host);
    await saveSettings({ disabledSites: [...next].sort() });
    checkTab();
  });
  $('reload').addEventListener('click', () => { chrome.tabs.reload(tab.id); window.close(); });
})();
