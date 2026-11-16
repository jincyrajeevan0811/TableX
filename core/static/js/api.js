// API client, session store, offline KOT queue and small local cache.
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) { (listeners.get(event) || []).forEach((fn) => fn(data)); }

export const session = {
  get token() { return LS.get('tx_token'); },
  set token(v) { if (v) LS.set('tx_token', v); else LS.del('tx_token'); },
  me: null,
};

export class ApiError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    emit('network', false);
    throw new ApiError(0, 'You are offline. Check the internet connection.', 'OFFLINE');
  }
  emit('network', true);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code, data?.details);
    if (res.status === 401 && auth && path !== '/api/auth/login') emit('unauthorized', err);
    if (res.status === 402) emit('subscription', err);
    throw err;
  }
  return data;
}

// ---------- Local cache (menu, tables) so POS screens work offline ----------
export const cache = {
  get: (k) => LS.get(`tx_cache_${k}`),
  set: (k, v) => LS.set(`tx_cache_${k}`, v),
  clear: () => { try { Object.keys(localStorage).filter((k) => k.startsWith('tx_cache_')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } },
};

// ---------- Offline KOT queue ----------
export const queue = {
  list: () => LS.get('tx_queue', []),
  save(list) { LS.set('tx_queue', list); emit('queue', list.length); },
  add(payload) {
    const list = queue.list();
    list.push({ ...payload, queued_at: Date.now() });
    queue.save(list);
  },
};

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Send a KOT; when offline the ticket is saved on this device and synced later (idempotent via client_key). */
export async function sendKot(payload) {
  const body = { ...payload, client_key: payload.client_key || newKey() };
  try {
    return await api('/api/orders/kot', { method: 'POST', body });
  } catch (e) {
    if (e.code === 'OFFLINE') { queue.add(body); return { offline: true }; }
    throw e;
  }
}

let syncing = false;
export async function syncQueue() {
  if (syncing) return { sent: 0, failed: [] };
  syncing = true;
  let sent = 0;
  const failed = [];
  try {
    for (const item of queue.list()) {
      const { queued_at, ...body } = item;
      try {
        await api('/api/orders/kot', { method: 'POST', body: { ...body, force: true } });
        sent++;
        queue.save(queue.list().filter((x) => x.client_key !== item.client_key));
      } catch (e) {
        if (e.code === 'OFFLINE') break;
        failed.push({ item, error: e.message });
        queue.save(queue.list().filter((x) => x.client_key !== item.client_key));
      }
    }
  } finally { syncing = false; }
  if (sent || failed.length) emit('synced', { sent, failed });
  return { sent, failed };
}
