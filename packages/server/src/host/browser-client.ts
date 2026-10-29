/**
 * The browser tab's page and files at the root (hosted edition spec §17.2, §17.6), registered through the
 * host module's `registerPublic` only when the browser client is on. The build is the desktop renderer's
 * Vite build (`apps/desktop/dist-browser`), which `copy-browser` copies to `dist/browser/` after the
 * server's `build`:
 *
 * - `GET /`, and any other page path, since the renderer is one page: `index.html` for a signed-in browser
 *   session, else a `303` to `/sign-in` carrying the path as `redirect_to`. The page goes out with
 *   `no-store`, so a signed-out browser never shows it from its cache, and with the §17.6 policy as a
 *   header, the only place `frame-ancestors` takes effect.
 * - `/assets/*`: the hashed files, without a session (they hold the renderer's code, no data), cached as
 *   immutable. `@fastify/static` serves them with `wildcard: false`: it lists the folder once at start-up
 *   and registers one route per file, so a request names a file that exists or matches no asset route at
 *   all, and no request path is ever joined onto the folder.
 *
 * These routes sit outside `/api/v1` and its guard, so the session is resolved here, by the guard's own
 * `callerForToken` with `via: 'cookie'`: a `browser` token, neither revoked nor expired, of an enabled user.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isWirebenchError } from '@wirebench/engine';
import type { ServerContext } from '../context.js';
import { safeRedirectPath } from '../identity/browser-flows.js';
import { sessionToken } from '../identity/cookies.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';

/** The copied build, beside this file's compiled output; the same path from `src/host/` under a test. */
export const BROWSER_BUILD_DIR = fileURLToPath(new URL('../../dist/browser/', import.meta.url));

/** Spec §17.6, verbatim; the build's meta tag carries the same policy less `frame-ancestors`, which only a header can. */
export const BROWSER_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:47615 ws://127.0.0.1:47616 ws://127.0.0.1:47617 ws://127.0.0.1:47618 ws://127.0.0.1:47619 ws://127.0.0.1:47620 ws://127.0.0.1:47621 ws://127.0.0.1:47622 ws://127.0.0.1:47623 ws://127.0.0.1:47624 ws://127.0.0.1:47625 ws://127.0.0.1:47626 ws://127.0.0.1:47627 ws://127.0.0.1:47628 ws://127.0.0.1:47629 ws://127.0.0.1:47630 ws://127.0.0.1:47631 ws://127.0.0.1:47632 ws://127.0.0.1:47633 ws://127.0.0.1:47634; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** `name-<hash>.ext`, as the Vite build names every file under `assets/`: an 8-character base64url hash. */
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

const ASSETS_PREFIX = '/assets/';
/**
 * First segments that are never the page, compared once decoded (`/%61pi` is `/api`): the API answers its
 * own `404`, and a missing asset is a missing file.
 */
const NOT_PAGES = new Set(['api', 'assets']);

/** On every response these routes send. */
function commonHeaders(reply: FastifyReply): void {
  reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
}

/**
 * Whether `path` (the raw request path, still encoded) is one a page could have: no `.` or `..` segment
 * and no empty one inside it, nothing that decodes to a slash, a backslash or a control character, and a
 * first segment that, decoded, is not one of {@link NOT_PAGES}. A page path never needs the others, and
 * refusing them keeps every traversal spelling (`/../x`, `%2e%2e`, `..%2f`) a plain `404` rather than a page.
 */
function isPagePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.slice(1).split('/');
  for (const [index, raw] of segments.entries()) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (index === 0 && NOT_PAGES.has(segment)) return false;
    if (segment === '' && index < segments.length - 1) return false; // `//`; a trailing slash is fine
    if (segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment)) return false;
  }
  return true;
}

/** `/sign-in?redirect_to=<path>`, the path's slashes left as they are (a query may hold them). */
function signInLocation(request: FastifyRequest, publicUrl: string): string {
  const target = safeRedirectPath(request.url, publicUrl);
  return `/sign-in?redirect_to=${encodeURIComponent(target).replaceAll('%2F', '/')}`;
}

export interface BrowserClientOptions {
  /** The build's folder; {@link BROWSER_BUILD_DIR} unless a test names a fixture. */
  readonly root?: string;
  /** Injected clock, shared with identity's in tests: token expiry. */
  readonly now?: () => Date;
}

/**
 * Registers the page and the asset routes on `app` (the root scope). It reads `index.html` once, here, so
 * a server whose build is missing fails to start, as one without the host bundle does, rather than on the
 * first visit.
 */
export async function browserClientRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  options: BrowserClientOptions = {},
): Promise<void> {
  const root = options.root ?? BROWSER_BUILD_DIR;
  const now = options.now ?? (() => new Date());
  const publicUrl = ctx.config.publicUrl;
  let page: Buffer;
  try {
    page = await readFile(join(root, 'index.html'));
  } catch (error) {
    throw new Error(
      `The browser client is not built (no index.html in ${root}); run \`pnpm --filter @wirebench/desktop build:browser\`, then \`pnpm --filter @wirebench/server copy-browser\``,
      { cause: error },
    );
  }
  const tokens = { db: ctx.db, settings: identitySettings(ctx.config), now };

  await app.register(fastifyStatic, {
    root: join(root, 'assets'),
    prefix: ASSETS_PREFIX,
    wildcard: false,
    index: false,
    dotfiles: 'deny',
    decorateReply: false,
    // Set per file below: a hashed name never changes content, anything else is revalidated.
    cacheControl: false,
    setHeaders: (reply, path) => {
      commonHeaders(reply);
      reply.header('cache-control', HASHED_NAME.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  /** Whether the request carries a live browser session, by every check the guard makes. */
  const signedIn = async (request: FastifyRequest): Promise<boolean> => {
    const token = sessionToken(request, publicUrl);
    if (token === undefined) return false;
    try {
      await callerForToken(tokens, token, 'cookie');
      return true;
    } catch (error) {
      if (
        isWirebenchError(error) &&
        (error.code === 'identity-unauthenticated' || error.code === 'identity-user-disabled')
      )
        return false;
      throw error;
    }
  };

  const servePage = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const path = request.raw.url?.split('?', 1)[0] ?? '/';
    if (!isPagePath(path)) {
      reply.callNotFound();
      return reply;
    }
    commonHeaders(reply);
    reply.header('cache-control', 'no-store');
    if (!(await signedIn(request)))
      return reply.code(303).header('location', signInLocation(request, publicUrl)).send();
    return reply
      .header('content-security-policy', BROWSER_CONTENT_SECURITY_POLICY)
      .type('text/html; charset=utf-8')
      .send(page);
  };

  app.get('/', servePage);
  // Every other path no route claims: the renderer's own pages (`/workspaces/…`) load the same page.
  app.get('/*', servePage);
}
