import { describe, expect, it } from 'vitest';
import { parseHostsFile, resolveHost, serializeHostsFile, SshModelError } from '../../src/index.js';

const FILE = `
version: 1
groups:
  - id: prod
    name: Production
    terminal: { scheme: red, fontSize: 15 }
    groups:
      - id: eu
        name: EU
        terminal: { scheme: solarized-dark }
        hosts:
          - id: api-1
            name: api-1
            address: 10.0.1.5
            terminal: { fontSize: 18 }
          - { id: api-2, name: api-2, address: 10.0.1.6 }
hosts:
  - { id: bare, name: bare, address: 10.9.9.9 }
`;

function refusal(text: string): SshModelError {
  try {
    parseHostsFile(text);
  } catch (error) {
    if (error instanceof SshModelError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const one = (terminal: string): string =>
  `version: 1\nhosts:\n  - { id: a, name: a, address: a, terminal: ${terminal} }\n`;

describe('terminal in hosts.yaml', () => {
  it('reads terminal on hosts and groups; an entry without it has none', () => {
    const file = parseHostsFile(FILE);
    expect(file.groups[0]?.terminal).toEqual({ scheme: 'red', fontSize: 15 });
    expect(file.groups[0]?.groups[0]?.hosts[0]?.terminal).toEqual({ fontSize: 18 });
    expect(file.hosts[0]?.terminal).toBeUndefined();
  });

  it('an empty block is no terminal', () => {
    expect(parseHostsFile(one('{}')).hosts[0]?.terminal).toBeUndefined();
  });

  it('refuses a font size out of range or fractional, and a scheme that is not an id', () => {
    expect(refusal(one('{ fontSize: 200 }')).code).toBe('ssh-hosts-invalid');
    expect(refusal(one('{ fontSize: 12.5 }')).code).toBe('ssh-hosts-invalid');
    expect(refusal(one("{ scheme: 'Not An Id' }")).message).toMatch(/hosts\[0\]\.terminal\.scheme/);
  });

  it('refuses a key it does not know', () => {
    expect(refusal(one('{ font: Menlo }')).code).toBe('ssh-hosts-invalid');
  });

  it('resolves each field from the nearest level that sets it', () => {
    const file = parseHostsFile(FILE);
    expect(resolveHost(file, 'api-1').terminal).toEqual({
      scheme: { value: 'solarized-dark', from: { group: 'eu' } },
      fontSize: { value: 18, from: 'host' },
    });
    expect(resolveHost(file, 'api-2').terminal).toEqual({
      scheme: { value: 'solarized-dark', from: { group: 'eu' } },
      fontSize: { value: 15, from: { group: 'prod' } },
    });
  });

  it('leaves both to the app preferences when no level sets them', () => {
    expect(resolveHost(parseHostsFile(FILE), 'bare').terminal).toEqual({
      scheme: { value: undefined, from: 'default' },
      fontSize: { value: undefined, from: 'default' },
    });
  });

  it('round-trips through serialize, writing no key for an entry without one', () => {
    const file = parseHostsFile(FILE);
    expect(parseHostsFile(serializeHostsFile(file))).toEqual(file);
    expect(serializeHostsFile(file)).toContain('terminal:');
    expect(serializeHostsFile(parseHostsFile(one('{}')))).not.toContain('terminal');
  });
});
