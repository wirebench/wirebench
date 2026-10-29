/**
 * The agent's allowlist classifies every channel of the wire registry (hosted edition spec §18.1,
 * ADR-0035): a browser caller reaches `agent.*` and nothing else, so a channel added to the registry later
 * is refused until someone decides otherwise.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_CAPABILITIES } from '@wirebench/wire/capabilities';
import { BROWSER_CAPABILITIES, browserCapabilities, isAgentChannel } from '../src/allowlist.js';
import { registryChannelNames } from './helpers.js';

const PINNED = new URL('../../../apps/desktop/test/fixtures/ipc-names.json', import.meta.url);

describe('the agent allowlist (§18.1)', () => {
  it('walks the whole registry: the same names the desktop pins', () => {
    const pinned = JSON.parse(readFileSync(PINNED, 'utf8')) as { readonly channels: readonly string[] };
    expect(registryChannelNames()).toEqual([...pinned.channels].sort());
    expect(registryChannelNames()).toContain('fs.openText');
  });

  it('refuses every registry channel outside agent.*, and serves agent.* only', () => {
    const served = registryChannelNames().filter(isAgentChannel);
    expect(served.every((name) => name.startsWith('agent.'))).toBe(true);
    const refused = registryChannelNames().filter((name) => !isAgentChannel(name));
    expect(refused.filter((name) => name.startsWith('agent.'))).toEqual([]);
  });

  it('reads the group exactly: no prefix trick reaches it', () => {
    expect(isAgentChannel('agent.hello')).toBe(true);
    expect(isAgentChannel('agent.send')).toBe(true);
    for (const name of ['agent', 'agent.', 'agents.hello', 'agentx.send', 'Agent.hello', 'fs.agent.read', '']) {
      expect(isAgentChannel(name), name).toBe(false);
    }
  });

  it('tells a browser only the send-time capabilities, never the renderer-gated ones or ssh', () => {
    for (const capability of [
      'files',
      'dialogs',
      'pty',
      'ssh',
      'processes',
      'listen',
      'windows',
      'accounts',
      'reveal-secrets',
      'updates',
      'app-lock',
    ] as const) {
      expect(BROWSER_CAPABILITIES.has(capability), capability).toBe(false);
    }
    expect(browserCapabilities(new Set(ALL_CAPABILITIES))).toEqual([
      'kerberos',
      'send:private',
      'send:public',
      'secret-sources',
      'team-secrets',
    ]);
    expect(browserCapabilities(new Set(['files', 'send:public']))).toEqual(['send:public']);
  });
});
