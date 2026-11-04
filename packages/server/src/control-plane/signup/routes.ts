/**
 * Signup (hosted edition spec §22.6, ruling 1), on the entry host only (`ENTRY_ROUTE`), hosted mode only. No cookie
 * at any step.
 *
 * `GET /signup` is the form; `POST /signup` checks, in order: the `Origin` (`403`, as the entry's form, §21.4), the
 * body size (`413`), the client address's rate limit, each field, the email's rate limit, then the slug under the
 * slug lock (§22.3). Over either limit the answer is "Check your inbox" and nothing is done: a `429` would tell a
 * prober which addresses were being tried. A field's or the slug's refusal shows the form again with the reason:
 * this is the one place a slug's existence is answered, and slugs are public names; both limits are charged before
 * it, so probing slugs is limited too. On success the signup is inserted and its link mailed after the answer is
 * sent, through a queue, so the time to answer does not say whether a mail went out. The answer is the same whether
 * or not the address already has teams: the form never looks.
 *
 * The rate limits are in-process token buckets, as the entry's (identity's `RateLimiter`): the shared limiter's
 * buckets live in a tenant's table (§20.7), and a signup has no tenant; charging the default tenant's would need its
 * scope, which guard 2 (§19.8) keeps from every module. The email's bucket is keyed by a keyed hash, so the map
 * never holds an address.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EntryQueue } from '../../entry/queue.js';
import { addressBucketKey, ENTRY_ADDRESS, PER_ADDRESS, PER_CLIENT } from '../../entry/routes.js';
import { RateLimiter } from '../../identity/rate-limit.js';
import { ENTRY_ROUTE } from '../../tenancy/resolve.js';
import type { ControlDb } from '../control-db.js';
import { slugState } from '../slugs.js';
import { renderSignupForm, renderSignupSent, SIGNUP_PAGE_CSP, type SignupFormValues } from './page.js';
import { insertSignup, newSignupToken, SIGNUP_MAX_SEATS, SIGNUP_TTL_MS, signupTokenHash } from './repo.js';

export const SIGNUP_PATH = '/signup';

/** Four short fields: 4 KiB is far past any honest form. */
export const SIGNUP_BODY_LIMIT = 4 * 1024;

/** The most characters a team's name has (spec §22.6). */
export const TEAM_NAME_MAX = 80;

/** A signup's mail, waiting in the queue: the address and the link, never logged. */
export interface SignupMailItem {
  readonly to: string;
  readonly link: string;
}

export interface SignupMail {
  readonly subject: string;
  readonly text: string;
}

/** The verification mail (spec §22.6): plain text, so the team's name, which the person typed, is never markup. */
export function renderSignupMail(input: { readonly link: string; readonly entryHost: string }): SignupMail {
  return {
    subject: 'Finish signing up for Wirebench',
    text: [
      'To finish signing up for your Wirebench team, open this link within 24 hours:',
      '',
      `  ${input.link}`,
      '',
      `You asked for this at ${input.entryHost}. If you did not, ignore it: nothing has been set up.`,
      '',
    ].join('\n'),
  };
}

export interface SignupRoutesOptions {
  readonly control: ControlDb;
  /** `app.<app-domain>`. */
  readonly entryHost: string;
  /** `<app-domain>`. */
  readonly appDomain: string;
  readonly queue: Pick<EntryQueue<SignupMailItem>, 'push'>;
  readonly now?: () => Date;
}

/** Why a field was refused, in the person's words. */
const REFUSALS = {
  email: 'Enter a valid email address.',
  name: `A team name is 1 to ${String(TEAM_NAME_MAX)} characters, on one line.`,
  seats: `Seats are a whole number from 1 to ${String(SIGNUP_MAX_SEATS)}.`,
  'slug-invalid':
    'A team address is lower-case letters, digits and hyphens, at most 40, starting and ending with a letter or digit.',
  'slug-reserved': 'That team address is reserved. Choose another.',
  'slug-taken': 'That team address is taken. Choose another.',
} as const;

/** A team's name: trimmed, one line, no control characters, 1 to {@link TEAM_NAME_MAX} characters. */
export function teamNameOf(raw: string): string | undefined {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > TEAM_NAME_MAX || /[\p{Cc}\u2028\u2029]/u.test(name)) return undefined;
  return name;
}

/** Seats: a whole number from 1 to {@link SIGNUP_MAX_SEATS}, in plain digits. */
export function seatsOf(raw: string): number | undefined {
  if (!/^\d{1,3}$/.test(raw.trim())) return undefined;
  const seats = Number(raw.trim());
  return seats >= 1 && seats <= SIGNUP_MAX_SEATS ? seats : undefined;
}

export function registerSignupRoutes(app: FastifyInstance, options: SignupRoutesOptions): void {
  const origin = `https://${options.entryHost}`;
  const now = options.now ?? (() => new Date());
  const clock = { now: () => now().getTime() };
  const clients = new RateLimiter({ ...PER_CLIENT, ...clock });
  const addresses = new RateLimiter({ ...PER_ADDRESS, ...clock });
  // A key that lives as long as the process, so the per-address buckets never hold an address in the clear.
  const bucketKey = randomBytes(32);

  const html = (reply: FastifyReply, body: string): FastifyReply =>
    reply
      .code(200)
      .header('content-security-policy', SIGNUP_PAGE_CSP)
      .header('referrer-policy', 'same-origin')
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(body);
  const form = (reply: FastifyReply, values?: SignupFormValues, error?: string): FastifyReply =>
    html(
      reply,
      renderSignupForm({
        appDomain: options.appDomain,
        ...(values !== undefined ? { values } : {}),
        ...(error !== undefined ? { error } : {}),
      }),
    );

  app.get(SIGNUP_PATH, ENTRY_ROUTE, (_request, reply) => form(reply));

  // Its own scope, so the form parser and its body limit reach nothing else.
  void app.register((scope, _options, registered) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: SIGNUP_BODY_LIMIT },
      (_request, body, done) => {
        done(null, new URLSearchParams(body as string));
      },
    );
    scope.post(SIGNUP_PATH, { ...ENTRY_ROUTE, bodyLimit: SIGNUP_BODY_LIMIT }, async (request, reply) => {
      // Another site's form must not make a visitor's browser mail someone.
      if (request.headers.origin !== origin) return reply.code(403).header('cache-control', 'no-store').send();
      const body = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
      const values: SignupFormValues = {
        email: (body.get('email') ?? '').trim(),
        name: body.get('name') ?? '',
        slug: (body.get('slug') ?? '').trim().toLowerCase(),
        seats: (body.get('seats') ?? '').trim(),
      };
      // Every post spends the client's bucket, a refused one too, so neither fields nor slugs can be probed fast.
      if (!clients.take(`ip:${request.ip}`).allowed) return html(reply, renderSignupSent());
      const email = values.email!.toLowerCase();
      if (email.length > 254 || !ENTRY_ADDRESS.test(email)) return form(reply, values, REFUSALS.email);
      const name = teamNameOf(values.name!);
      if (name === undefined) return form(reply, values, REFUSALS.name);
      const seats = seatsOf(values.seats!);
      if (seats === undefined) return form(reply, values, REFUSALS.seats);
      if (!addresses.take(addressBucketKey(bucketKey, email)).allowed) return html(reply, renderSignupSent());
      const slug = values.slug!;
      const token = newSignupToken();
      const state = await options.control.transaction(async (tx) => {
        const found = await slugState(tx, slug);
        if (found !== 'ok') return found;
        await insertSignup(tx, {
          emailLower: email,
          name,
          slug,
          seats,
          tokenHash: signupTokenHash(token),
          expiresAt: new Date(now().getTime() + SIGNUP_TTL_MS),
        });
        return 'ok' as const;
      });
      if (state !== 'ok') return form(reply, values, REFUSALS[state]);
      options.queue.push({ to: email, link: `${origin}${SIGNUP_PATH}/${token}` });
      return html(reply, renderSignupSent());
    });
    registered();
  });
}
