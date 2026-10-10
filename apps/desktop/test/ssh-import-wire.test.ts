// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  sshImportApplyRequestSchema,
  sshImportPreviewRequestSchema,
  sshImportPreviewResponseSchema,
} from '../src/shared/ssh-wire.js';

const PREVIEW = {
  previewId: 'p1',
  source: '~/.ssh/config',
  group: { id: 'ssh-config', name: 'SSH config', ssh: { auth: { kind: 'agent' } } },
  hosts: [{ alias: 'web', id: 'web', status: 'new', address: 'web', ssh: { auth: { kind: 'key', ref: 'k1' } } }],
  keys: [{ ref: 'k1', display: '~/.ssh/id_ed25519', hosts: ['web'], proposedSecret: 'ssh_key_id_ed25519' }],
  report: { problems: [], skipped: [], ignored: [], notes: [] },
};

describe('ssh import wire', () => {
  it('takes a source, never a path', () => {
    expect(sshImportPreviewRequestSchema.safeParse({ source: 'pick' }).success).toBe(true);
    expect(sshImportPreviewRequestSchema.safeParse({ source: 'pick', path: '/etc/passwd' }).success).toBe(false);
    expect(sshImportPreviewRequestSchema.safeParse({ source: '/home/u/.ssh/config' }).success).toBe(false);
  });

  it('carries a preview or a cancellation', () => {
    expect(sshImportPreviewResponseSchema.parse(PREVIEW)).toEqual(PREVIEW);
    expect(sshImportPreviewResponseSchema.parse({ cancelled: true })).toEqual({ cancelled: true });
  });

  it('refuses a key row that carries its path', () => {
    const leaky = { ...PREVIEW, keys: [{ ...PREVIEW.keys[0], path: '/home/u/.ssh/id_ed25519' }] };
    expect(sshImportPreviewResponseSchema.safeParse(leaky).success).toBe(false);
  });

  it('needs a group name and names keys by ref with a choice', () => {
    const base = { previewId: 'p1', groupName: 'SSH config', importDuplicates: [], keys: [] };
    expect(sshImportApplyRequestSchema.safeParse(base).success).toBe(true);
    expect(sshImportApplyRequestSchema.safeParse({ ...base, groupName: '   ' }).success).toBe(false);
    expect(
      sshImportApplyRequestSchema.safeParse({ ...base, keys: [{ ref: 'k1', choice: { kind: 'store', secret: 'k' } }] })
        .success,
    ).toBe(true);
    expect(
      sshImportApplyRequestSchema.safeParse({ ...base, keys: [{ ref: 'k1', choice: { kind: 'read', path: '/x' } }] })
        .success,
    ).toBe(false);
  });
});
