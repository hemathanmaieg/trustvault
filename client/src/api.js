// Thin wrapper around fetch. The browser sends the session cookie automatically
// (same origin). Every change carries the X-TrustVault-Request header, which the
// server requires as cross-site request protection.
// The client never decides permissions; it only shows what the server allows.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, url, body) {
  const headers = {};
  let payload;
  if (method !== 'GET') headers['X-TrustVault-Request'] = '1';
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function downloadUrl(id, version) {
  return `/api/documents/${encodeURIComponent(id)}/download${version ? `?version=${version}` : ''}`;
}
