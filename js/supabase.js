/* supabase.js — the club's Supabase project, over plain fetch.
 *
 * There is no Supabase client library here on purpose. The app needs exactly
 * four things — swap a PIN for a session, refresh that session, upsert rows,
 * select rows — and a CDN import would be a cross-origin dependency the
 * service worker cannot precache, i.e. a dead app on a beach with no signal.
 * (ARCHITECTURE.md D4 called for the CDN client; see the amendment note there.)
 *
 * The session lives in localStorage rather than IndexedDB: it is a credential,
 * not race data, and losing it costs one PIN entry rather than a race record.
 */

/* ---------------------------------------------------------------------------
 * CONFIG — the two values from SETUP.md. Both are safe to publish: the
 * publishable key grants nothing beyond the anon RLS policies, which are read
 * only and only on published races.
 * ------------------------------------------------------------------------ */
export const CONFIG = {
  url: "https://lqqueagkoobpdcvcjomm.supabase.co",
  publishableKey: "sb_publishable_SzJkkqsDM5EIkr8HinKXFw_xn3519n0",
};

const SESSION_KEY = "nsc-race-day.session";
/* Refresh a little early so a request never races the expiry. */
const REFRESH_MARGIN_SECONDS = 60;

/* ---------------------------------------------------------------------------
 * Session storage
 * ------------------------------------------------------------------------ */

let session = readStoredSession();
let refreshInFlight = null;
const listeners = new Set();

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    // Private browsing, or storage full. The session still works for this load.
    console.warn("could not persist session", err);
  }
  for (const fn of listeners) {
    try {
      fn(next);
    } catch (err) {
      console.error("auth listener failed", err);
    }
  }
}

/** Subscribe to sign-in / sign-out. Fires immediately with the current state. */
export function onAuthChange(fn) {
  listeners.add(fn);
  fn(session);
  return () => listeners.delete(fn);
}

export function isSignedIn() {
  return Boolean(session?.refresh_token);
}

export function signOut() {
  storeSession(null);
}

function expiresAtMs(s) {
  if (!s) return 0;
  if (s.expires_at) return s.expires_at * 1000;
  return 0;
}

/* ---------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------ */

/**
 * Exchange the club PIN for a session.
 * @throws {AuthError} with a code the UI can distinguish
 */
export async function signInWithPin(pin) {
  const res = await fetch(`${CONFIG.url}/functions/v1/pin-auth`, {
    method: "POST",
    headers: { apikey: CONFIG.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(body.error || "sign_in_failed", body.message || "Could not sign in.", {
      remaining: body.remaining,
      status: res.status,
    });
  }

  storeSession(body);
  return body;
}

export class AuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Swap the refresh token for a fresh access token. */
async function refreshSession() {
  if (!session?.refresh_token) return null;
  // Collapse concurrent refreshes: several queued requests waking up together
  // must not each spend the refresh token.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: CONFIG.publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        // A refresh token the server no longer knows means the session is gone
        // for good; anything else is probably the network and worth retrying.
        if (res.status === 400 || res.status === 401) storeSession(null);
        return null;
      }
      const next = await res.json();
      storeSession(next);
      return next;
    } catch {
      return null; // offline; keep the session and try again later
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** A valid access token, refreshing first if it is about to expire. */
async function accessToken() {
  if (!session) return null;
  const expiring = expiresAtMs(session) - Date.now() < REFRESH_MARGIN_SECONDS * 1000;
  if (expiring) await refreshSession();
  return session?.access_token ?? null;
}

/* ---------------------------------------------------------------------------
 * REST
 * ------------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    /* 5xx and network failures are worth retrying; a 4xx means this request is
       wrong and will stay wrong, so the outbox must not spin on it forever. */
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

async function request(method, path, { body, headers = {}, authed = true } = {}) {
  const token = authed ? await accessToken() : null;
  if (authed && !token) throw new ApiError(401, "not signed in", null);

  let res;
  try {
    res = await fetch(`${CONFIG.url}${path}`, {
      method,
      headers: {
        apikey: CONFIG.publishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // No signal. Retryable by definition.
    throw new ApiError(0, err.message || "network unavailable", null);
  }

  // One retry on 401: the token may have expired between check and send.
  if (res.status === 401 && authed) {
    const refreshed = await refreshSession();
    if (refreshed?.access_token) {
      return request(method, path, { body, headers, authed });
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    throw new ApiError(res.status, parsed?.message || `${method} ${path} failed`, parsed);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Upsert rows, keyed on the primary key. This is the whole of sync's write
 * path, and the reason a retried push is harmless.
 */
export async function upsert(table, rows) {
  if (!rows.length) return;
  await request("POST", `/rest/v1/${table}`, {
    body: rows,
    headers: {
      // merge-duplicates is PostgREST's ON CONFLICT DO UPDATE; return=minimal
      // keeps the response empty, which matters on a phone with one bar.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
  });
}

/** Read a table or view. */
export async function select(table, { columns = "*", params = {}, authed = true } = {}) {
  const search = new URLSearchParams({ select: columns, ...params });
  return request("GET", `/rest/v1/${table}?${search}`, { authed });
}
