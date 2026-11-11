import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { SKILLS, config } from '../config.js';
import { INDEX, ObjectId, col } from '../db.js';
import { errors, isDuplicateKey } from '../lib/errors.js';
import { hit } from '../lib/rateLimit.js';
import { parse, schemas } from '../lib/validate.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
} from './sessions.js';

export const authRouter = Router();

const userView = (user) => ({
  id: String(user._id),
  email: user.email,
  name: user.name,
  skills: user.skills,
  timezone: user.timezone,
});

async function insertUser({ email, password, name, skills, timezone, demo = false }) {
  const user = {
    _id: new ObjectId(),
    email,
    name,
    skills,
    timezone,
    passwordHash: await hashPassword(password),
    demo,
    createdAt: new Date(),
  };
  try {
    await col.users().insertOne(user);
  } catch (err) {
    if (isDuplicateKey(err, INDEX.email)) throw errors.emailTaken();
    throw err;
  }
  return user;
}

authRouter.post('/register', async (req, res) => {
  await hit('auth:ip', req.ip, config.rateLimits.authPerIp);
  const input = parse(schemas.register, req.body);
  const user = await insertUser(input);
  setSessionCookie(res, await createSession(user));
  res.status(201).json({ user: userView(user) });
});

authRouter.post('/login', async (req, res) => {
  await hit('auth:ip', req.ip, config.rateLimits.authPerIp);
  const input = parse(schemas.login, req.body);
  await hit('login:email', input.email, config.rateLimits.loginPerEmail);

  const user = await col.users().findOne({ email: input.email });
  // Always verify against some hash so the response time does not reveal whether the email exists.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw errors.badCredentials();

  setSessionCookie(res, await createSession(user));
  res.json({ user: userView(user) });
});

// One-click throwaway account so a reviewer can try the product without filling in a form.
const DEMO_NAMES = ['Asha', 'Ben', 'Chidi', 'Divya', 'Elif', 'Farid', 'Grace', 'Hiro', 'Ines'];
const DEMO_ZONES = ['Asia/Kolkata', 'Europe/Berlin', 'America/New_York', 'Asia/Singapore'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

authRouter.post('/demo', async (req, res) => {
  await hit('auth:ip', req.ip, config.rateLimits.authPerIp);
  const tag = randomBytes(4).toString('hex');
  const user = await insertUser({
    email: `demo-${tag}@lastseat.test`,
    password: randomBytes(18).toString('base64url'),
    name: `${pick(DEMO_NAMES)} (demo ${tag.slice(0, 3)})`,
    skills: [...new Set([pick(SKILLS), pick(SKILLS), pick(SKILLS)])],
    timezone: pick(DEMO_ZONES),
    demo: true,
  });
  setSessionCookie(res, await createSession(user));
  res.status(201).json({ user: userView(user) });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(req.auth?.token);
  clearSessionCookie(res);
  res.status(204).end();
});

// Used by the web app on load: "am I signed in?" is a question, so the answer is 200 either
// way. /me below is the strict variant that fails with 401.
authRouter.get('/session', async (req, res) => {
  const user = req.auth ? await col.users().findOne({ _id: req.auth.userId }) : null;
  res.json({ user: user ? userView(user) : null });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await col.users().findOne({ _id: req.auth.userId });
  if (!user) throw errors.unauthenticated();
  res.json({ user: userView(user) });
});
