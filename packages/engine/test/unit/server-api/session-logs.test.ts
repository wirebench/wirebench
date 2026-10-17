import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_GROUPS,
  FEATURES,
  SESSION_LOG_LIMITS,
  sessionLogChunkRequestSchema,
  sessionLogEndRequestSchema,
  sessionLogOpenRequestSchema,
  sessionLogsQuerySchema,
  syncHeadResponseSchema,
  teamWorkspaceSchema,
} from '../../../src/index.js';

const OPEN = {
  clientLogId: '20261017T101500Z-6f1c2d3e',
  hostId: 'web',
  hostName: 'Web',
  address: '10.0.0.1',
  port: 22,
  user: 'deploy',
  startedAt: '2026-10-17T10:15:00.000Z',
};

describe('team session-log wire shapes (team sessions spec part A)', () => {
  it('opens a log named by its #414 id', () => {
    expect(sessionLogOpenRequestSchema.parse(OPEN)).toEqual(OPEN);
    expect(sessionLogOpenRequestSchema.safeParse({ ...OPEN, clientLogId: '../etc' }).success).toBe(false);
    expect(sessionLogOpenRequestSchema.safeParse({ ...OPEN, port: 0 }).success).toBe(false);
  });

  it('takes a chunk as base64 no larger than the chunk limit', () => {
    expect(sessionLogChunkRequestSchema.safeParse({ offset: 0, data: 'aGVsbG8K' }).success).toBe(true);
    expect(sessionLogChunkRequestSchema.safeParse({ offset: -1, data: 'aGVsbG8K' }).success).toBe(false);
    expect(sessionLogChunkRequestSchema.safeParse({ offset: 0, data: 'not base64!' }).success).toBe(false);
    const tooLong = 'A'.repeat(Math.ceil(SESSION_LOG_LIMITS.maxChunkBytes / 3) * 4 + 4);
    expect(sessionLogChunkRequestSchema.safeParse({ offset: 0, data: tooLong }).success).toBe(false);
  });

  it('ends a log with one of the #414 reasons', () => {
    expect(sessionLogEndRequestSchema.safeParse({ endedAt: OPEN.startedAt, reason: 'lost' }).success).toBe(true);
    expect(sessionLogEndRequestSchema.safeParse({ endedAt: OPEN.startedAt, reason: 'gone' }).success).toBe(false);
  });

  it('pages by id with a bounded limit', () => {
    expect(sessionLogsQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20 });
    expect(sessionLogsQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('the workspace and the head carry the recording switch, off by default', () => {
    const workspace = teamWorkspaceSchema.parse({
      id: 'w',
      name: 'W',
      teamId: 't',
      teamName: 'T',
      defaultRole: 'viewer',
      myRole: 'admin',
      source: 'team-admin',
      createdAt: OPEN.startedAt,
    });
    expect(workspace.recordSessionLogs).toBe(false);
    expect(syncHeadResponseSchema.parse({ head: null, commits: 0, role: 'viewer' }).recordSessionLogs).toBe(false);
  });

  it('names the features and audit actions both slices use', () => {
    expect(FEATURES).toEqual(expect.arrayContaining(['session-logs', 'terminal-sharing']));
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['workspace.session_logs_changed']));
    expect(AUDIT_ACTION_GROUPS).toContain('session_log');
  });
});
