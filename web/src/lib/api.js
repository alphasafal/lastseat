// Thin fetch wrapper. Two things matter here:
//  - errors carry the server's machine-readable `code`, which is what the UI switches on;
//  - every write gets an Idempotency-Key, and a write that fails at the network level is
//    retried with the SAME key, so a flaky connection can never apply an action twice.

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(method, path, body, headers) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const { code = 'UNKNOWN', message = 'Something went wrong.', ...details } = data?.error ?? {};
    throw new ApiError(res.status, code, message, details);
  }
  return data;
}

export const get = (path) => send('GET', path);

/** A state-changing request: idempotent, retried on network failure and on 503 BUSY. */
export async function write(method, path, body = {}) {
  const headers = { 'Idempotency-Key': crypto.randomUUID() };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(method, path, body, headers);
    } catch (err) {
      const offline = !(err instanceof ApiError);
      const busy = err instanceof ApiError && err.status === 503;
      if ((!offline && !busy) || attempt >= 4) {
        if (offline)
          throw new ApiError(0, 'OFFLINE', 'No connection. Check your network and try again.');
        throw err;
      }
      await sleep(busy ? 1500 : 400 * attempt);
    }
  }
}

export const post = (path, body) => write('POST', path, body);
export const patch = (path, body) => write('PATCH', path, body);
export const put = (path, body) => write('PUT', path, body);
export const del = (path) => write('DELETE', path, undefined);
