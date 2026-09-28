/**
 * Harnesses and seeds for the webhook-capture module (spec §7). `hooksRepoHarness` migrates identity,
 * teams-access and webhook-capture over a fresh schema, which is all the repository tests need; later
 * tasks add the live-capable `hooksHarness` below it.
 */
import { CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import { hooksModule } from '../../src/hooks/module.js';
import * as repo from '../../src/hooks/repo.js';
import { mintCatchSecret } from '../../src/hooks/secret.js';
import { newId } from '../../src/identity/tokens.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness } from './identity.js';

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
