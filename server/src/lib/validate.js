import { z } from 'zod';
import { SKILLS, config } from '../config.js';
import { errors } from './errors.js';

// Strings are trimmed and control characters are refused, so a name can never smuggle a
// newline into a log line or an SSE frame.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const text = (min, max) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), 'must not contain control characters');

export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'must be a 24-character id');

const skills = (max) =>
  z
    .array(z.enum(SKILLS))
    .max(max)
    .transform((list) => [...new Set(list)]);

const timezone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'must be an IANA time zone such as Asia/Kolkata');

export const schemas = {
  register: z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      password: z.string().min(8).max(128),
      name: text(2, 60),
      skills: skills(8).default([]),
      timezone: timezone.default('UTC'),
    })
    .strict(),

  login: z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      password: z.string().min(1).max(128),
    })
    .strict(),

  participantUpdate: z
    .object({
      skills: skills(8).optional(),
      headline: text(0, 140).optional(),
      lookingForTeam: z.boolean().optional(),
      timezone: timezone.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'provide at least one field'),

  teamCreate: z
    .object({
      name: text(3, 40),
      description: text(0, 280).default(''),
      lookingFor: skills(6).default([]),
    })
    .strict(),

  teamUpdate: z
    .object({
      name: text(3, 40).optional(),
      description: text(0, 280).optional(),
      lookingFor: skills(6).optional(),
      acceptingRequests: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'provide at least one field'),

  inviteCreate: z
    .object({
      expiresInMinutes: z
        .number()
        .int()
        .min(config.invite.minTtlMinutes)
        .max(config.invite.maxTtlHours * 60)
        .default(config.invite.defaultTtlHours * 60),
    })
    .strict(),

  inviteJoin: z
    .object({
      // Accept what a human types: lower case, spaces, dashes. Normalised before hashing.
      code: z
        .string()
        .max(40)
        .transform((raw) => raw.toUpperCase().replace(/[^0-9A-Z]/g, ''))
        .refine((code) => code.length === config.invite.codeLength, 'is not a valid invite code'),
    })
    .strict(),

  joinRequestCreate: z.object({ message: text(0, 280).default('') }).strict(),

  userIdBody: z.object({ userId: objectId }).strict(),

  boardQuery: z
    .object({
      skill: z.enum(SKILLS).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(config.board.maxPageSize)
        .default(config.board.defaultPageSize),
    })
    .strict(),

  suggestionsQuery: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(config.suggestions.defaultLimit),
    })
    .strict(),

  auditQuery: z
    .object({
      before: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict(),

  streamQuery: z.object({ hackathonId: objectId, teamId: objectId.optional() }).strict(),
};

/** Parses with a schema and throws a 400 listing every problem. */
export function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw errors.validation(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  );
}

export function parseId(value, name = 'id') {
  const result = objectId.safeParse(value);
  if (result.success) return result.data.toLowerCase();
  throw errors.validation([{ path: name, message: 'must be a 24-character id' }]);
}
