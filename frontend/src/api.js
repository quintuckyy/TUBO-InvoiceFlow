// Thin wrapper around fetch: adds the JWT, parses JSON, and turns error responses
// ({ error: { code, message, details } }) into ApiError.

const TOKEN_KEY = 'tubo.token';

// sessionStorage: cleared when the tab closes. In production an httpOnly cookie is safer
// (not readable by JavaScript, so an XSS bug can't steal it) - see README.
export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (HTTP ${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection.' } });
  }

  const data = await res.json().catch(() => null);
  if (res.status === 401 && token) {
    // Token expired or invalid: drop it and send the user back to login.
    tokenStore.clear();
    window.location.assign('/login');
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function toQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });
  return query.toString();
}

export const api = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  me: () => request('GET', '/auth/me'),
  listInvoices: (params) => request('GET', `/invoices?${toQuery(params)}`),
  getInvoice: (id) => request('GET', `/invoices/${encodeURIComponent(id)}`),
  createInvoice: (invoice) => request('POST', '/invoices', invoice),
  retryInvoice: (id) => request('POST', `/invoices/${encodeURIComponent(id)}/retry`),
};
