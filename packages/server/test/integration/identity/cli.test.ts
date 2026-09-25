import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/main.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

describeDb('wirebench-server admin (§3.7)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const run = async (args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(args, {
      stdout: { write: (t: string) => stdout.push(t) },
      stderr: { write: (t: string) => stderr.push(t) },
      env: env(),
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  };
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('refuses to run before migrate, then invites, lists and revokes', async () => {
    const early = await run(['admin', 'invite', 'alice@example.com']);
    expect(early.code).toBe(3);
    expect(early.stderr).toContain('wirebench-server migrate');
    expect((await run(['migrate'])).code).toBe(0);

    const invite = await run(['admin', 'invite', 'Alice@example.com']);
    expect(invite.code).toBe(0);
    expect(invite.stdout).toMatch(
      /Invitation for Alice@example\.com \(server admin\)\nhttps:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}\nExpires 2\d{3}-/,
    );
    const again = await run(['admin', 'invite', 'alice@example.com']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('identity-invitation-exists');

    const list = await run(['admin', 'list-invitations']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Alice@example.com');
    expect(list.stdout).toContain('open');
    expect(list.stdout).not.toContain('/invite/');
    const id = /^(\S+)\s+Alice@example\.com/m.exec(list.stdout)?.[1];
    expect(id).toBeDefined();

    expect((await run(['admin', 'revoke-invitation', id!])).code).toBe(0);
    expect((await run(['admin', 'list-invitations'])).stdout).toContain('revoked');
    expect((await run(['admin', 'revoke-invitation', id!])).code).toBe(1);
    const member = await run(['admin', 'invite', 'bob@example.com', '--no-admin']);
    expect(member.stdout).toContain('(member)');
  });

  it('exits 2 on bad configuration without values, like every other command', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['admin', 'invite', 'a@b.co'], {
      stdout: { write: vi.fn() },
      stderr,
      env: { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@x/y' },
    });
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('s3cret');
  });
});
