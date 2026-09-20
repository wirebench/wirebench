import { describe, expect, it } from 'vitest';
import { wsToCommand } from '../../../src/ws/command.js';

describe('wsToCommand', () => {
  it('renders a websocat line with headers and no flags', () => {
    const command = wsToCommand({ url: 'wss://example.test/chat', headers: { 'X-Trace': 'abc' } });
    expect(command).toBe("websocat -H='X-Trace: abc' 'wss://example.test/chat'");
  });

  it('adds -k when insecure and --protocol for subprotocols', () => {
    const command = wsToCommand(
      { url: 'wss://example.test/chat', headers: {}, subprotocols: ['chat.v2', 'chat.v3'] },
      { insecure: true },
    );
    expect(command).toBe("websocat -k --protocol 'chat.v2,chat.v3' 'wss://example.test/chat'");
  });

  it('survives a header value containing a single quote', () => {
    const command = wsToCommand({ url: 'wss://example.test/chat', headers: { Authorization: "it's a token" } });
    expect(command).toBe(`websocat -H='Authorization: it'\\''s a token' 'wss://example.test/chat'`);
  });
});
