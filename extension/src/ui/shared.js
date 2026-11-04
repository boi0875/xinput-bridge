import { USB_FILTERS } from '../protocols.js';

// A port to the service worker that reconnects if the worker restarts.
export function connectWorker(name, onMessage) {
  let port = null;
  const api = {
    post(msg) { port?.postMessage(msg); },
  };
  const open = () => {
    port = chrome.runtime.connect({ name });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      setTimeout(open, 300);
    });
    api.onReconnect?.();
  };
  open();
  return api;
}

// Shows Chrome's USB chooser. Resolves true if the user picked a device.
export async function pairController({ all = false } = {}) {
  if (!navigator.usb) throw new Error('This browser has no WebUSB support.');
  try {
    await navigator.usb.requestDevice({ filters: all ? [] : USB_FILTERS });
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;   // chooser closed without a pick
    throw e;
  }
}

export const hex4 = n => n.toString(16).padStart(4, '0');

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function deviceStatus(dev) {
  if (dev.status === 'error' || dev.status === 'unsupported') return { tone: 'error', text: dev.status === 'unsupported' ? 'Not supported' : 'Error' };
  if (dev.status === 'opening') return { tone: 'warn', text: 'Connecting' };
  const players = dev.pads.filter(p => p.present).map(p => `Player ${p.player + 1}`);
  if (players.length) return { tone: 'on', text: players.join(', ') };
  return { tone: 'warn', text: dev.pads.some(p => p.protocol === 'xbox360-wireless') ? 'Waiting for a controller' : 'Connected' };
}
