// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { channels, events } from '@wirebench/wire/ipc';
import {
  sftpChmodRequestSchema,
  sftpCopyRequestSchema,
  sftpListRequestSchema,
  sftpRemoveRequestSchema,
} from '@wirebench/wire/sftp-wire';

const REMOTE = { kind: 'remote', sessionId: 's1' } as const;

describe('sftp wire', () => {
  it('each request schema refuses an unknown key', () => {
    const requests: [{ safeParse(value: unknown): { success: boolean } }, Record<string, unknown>][] = [
      [channels.sftp.open.request, { hostId: 'a' }],
      [channels.sftp.close.request, { sessionId: 's1' }],
      [channels.sftp.list.request, { place: REMOTE, path: '/' }],
      [channels.sftp.mkdir.request, { place: REMOTE, path: '/a' }],
      [channels.sftp.rename.request, { place: REMOTE, from: '/a', to: '/b' }],
      [channels.sftp.remove.request, { place: REMOTE, paths: ['/a'], recursive: false }],
      [channels.sftp.chmod.request, { place: REMOTE, path: '/a', mode: 0o644 }],
      [
        channels.sftp.copy.request,
        { batchId: 'b', from: { place: { kind: 'local' }, paths: ['/x'] }, to: { place: REMOTE, dir: '/' } },
      ],
      [channels.sftp.resolve.request, { batchId: 'b', decision: 'skip', applyToRest: false }],
      [channels.sftp.cancel.request, { transferId: 't' }],
      [channels.sftp.retry.request, { transferId: 't' }],
      [channels.sftp.localHome.request, {}],
      [channels.sftp.edit.request, { sessionId: 's1', path: '/a' }],
      [channels.sftp.endEdit.request, { editId: 'e' }],
      [channels.sftp.editReply.request, { editId: 'e', decision: 'overwrite' }],
    ];
    for (const [schema, valid] of requests) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    }
  });

  it('a place refuses an unknown key too', () => {
    expect(sftpListRequestSchema.safeParse({ place: { kind: 'local', sessionId: 's1' }, path: '/' }).success).toBe(
      false,
    );
  });

  it('chmod.mode is permission bits: 0 to 0o7777, integers only', () => {
    const at = (mode: number) => sftpChmodRequestSchema.safeParse({ place: REMOTE, path: '/a', mode }).success;
    expect(at(0)).toBe(true);
    expect(at(0o7777)).toBe(true);
    expect(at(-1)).toBe(false);
    expect(at(0o10000)).toBe(false);
    expect(at(1.5)).toBe(false);
  });

  it('place.kind is local or remote only, and a remote place needs its session', () => {
    expect(sftpListRequestSchema.safeParse({ place: { kind: 'other' }, path: '/' }).success).toBe(false);
    expect(sftpListRequestSchema.safeParse({ place: { kind: 'remote' }, path: '/' }).success).toBe(false);
    expect(sftpListRequestSchema.safeParse({ place: { kind: 'local' }, path: '/' }).success).toBe(true);
  });

  it('remove.paths and copy.from.paths refuse an empty array', () => {
    expect(sftpRemoveRequestSchema.safeParse({ place: REMOTE, paths: [], recursive: true }).success).toBe(false);
    expect(
      sftpCopyRequestSchema.safeParse({
        batchId: 'b',
        from: { place: REMOTE, paths: [] },
        to: { place: { kind: 'local' }, dir: '/tmp' },
      }).success,
    ).toBe(false);
  });

  it('every event of the design is declared', () => {
    expect(
      Object.values(events.sftp)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['sftp.closed', 'sftp.conflict', 'sftp.edit', 'sftp.transfer']);
  });
});
