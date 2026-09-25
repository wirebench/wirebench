// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { withToken, type TokenSource } from '../src/main/server-token.js';

const TOKEN = `wbs_${'A'.repeat(43)}`;

function accounts(token: string | undefined) {
  return {
    tokenFor: vi.fn((): Promise<string | undefined> => Promise.resolve(token)),
    markSignedOut: vi.fn((): void => undefined),
  } satisfies TokenSource;
}

/** No `vi.mock('electron')` here: the module must load in plain Node, as the server package loads it (O4). */
describe('withToken (server-sync §3.1, lifted from ipc/team.ts)', () => {
  it('calls with the normalised origin and the account token', async () => {
    const a = accounts(TOKEN);
    const call = vi.fn((origin: string, token: string) => Promise.resolve(`${origin}|${token}`));
    expect(await withToken({ accounts: a }, ' https://WB.test/some/path ', call)).toBe(`https://wb.test|${TOKEN}`);
    expect(a.tokenFor).toHaveBeenCalledWith('https://wb.test');
  });

  it('with no token answers account-signed-out and never calls the server', async () => {
    const a = accounts(undefined);
    const call = vi.fn(() => Promise.resolve('never'));
    await expect(withToken({ accounts: a }, 'https://wb.test', call)).rejects.toMatchObject({
      code: 'account-signed-out',
      message: 'Sign in to https://wb.test first.',
    });
    expect(call).not.toHaveBeenCalled();
    expect(a.markSignedOut).not.toHaveBeenCalled();
  });

  it('a rejected token marks the account signed out and the same error reaches the caller', async () => {
    const a = accounts(TOKEN);
    const rejected = new WirebenchError('identity-unauthenticated', 'Sign in to continue.');
    await expect(withToken({ accounts: a }, 'https://wb.test', () => Promise.reject(rejected))).rejects.toBe(rejected);
    expect(a.markSignedOut).toHaveBeenCalledWith('https://wb.test');
  });

  it('any other failure passes through without touching the account', async () => {
    const a = accounts(TOKEN);
    const other = new WirebenchError('teams-workspace-not-found', 'Workspace not found.');
    await expect(withToken({ accounts: a }, 'https://wb.test', () => Promise.reject(other))).rejects.toBe(other);
    expect(a.markSignedOut).not.toHaveBeenCalled();
  });
});
