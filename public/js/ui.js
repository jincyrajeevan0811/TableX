import { icon } from './icons.js';

export { icon };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated events: on(root, 'click', '[data-act=save]', (e, el) => …) */
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) fn(e, el);
  });
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
export const money = (n) => inr.format(Number(n) || 0);
export const num = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const minutesSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 60000);
export function clock(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '—');
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function vegDot(veg) { return `<span class="veg-dot ${veg ? '' : 'nv'}" title="${veg ? 'Veg' : 'Non-veg'}"></span>`; }

export function empty(ic, title, text = '', action = '') {
  return `<div class="empty"><div class="em-icon">${icon(ic, 28)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`;
}

// ---------- Toasts ----------
export function toast(message, type = 'success', ms = 3200) {
  const root = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check_circle', 18)}<span>${esc(message)}</span>`;
  root.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}
export const toastError = (e) => toast(e?.message || String(e), 'error', 4500);

// ---------- Modals ----------
export function modal({ title, body = '', foot = '', size = '', onMount, onClose, dismissible = true }) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  root.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  document.getElementById('modals').appendChild(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissible) close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => { if (e.target === root && dismissible) close(); });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const m = { el: root.querySelector('.modal'), root, close };
  onMount?.(m);
  setTimeout(() => root.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea')?.focus(), 30);
  return m;
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, size: 'narrow',
      body: `<p class="muted">${esc(message)}</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'solid'}" data-ok>${esc(confirmText)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { done = true; m.close(); resolve(true); });
  });
}

/** Build a form field. type: text|number|password|email|tel|select|textarea|checkbox|switch|date|multicheck */
export function fieldHtml(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const v = f.value ?? '';
  const req = f.required ? 'required' : '';
  const attrs = `${req} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.pattern ? `pattern="${f.pattern}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}`;
  let control;
  if (f.type === 'select') {
    control = `<select class="select" id="${id}" name="${f.name}" ${req}>${(f.options || []).map((o) => {
      const [val, label] = Array.isArray(o) ? o : [o.value ?? o, o.label ?? o];
      return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('')}</select>`;
  } else if (f.type === 'textarea') {
    control = `<textarea class="textarea" id="${id}" name="${f.name}" ${attrs}>${esc(v)}</textarea>`;
  } else if (f.type === 'checkbox' || f.type === 'switch') {
    return `<div class="field ${f.full ? 'full' : ''}"><label class="check" style="font-weight:600;color:var(--text)">${f.type === 'switch'
      ? `<span class="switch"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}><span></span></span>`
      : `<input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}>`}<span>${esc(f.label)}</span></label>${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  } else if (f.type === 'multicheck') {
    const set = new Set(v || []);
    control = `<div class="col" style="gap:8px">${(f.options || []).map(([val, label]) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(val)}" ${set.has(val) ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>`;
  } else {
    control = `<input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${attrs}>`;
  }
  return `<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' <span style="color:var(--danger)">*</span>' : ''}</label>${control}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}

export function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'checkbox' || f.type === 'switch') out[f.name] = form.querySelector(`[name="${f.name}"]`).checked;
    else if (f.type === 'multicheck') out[f.name] = $$(`[name="${f.name}"]:checked`, form).map((x) => x.value);
    else {
      const raw = form.querySelector(`[name="${f.name}"]`).value;
      out[f.name] = f.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw.trim?.() ?? raw;
    }
  }
  return out;
}

/** Generic form-in-a-modal. onSubmit may throw to keep the modal open. */
export function formModal({ title, fields, submitText = 'Save', size = '', intro = '', onSubmit, danger }) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({
      title, size,
      body: `${intro ? `<div style="margin-bottom:16px">${intro}</div>` : ''}<form class="form-grid" novalidate>${fields.map(fieldHtml).join('')}<button type="submit" hidden></button></form>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-submit>${esc(submitText)}</button>`,
      onClose: () => resolve(result),
    });
    const form = m.el.querySelector('form');
    const btn = m.el.querySelector('[data-submit]');
    const submit = async (e) => {
      e?.preventDefault();
      if (!form.reportValidity()) return;
      btn.disabled = true;
      try {
        result = (await onSubmit(readForm(form, fields), m)) ?? true;
        m.close();
      } catch (err) { toastError(err); } finally { btn.disabled = false; }
    };
    form.addEventListener('submit', submit);
    btn.addEventListener('click', submit);
  });
}

/** Run an async action with a busy button. */
export async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh', 16, 'spin')}<span>${btn.textContent.trim() ? 'Working…' : ''}</span>`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}

// ---------- Printing & export ----------
export function printHtml(html) {
  const root = document.getElementById('print-root');
  root.innerHTML = html;
  setTimeout(() => { window.print(); setTimeout(() => { root.innerHTML = ''; }, 500); }, 60);
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it on WhatsApp or anywhere'); } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('Copied');
  }
}

/** Short beep for new kitchen tickets / QR orders (no audio files needed). */
let audioCtx;
export function beep(times = 2) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = i % 2 ? 1046 : 880;
      const t = audioCtx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.2);
    }
  } catch { /* audio blocked until first user tap */ }
}

/** Status badge helper. */
const STATUS = {
  free: ['success', 'Free'], occupied: ['primary', 'Occupied'], billed: ['info', 'Billed'], reserved: ['primary', 'Reserved'], cleaning: ['', 'Cleaning'],
  awaiting: ['danger', 'Awaiting'], open: ['primary', 'Running'], paid: ['success', 'Paid'], cancelled: ['danger', 'Cancelled'],
  new: ['primary', 'New'], preparing: ['warning', 'Preparing'], ready: ['success', 'Ready'], served: ['', 'Served'], pending: ['danger', 'Waiting'],
  in_kitchen: ['warning', 'In kitchen'], not_sent: ['', 'Not sent'], empty: ['', 'Empty'],
  assigned: ['info', 'Assigned'], accepted: ['primary', 'Accepted'], picked_up: ['warning', 'On the way'], delivered: ['success', 'Delivered'],
  active: ['success', 'Active'], suspended: ['danger', 'Paused'], expired: ['danger', 'Expired'], replaced: ['', 'Replaced'], trial: ['info', 'Trial'],
};
export function badge(status, label) {
  const [cls, text] = STATUS[status] || ['', cap(status)];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label || text)}</span>`;
}
export const ORDER_TYPE = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
export const METHOD = { cash: 'Cash', upi: 'UPI', card: 'Card', razorpay: 'Razorpay', wallet: 'Wallet', other: 'Other' };
