import { describe, expect, it } from 'vitest';
import {
  CI_TOKEN_NAME_MAX_LENGTH,
  ciTokenCreateRequestSchema,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
} from '../../../src/index.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WS = '01K000000000000000000000W1';
const ID = '01K000000000000000000000T1';

describe('CI token wire shapes (callback-assertion §3)', () => {
  it('a created token is a wbs_ token beside its id and name', () => {
    expect(ciTokenCreatedSchema.parse({ id: ID, name: 'pipeline-main', token: TOKEN })).toEqual({
      id: ID,
      name: 'pipeline-main',
      token: TOKEN,
    });
    expect(ciTokenCreatedSchema.safeParse({ id: ID, name: 'x', token: 'abc123def456ghi789' }).success).toBe(false);
  });

  it('a listed token never carries the token', () => {
    const [listed] = ciTokensResponseSchema.parse([
      {
        id: ID,
        name: 'pipeline-main',
        createdBy: 'Ada',
        createdAt: '2026-09-29T10:00:00.000Z',
        lastUsedAt: null,
        token: TOKEN,
      },
    ]);
    expect(listed).toEqual({
      id: ID,
      name: 'pipeline-main',
      createdBy: 'Ada',
      createdAt: '2026-09-29T10:00:00.000Z',
      lastUsedAt: null,
    });
  });

  it('bounds the name and the ids', () => {
    expect(CI_TOKEN_NAME_MAX_LENGTH).toBe(64);
    expect(ciTokenCreateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(ciTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(64) }).success).toBe(true);
    expect(ciTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(ciTokenParamsSchema.safeParse({ workspaceId: WS, tokenId: ID }).success).toBe(true);
    expect(ciTokenParamsSchema.safeParse({ workspaceId: WS, tokenId: 'not-an-id' }).success).toBe(false);
  });

  it('whoami names the workspace and the token', () => {
    expect(
      ciWhoamiResponseSchema.parse({ workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' }),
    ).toEqual({ workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' });
  });
});
