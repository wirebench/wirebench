/**
 * `agent.send`, `agent.cancel` and `agent.cookies.clear` (hosted edition spec §18.1, §18.4; ADR-0035): a
 * paired tab hands the agent a send bundle its server built, and the agent sends that one request from this
 * machine.
 *
 * 1. The bundle is checked against `sendBundleSchema`: relative paths only, at most 2000 files and 32 MiB
 *    decoded.
 * 2. Its files are written to `<temp>/agent-sends/<sendId>`, a directory made for this send alone. Each
 *    path is resolved and must stay inside it; each file is created with `wx`, and nothing here makes a
 *    link.
 * 3. The engine's `loadProject` reads it, and the embedder's host sends the one item through the send
 *    path a desktop send uses (`Host.sendFromDirectory`): the host's secret getter and redactor, with the
 *    cookie jar this agent holds for the tab's origin.
 * 4. The directory is removed however the send ended.
 *
 * WebSocket is a session, not a send, so it has no bundle; gRPC and MCP answer `agent-kind-unsupported`
 * until they are added. The jars are held in memory only.
 */
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CookieJar, loadProject, WirebenchError, type CookieJarHost } from '@wirebench/engine';
import type { HostPlatform } from '@wirebench/host';
import {
  AGENT_SEND_KINDS,
  agentCancelRequestSchema,
  agentSendRequestSchema,
  agentSendResponseSchema,
  type AgentSendResponse,
  type SendBundleFile,
} from '@wirebench/wire/agent';
import type { z } from 'zod';
import type { AgentCallContext, AgentHandler } from './server.js';

/** The folder under the platform's temp directory each send's own directory is made in. */
export const AGENT_SENDS_DIR = 'agent-sends';

export interface AgentSendOptions {
  readonly platform: Pick<HostPlatform, 'paths'>;
}

/** What a bundle the agent will not run is answered with: the paths and messages of its faults. */
function invalid(message: string, details?: Record<string, unknown>): WirebenchError {
  return new WirebenchError('agent-bundle-invalid', message, details === undefined ? undefined : { details });
}

/** The schema's faults, by path and message only: never the values that failed. */
function issuesOf(error: z.ZodError): { readonly path: string; readonly message: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Whether the schema refused the bundle for its size: too many files, or too many bytes. */
function overCap(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) =>
      (issue.code === 'custom' && (issue.params as { tooLarge?: unknown } | undefined)?.tooLarge === true) ||
      (issue.code === 'too_big' && issue.path.join('.') === 'bundle.files'),
  );
}

/** The kind a raw request names, if it names one at all; read before the strict parse. */
function kindOf(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const bundle = (raw as { bundle?: unknown }).bundle;
  return typeof bundle === 'object' && bundle !== null ? (bundle as { kind?: unknown }).kind : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The directory sends are made in, created owner-only. On a shared temp directory another account could
 * have made it first, or made it a link: then it is refused rather than written into.
 */
async function sendsRoot(platform: Pick<HostPlatform, 'paths'>): Promise<string> {
  const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  const ownUid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (ownUid !== undefined && stat.uid !== ownUid)) {
    throw new WirebenchError('agent-temp-unsafe', 'The agent’s temporary folder is not its own', {
      details: { dir: root },
    });
  }
  return root;
}

/** Writes `files` under `dir`: each inside it, each a new file. */
async function writeBundle(dir: string, files: readonly SendBundleFile[], signal: AbortSignal): Promise<void> {
  for (const file of files) {
    if (signal.aborted) throw new WirebenchError('aborted', 'The request was aborted.');
    const target = resolve(dir, file.path);
    if (!target.startsWith(dir + sep)) throw invalid('A bundle path leaves its folder', { path: file.path });
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.content, file.encoding), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // A path given twice, or a file where another path needs a folder.
      if (['EEXIST', 'ENOTDIR', 'EISDIR'].includes(codeOf(error) ?? '')) {
        throw invalid('A bundle path clashes with another', { path: file.path });
      }
      throw error;
    }
  }
}

/** A jar as the engine reads and stores into it, on the clock of the moment. */
function jarHost(jar: CookieJar): CookieJarHost {
  return {
    cookiesFor: (url) => jar.cookiesFor(url, Date.now()),
    remember: (url, cookies) => jar.store(url, cookies, Date.now()),
  };
}

/**
 * The three send handlers, for `startAgent({ handlers })`. Each send and each jar belongs to the pairing
 * origin of the tab that called: a tab cancels only its origin's sends and clears only its origin's jar.
 */
export function agentSendHandlers(options: AgentSendOptions): Map<string, AgentHandler> {
  const { platform } = options;
  /** One jar per pairing origin, in memory only (slice 3). */
  const jars = new Map<string, CookieJar>();
  /** The sends running, by send id, and the origin each came from. */
  const running = new Map<string, { readonly origin: string; readonly abort: AbortController }>();

  const jarFor = (origin: string): CookieJar => {
    let jar = jars.get(origin);
    if (jar === undefined) {
      jar = new CookieJar();
      jars.set(origin, jar);
    }
    return jar;
  };

  const send = async (raw: unknown, { pairing, host }: AgentCallContext): Promise<AgentSendResponse> => {
    const kind = kindOf(raw);
    if (typeof kind === 'string' && !(AGENT_SEND_KINDS as readonly string[]).includes(kind)) {
      throw new WirebenchError('agent-kind-unsupported', `The agent does not send ${kind} requests yet`, {
        details: { kind },
      });
    }
    const parsed = agentSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      if (overCap(parsed.error)) {
        throw new WirebenchError('agent-bundle-too-large', 'The bundle is over the agent’s size cap', {
          details: { issues: issuesOf(parsed.error) },
        });
      }
      throw invalid('The bundle is not one the agent can run', { issues: issuesOf(parsed.error) });
    }
    const { sendId, bundle } = parsed.data;
    if (running.has(sendId)) {
      throw new WirebenchError('agent-send-exists', 'A send with that id is already running', { details: { sendId } });
    }
    const abort = new AbortController();
    running.set(sendId, { origin: pairing.origin, abort });
    let dir: string | undefined;
    try {
      const root = await sendsRoot(platform);
      const candidate = join(root, sendId);
      try {
        // Not recursive: the directory must be new, made for this send.
        await mkdir(candidate, { mode: 0o700 });
      } catch (error) {
        if (codeOf(error) === 'EEXIST') {
          throw new WirebenchError('agent-send-exists', 'A send with that id is already running', {
            details: { sendId },
          });
        }
        throw error;
      }
      dir = candidate;
      await writeBundle(dir, bundle.files, abort.signal);
      try {
        await loadProject(dir);
      } catch (error) {
        throw invalid('The bundle does not load as a project', {
          reason: error instanceof Error ? error.message.replaceAll(dir, '<bundle>') : 'unknown',
        });
      }
      const result = await host.sendFromDirectory({
        sendId,
        projectDir: dir,
        itemId: bundle.itemId,
        ...(bundle.environment !== undefined ? { environment: bundle.environment } : {}),
        kind: bundle.kind,
        cookies: jarHost(jarFor(pairing.origin)),
        signal: abort.signal,
      });
      return agentSendResponseSchema.parse({ ...result, sentFrom: 'agent' });
    } finally {
      running.delete(sendId);
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  };

  const cancel = (raw: unknown, { pairing }: AgentCallContext): Promise<{ cancelled: boolean }> => {
    const parsed = agentCancelRequestSchema.safeParse(raw);
    if (!parsed.success) return Promise.reject(invalid('Not a cancel request', { issues: issuesOf(parsed.error) }));
    const entry = running.get(parsed.data.sendId);
    // Another origin's send is not this tab's to stop, nor is one that already ended.
    if (entry?.origin !== pairing.origin || entry.abort.signal.aborted) return Promise.resolve({ cancelled: false });
    entry.abort.abort();
    return Promise.resolve({ cancelled: true });
  };

  const clearCookies = (_raw: unknown, { pairing }: AgentCallContext): Promise<undefined> => {
    jars.delete(pairing.origin);
    return Promise.resolve(undefined);
  };

  return new Map<string, AgentHandler>([
    ['agent.send', send],
    ['agent.cancel', cancel],
    ['agent.cookies.clear', clearCookies],
  ]);
}
