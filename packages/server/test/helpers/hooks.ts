/**
 * Harnesses and seeds for the webhook-capture module (spec §7). `hooksRepoHarness` migrates identity,
 * teams-access and webhook-capture over a fresh schema, which is all the repository tests need; later
 * tasks add the live-capable `hooksHarness` below it.
 */
import { CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import type { SignatureScheme } from '@wirebench/engine';
import { hooksModule } from '../../src/hooks/module.js';
import * as repo from '../../src/hooks/repo.js';
import { hintOf, seal } from '../../src/hooks/secret-box.js';
import { mintCatchSecret } from '../../src/hooks/secret.js';
import { newId } from '../../src/identity/tokens.js';
import { liveModule } from '../../src/live/module.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness } from './identity.js';
import { manualTimers, type ManualTimers } from './timers.js';

export function hooksRepoHarness(): Promise<IdentityHarness> {
  return identityHarness({ modules: (clock) => [teamsModule({ now: () => clock.now }), hooksModule()] });
}

/** A catch URL written straight into the table, for tests that are not about creating one. */
export function seedCatchUrl(
  h: IdentityHarness,
  workspaceId: string,
  name: string,
  patch: Partial<Pick<repo.CatchUrlRow, 'enabled' | 'response' | 'secret'>> = {},
): Promise<repo.CatchUrlRow> {
  return repo.insertCatchUrl(h.db, {
    id: newId(),
    workspaceId,
    name,
    secret: patch.secret ?? mintCatchSecret(),
    enabled: patch.enabled ?? true,
    response: patch.response ?? CATCH_URL_DEFAULT_RESPONSE,
    createdBy: null,
    at: h.clock.now,
  });
}

const newCaptureId = repo.captureIdFactory();

/** A capture to insert; ids are monotonic ULIDs unless `patch.id` says otherwise. */
export function newCapture(catchUrlId: string, patch: Partial<repo.NewCapture> = {}): repo.NewCapture {
  return {
    id: newCaptureId(),
    catchUrlId,
    receivedAt: new Date('2026-09-28T10:00:00.000Z'),
    method: 'POST',
    subpath: '/events',
    query: '',
    headers: [['Content-Type', 'application/json']],
    body: Buffer.from('{}'),
    bodySize: 2,
    truncated: false,
    sourceIp: '203.0.113.9',
    ...patch,
  };
}

/** A signature written straight into the row (webhook-signatures §3.2), sealed under `key`. */
export async function seedSignature(
  h: IdentityHarness,
  hookId: string,
  input: {
    readonly scheme: SignatureScheme;
    readonly secret: string;
    readonly key: Buffer;
    readonly rejectUnverified?: boolean;
  },
): Promise<void> {
  await repo.updateCatchUrl(h.db, hookId, {
    signature: { scheme: input.scheme, sealedSecret: seal(input.key, input.secret), hint: hintOf(input.secret) },
    ...(input.rejectUnverified !== undefined ? { rejectUnverified: input.rejectUnverified } : {}),
  });
}

export interface HooksHarness extends IdentityHarness {
  readonly port: number;
  /** Shared by webhook-capture and live-updates: the response delay, the sweep, the coalescing window and the heartbeat. */
  readonly timers: ManualTimers;
}

/** Identity, teams-access, webhook-capture and live-updates on the harness clock, listening on 127.0.0.1:0. */
export async function hooksHarness(
  options: { readonly env?: Record<string, string>; readonly logStream?: NodeJS.WritableStream } = {},
): Promise<HooksHarness> {
  const timers = manualTimers();
  const h = await identityHarness({
    ...options,
    modules: (clock) => [
      teamsModule({ now: () => clock.now }),
      hooksModule({ now: () => clock.now, setTimer: timers.setTimer }),
      liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
    ],
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the hooks harness is not listening on a port');
  return { ...h, port: address.port, timers };
}
