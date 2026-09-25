import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  MAX_SYNC_SUBJECT_LENGTH,
  MAX_TREE_PATH_LENGTH,
  SYNC_COMMIT_ID_PATTERN,
  syncChangeSchema,
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  syncFileSchema,
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  syncLogEntrySchema,
  syncLogQuerySchema,
  syncLogResponseSchema,
  syncPushCommitSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
} from '../../../src/index.js';

const SHA1 = '648f446bd951eca48ddb4f77f8f5e6947c3f72a1';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('server-api sync schemas', () => {
  it('a commit id is a full lower-case SHA-1 or SHA-256, and nothing git could read as more', () => {
    expect(SYNC_COMMIT_ID_PATTERN.test(SHA1) && SYNC_COMMIT_ID_PATTERN.test(SHA256)).toBe(true);
    for (const id of [SHA1, SHA256]) {
      expect(syncCommitIdSchema.parse(id)).toBe(id);
    }
    for (const bad of [
      SHA1.toUpperCase(),
      SHA1.slice(1),
      `${SHA1}0`,
      SHA256.slice(1),
      `-${SHA1.slice(1)}`,
      '--upload-pack=touch',
      `${SHA1}~1`,
      'HEAD',
      'main',
      '',
    ]) {
      expect(syncCommitIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the limits are the spec’s', () => {
    expect(MAX_SYNC_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_SYNC_LOG_LIMIT).toBe(200);
    expect(MAX_SYNC_SUBJECT_LENGTH).toBe(1000);
    expect(MAX_TREE_PATH_LENGTH).toBe(512);
    expect(syncEncodingSchema.options).toEqual(['utf8', 'base64']);
  });

  it('head: a null head for an empty workspace, behind only when counted, and a workspace role', () => {
    expect(syncHeadQuerySchema.parse({})).toEqual({});
    expect(syncHeadQuerySchema.safeParse({ from: 'HEAD' }).success).toBe(false);
    expect(syncHeadResponseSchema.parse({ head: null, commits: 0, role: 'viewer' })).toEqual({
      head: null,
      commits: 0,
      role: 'viewer',
    });
    expect(syncHeadResponseSchema.parse({ head: SHA1, commits: 3, behind: 2, role: 'editor' }).behind).toBe(2);
    for (const bad of [
      { head: null, commits: -1, role: 'viewer' },
      { head: null, commits: 0, behind: 1.5, role: 'viewer' },
      { head: null, commits: 0, role: 'none' },
      { head: 'main', commits: 0, role: 'admin' },
    ]) {
      expect(syncHeadResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('files and changes: a path of 1 to 512 characters, utf8 or base64, null content only for a change', () => {
    const longest = `projects/${'p'.repeat(MAX_TREE_PATH_LENGTH - 'projects/'.length)}`;
    expect(syncFileSchema.parse({ path: longest, encoding: 'base64', content: 'AAEC' }).path).toHaveLength(512);
    for (const bad of [
      { path: `${longest}x`, encoding: 'utf8', content: '' },
      { path: '', encoding: 'utf8', content: '' },
      { path: 'workspace.yaml', encoding: 'latin1', content: '' },
      { path: 'workspace.yaml', encoding: 'utf8', content: null },
    ]) {
      expect(syncFileSchema.safeParse(bad).success).toBe(false);
    }
    expect(syncChangeSchema.parse({ path: 'workspace.yaml', encoding: 'utf8', content: null }).content).toBeNull();
    expect(syncSnapshotQuerySchema.parse({ at: SHA256 })).toEqual({ at: SHA256 });
    expect(syncSnapshotResponseSchema.parse({ head: null, files: [] })).toEqual({ head: null, files: [] });
    expect(syncChangesQuerySchema.parse({ to: SHA1 })).toEqual({ to: SHA1 });
    expect(syncChangesQuerySchema.safeParse({ from: SHA1 }).success).toBe(false);
    expect(
      syncChangesResponseSchema.parse({
        from: null,
        to: SHA1,
        files: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: null }],
      }).files,
    ).toHaveLength(1);
  });

  it('a push: a nullable parent, at least one commit, a subject of 1 to 1000 characters, an ISO time', () => {
    const commit = {
      subject: 'Save',
      at: '2026-09-25T10:00:00.000Z',
      changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: W\n' }],
    };
    expect(syncPushRequestSchema.parse({ parent: null, commits: [commit] }).commits).toHaveLength(1);
    expect(syncPushRequestSchema.safeParse({ parent: SHA1, commits: [] }).success).toBe(false);
    expect(syncPushRequestSchema.safeParse({ parent: 'HEAD', commits: [commit] }).success).toBe(false);
    expect(syncPushCommitSchema.parse({ ...commit, at: '2026-09-25T12:00:00+02:00' }).at).toBe(
      '2026-09-25T12:00:00+02:00',
    );
    for (const bad of [
      { ...commit, subject: '' },
      { ...commit, subject: 'x'.repeat(MAX_SYNC_SUBJECT_LENGTH + 1) },
      { ...commit, at: 'yesterday' },
      { ...commit, at: '2026-09-25' },
    ]) {
      expect(syncPushCommitSchema.safeParse(bad).success).toBe(false);
    }
    expect(syncPushResponseSchema.parse({ head: SHA1, ids: [SHA1] })).toEqual({ head: SHA1, ids: [SHA1] });
  });

  it('log: a limit of 1 to 200 when given, and entries as the server sends them', () => {
    expect(syncLogQuerySchema.parse({})).toEqual({});
    expect(syncLogQuerySchema.parse({ limit: MAX_SYNC_LOG_LIMIT })).toEqual({ limit: 200 });
    for (const limit of [0, MAX_SYNC_LOG_LIMIT + 1, 2.5]) {
      expect(syncLogQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    const entry = { id: SHA1, subject: 'Save', author: 'Ada Lovelace <ada@example.com>', at: '2026-09-25T10:00:00Z' };
    expect(syncLogResponseSchema.parse([entry])).toEqual([entry]);
    expect(syncLogEntrySchema.safeParse({ ...entry, id: 'HEAD' }).success).toBe(false);
  });

  it('every schema is plain zod: it renders as draft-07 JSON Schema, as the routes need', () => {
    const schemas: Readonly<Record<string, z.ZodType>> = {
      syncHeadQuerySchema,
      syncHeadResponseSchema,
      syncSnapshotQuerySchema,
      syncSnapshotResponseSchema,
      syncChangesQuerySchema,
      syncChangesResponseSchema,
      syncPushCommitSchema,
      syncPushRequestSchema,
      syncPushResponseSchema,
      syncLogQuerySchema,
      syncLogEntrySchema,
      syncLogResponseSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      for (const io of ['input', 'output'] as const) {
        expect(() => z.toJSONSchema(schema, { target: 'draft-7', io }), `${name} (${io})`).not.toThrow();
      }
    }
    expect(z.toJSONSchema(syncHeadQuerySchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { from: { type: 'string', pattern: SYNC_COMMIT_ID_PATTERN.source } },
    });
    expect(z.toJSONSchema(syncPushCommitSchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { at: { type: 'string', format: 'date-time' } },
    });
    expect(z.toJSONSchema(syncLogQuerySchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_SYNC_LOG_LIMIT } },
    });
  });
});
