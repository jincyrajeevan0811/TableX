import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', extra) => new HttpError(400, msg, code, extra);
export const unauthorized = (msg = 'Please sign in.', code = 'UNAUTHORIZED') => new HttpError(401, msg, code);
export const forbidden = (msg = 'You do not have access to this.', code = 'FORBIDDEN') => new HttpError(403, msg, code);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg, code = 'CONFLICT', extra) => new HttpError(409, msg, code, extra);

/** Minimal router: supports :params and an ordered chain of handlers. */
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^\\/]+)'; }) + '\\/?$',
    );
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handlers: r.handlers, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(res, root, urlPath) {
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const file = path.join(root, safe);
  if (!file.startsWith(root)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
