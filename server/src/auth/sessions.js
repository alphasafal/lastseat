import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { col } from '../db.js';
import { errors } from '../lib/errors.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Sessions are opaque random tokens. Only the SHA-256 of the token is stored, so a leaked
 * database cannot be replayed as cookies.
 */
export async function createSession(user) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await col.sessions().insertOne({
    _id: sha256(token),
    userId: user._id,
    name: user.name,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.session.ttlMs),
  });
  return token;
}

export async function destroySession(token) {
  if (token) await col.sessions().deleteOne({ _id: sha256(token) });
}

export function setSessionCookie(res, token) {
  res.cookie(config.session.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: config.session.ttlMs,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.session.cookieName, { path: '/' });
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Attaches req.auth = { userId, name } when the cookie maps to a live session. */
export async function loadSession(req, _res, next) {
  const token = readCookie(req, config.session.cookieName);
  if (token && token.length <= 128) {
    const session = await col
      .sessions()
      .findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
    if (session) req.auth = { userId: session.userId, name: session.name, token };
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.auth) throw errors.unauthenticated();
  next();
}

/**
 * CSRF defence in depth on top of SameSite=Lax: a browser always sends Origin on
 * cross-site POSTs, so a mismatching Origin is refused before any handler runs.
 */
export function requireSameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw errors.crossOrigin();
    }
    if (host !== req.headers.host) throw errors.crossOrigin();
  }
  next();
}
