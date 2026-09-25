// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STOP_POLLING_CODES } from '../src/main/sync/server-backend.js';
import {
  shareRefusalMessage,
  STOP_POLLING_SYNC_CODES,
  syncCodeInfo,
} from '../src/renderer/features/sync/sync-codes.js';

describe('the renderer copy of the server-sync codes (spec §3.4, §3.5)', () => {
  it('names exactly the codes main stops polling for', () => {
    expect([...STOP_POLLING_SYNC_CODES].sort()).toEqual([...STOP_POLLING_CODES].sort());
  });

  it('gives every stop-polling code a badge word and the Sign in action', () => {
    for (const code of STOP_POLLING_SYNC_CODES) {
      expect(syncCodeInfo(code)?.badge, code).toBeTruthy();
      expect(syncCodeInfo(code)?.action, code).toBe('sign-in');
    }
  });

  it('sends a history mismatch and a corrupt state to Stop sharing first, Open a team workspace… second (I4)', () => {
    for (const code of ['sync-history-mismatch', 'sync-state-corrupt']) {
      expect(syncCodeInfo(code), code).toEqual({ action: 'stop-sharing', secondaryAction: 'open-team-workspace' });
    }
  });

  it('knows nothing about a git code or an inherited property name, so a git share looks as it did', () => {
    expect(syncCodeInfo('git-offline')).toBeUndefined();
    expect(syncCodeInfo('toString')).toBeUndefined();
    expect(syncCodeInfo(undefined)).toBeUndefined();
  });

  it("words a taken name itself, and shows main's message for anything else", () => {
    expect(shareRefusalMessage({ code: 'teams-workspace-name-taken', message: 'teams-workspace-name-taken' })).toBe(
      'A workspace with that name already exists in this team.',
    );
    expect(shareRefusalMessage({ code: 'sync-reconnect-viewer', message: 'You have viewer access.' })).toBe(
      'You have viewer access.',
    );
  });
});
