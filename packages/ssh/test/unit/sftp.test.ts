import { describe, expect, it } from 'vitest';
import { SftpError, joinRemote, parentRemote, remoteEntryOf, sftpErrorOf } from '../../src/index.js';

const attrs = (mode: number, size = 0, mtime = 0) => ({ mode, size, mtime, atime: 0, uid: 0, gid: 0 });

describe('joinRemote', () => {
  it('joins with one slash', () => {
    expect(joinRemote('/', 'a')).toBe('/a');
    expect(joinRemote('/a/', 'b')).toBe('/a/b');
    expect(joinRemote('/a', 'b')).toBe('/a/b');
  });
  it('refuses a name with a slash in it', () => {
    expect(() => joinRemote('/a', 'b/c')).toThrow(SftpError);
  });
});

describe('parentRemote', () => {
  it('drops the last part', () => {
    expect(parentRemote('/a/b')).toBe('/a');
    expect(parentRemote('/a')).toBe('/');
    expect(parentRemote('/a/b/')).toBe('/a');
  });
  it('the parent of / is /', () => {
    expect(parentRemote('/')).toBe('/');
    expect(parentRemote('//')).toBe('/');
  });
  it('trims a long run of trailing slashes in linear time', () => {
    expect(parentRemote(`/a/b${'/'.repeat(100_000)}`)).toBe('/a');
  });
});

describe('remoteEntryOf', () => {
  it('reads the type from the file type bits and keeps the permission bits', () => {
    expect(remoteEntryOf('f', attrs(0o100644, 12, 1_700_000_000))).toEqual({
      name: 'f',
      type: 'file',
      size: 12,
      mtime: 1_700_000_000_000,
      mode: 0o644,
    });
    expect(remoteEntryOf('d', attrs(0o040755)).type).toBe('dir');
    expect(remoteEntryOf('d', attrs(0o041777)).mode).toBe(0o1777);
    expect(remoteEntryOf('s', attrs(0o120777)).type).toBe('symlink');
    expect(remoteEntryOf('p', attrs(0o010644)).type).toBe('other');
  });
  it('carries a symlink target type', () => {
    expect(remoteEntryOf('s', attrs(0o120777), 'dir')).toMatchObject({ type: 'symlink', targetType: 'dir' });
  });
});

describe('sftpErrorOf', () => {
  const status = (code: number) => Object.assign(new Error('server said no'), { code });
  it('maps NO_SUCH_FILE to sftp-not-found', () => {
    expect(sftpErrorOf(status(2), 'stat', '/x')).toMatchObject({
      code: 'sftp-not-found',
      details: { path: '/x', op: 'stat' },
    });
  });
  it('maps PERMISSION_DENIED to sftp-permission-denied', () => {
    expect(sftpErrorOf(status(3), 'list', '/x')).toMatchObject({
      code: 'sftp-permission-denied',
      details: { path: '/x', op: 'list' },
    });
  });
  it('maps FAILURE on mkdir or rename to sftp-exists', () => {
    expect(sftpErrorOf(status(4), 'mkdir', '/x').code).toBe('sftp-exists');
    expect(sftpErrorOf(status(4), 'rename', '/x').code).toBe('sftp-exists');
  });
  it('maps any other status to sftp-failed with the status', () => {
    expect(sftpErrorOf(status(4), 'remove', '/x')).toMatchObject({
      code: 'sftp-failed',
      details: { path: '/x', op: 'remove', status: 4 },
    });
    expect(sftpErrorOf(status(8), 'chmod', '/x')).toMatchObject({ code: 'sftp-failed', details: { status: 8 } });
  });
  it('a failure without a status is sftp-failed and never carries the library message', () => {
    const error = sftpErrorOf(new Error('No response from server'), 'read', '/x');
    expect(error).toBeInstanceOf(SftpError);
    expect(error.code).toBe('sftp-failed');
    expect(error.details).toEqual({ path: '/x', op: 'read' });
    expect(error.message).not.toContain('No response');
  });
  it('passes an SftpError through', () => {
    const original = new SftpError('sftp-exists', '/x exists', { path: '/x', op: 'rename' });
    expect(sftpErrorOf(original, 'rename', '/y')).toBe(original);
  });
});
