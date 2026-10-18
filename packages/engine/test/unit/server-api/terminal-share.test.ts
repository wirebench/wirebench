import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_GROUPS,
  AUDIT_TARGET_KINDS,
  FEATURES,
  TERMINAL_SHARE_CAPABILITY,
  TERMINAL_SHARE_LIMITS,
  formatTerminalShareInvite,
  parseTerminalShareInvite,
  terminalShareClientMessageSchema,
  terminalShareCreateRequestSchema,
  terminalShareServerMessageSchema,
} from '../../../src/index.js';

const WS = '01HZY3K8J9V7Q2W5N4M6P1R0ST';
const SHARE = 'abcdefghijklmnopqrstuvwxyz';

describe('terminal-share wire shapes (team sessions spec part B)', () => {
  it('names the feature, the audit actions, group and target kind', () => {
    expect(FEATURES).toContain(TERMINAL_SHARE_CAPABILITY);
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'terminal_share.started',
        'terminal_share.joined',
        'terminal_share.control_granted',
        'terminal_share.control_returned',
        'terminal_share.viewer_removed',
        'terminal_share.ended',
      ]),
    );
    expect(AUDIT_ACTION_GROUPS).toContain('terminal_share');
    expect(AUDIT_TARGET_KINDS).toContain('terminal-share');
  });

  it('creates a share for a host at a terminal size', () => {
    expect(terminalShareCreateRequestSchema.parse({ hostName: 'web', cols: 80, rows: 24 })).toEqual({
      hostName: 'web',
      cols: 80,
      rows: 24,
    });
    expect(terminalShareCreateRequestSchema.safeParse({ hostName: '', cols: 80, rows: 24 }).success).toBe(false);
    expect(terminalShareCreateRequestSchema.safeParse({ hostName: 'web', cols: 0, rows: 24 }).success).toBe(false);
  });

  it('accepts each client message and refuses a bad share id or oversized input', () => {
    for (const message of [
      { type: 'auth', token: 'wbt_x', workspaceId: WS, shareId: SHARE },
      { type: 'ping' },
      { type: 'resize', cols: 120, rows: 40 },
      { type: 'grant', userId: WS },
      { type: 'decline', userId: WS },
      { type: 'take-back' },
      { type: 'remove', userId: WS },
      { type: 'end' },
      { type: 'request-control' },
      { type: 'release' },
      { type: 'input', data: Buffer.from('ls\r').toString('base64') },
    ]) {
      expect(terminalShareClientMessageSchema.parse(message)).toEqual(message);
    }
    const auth = { type: 'auth', token: 'wbt_x', workspaceId: WS };
    expect(terminalShareClientMessageSchema.safeParse({ ...auth, shareId: 'ABC' }).success).toBe(false);
    const big = Buffer.alloc(TERMINAL_SHARE_LIMITS.maxInputBytes + 3).toString('base64');
    expect(terminalShareClientMessageSchema.safeParse({ type: 'input', data: big }).success).toBe(false);
    expect(terminalShareClientMessageSchema.safeParse({ type: 'input', data: 'not base64!' }).success).toBe(false);
    // The largest input still fits in one socket message.
    const max = Buffer.alloc(TERMINAL_SHARE_LIMITS.maxInputBytes).toString('base64');
    expect(JSON.stringify({ type: 'input', data: max }).length).toBeLessThan(TERMINAL_SHARE_LIMITS.maxMessageBytes);
  });

  it('parses the server messages', () => {
    expect(
      terminalShareServerMessageSchema.parse({
        type: 'presence',
        owner: { userId: WS, name: 'Alice' },
        viewers: [{ userId: WS, name: 'Bob', control: false, requesting: true }],
      }).type,
    ).toBe('presence');
    expect(terminalShareServerMessageSchema.parse({ type: 'control', userId: null })).toEqual({
      type: 'control',
      userId: null,
    });
    expect(terminalShareServerMessageSchema.safeParse({ type: 'ended', reason: 'nope' }).success).toBe(false);
  });

  it('formats and parses an invite link', () => {
    const link = formatTerminalShareInvite({ server: 'https://wb.example', workspaceId: WS, shareId: SHARE });
    expect(link).toBe(`wirebench://terminal-share/${SHARE}?server=https%3A%2F%2Fwb.example&workspace=${WS}`);
    expect(parseTerminalShareInvite(`  ${link}\n`)).toEqual({
      server: 'https://wb.example',
      workspaceId: WS,
      shareId: SHARE,
    });
    expect(parseTerminalShareInvite('https://wb.example')).toBeUndefined();
    expect(parseTerminalShareInvite(link.replace(SHARE, 'short'))).toBeUndefined();
    expect(parseTerminalShareInvite(link.replace('https%3A', 'file%3A'))).toBeUndefined();
    expect(parseTerminalShareInvite(`wirebench://terminal-share/${SHARE}?server=https://wb.example`)).toBeUndefined();
  });
});
