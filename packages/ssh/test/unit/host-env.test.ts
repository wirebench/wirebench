import { describe, expect, it } from 'vitest';
import { envSecretName, parseHostsFile, resolveHost, serializeHostsFile, SshModelError } from '../../src/index.js';

const FILE = `
version: 1
groups:
  - id: prod
    name: Production
    env: { LANG: en_US.UTF-8, APP_PROFILE: prod, HTTP_PROXY: 'http://proxy:3128' }
    groups:
      - id: eu
        name: EU
        env: { APP_PROFILE: eu, TOKEN: '\${secret:eu_token}' }
        hosts:
          - id: api-1
            name: api-1
            address: 10.0.1.5
            env: { LANG: C.UTF-8 }
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

describe('env in hosts.yaml', () => {
  it('reads env on hosts and groups; an entry without it has none', () => {
    const file = parseHostsFile(FILE);
    const prod = file.groups[0];
    expect(prod?.env).toEqual({ LANG: 'en_US.UTF-8', APP_PROFILE: 'prod', HTTP_PROXY: 'http://proxy:3128' });
    expect(prod?.groups[0]?.hosts[0]?.env).toEqual({ LANG: 'C.UTF-8' });
    expect(file.hosts[0]?.env).toBeUndefined();
  });

  it('reads a number or a boolean as its text', () => {
    const file = parseHostsFile(
      'version: 1\nhosts:\n  - { id: a, name: a, address: a, env: { DEBUG: 1, ON: true } }\n',
    );
    expect(file.hosts[0]?.env).toEqual({ DEBUG: '1', ON: 'true' });
  });

  it('an empty map is no env', () => {
    const file = parseHostsFile('version: 1\nhosts:\n  - { id: a, name: a, address: a, env: {} }\n');
    expect(file.hosts[0]?.env).toBeUndefined();
  });

  it('refuses a name that is not a variable name, naming the path but not the value', () => {
    const error = refusal("version: 1\nhosts:\n  - { id: a, name: a, address: a, env: { 'BAD-NAME': hunter2 } }\n");
    expect(error.code).toBe('ssh-hosts-invalid');
    expect(error.message).toMatch(/hosts\[0\]\.env/);
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses a secret token that is not the whole value, without echoing it', () => {
    const error = refusal(
      "version: 1\nhosts:\n  - { id: a, name: a, address: a, env: { PROXY: 'http://u:hunter2@\${secret:pw}' } }\n",
    );
    expect(error.code).toBe('ssh-hosts-invalid');
    expect(error.message).toMatch(/hosts\[0\]\.env\.PROXY/);
    expect(error.message).toMatch(/whole value/);
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses a value that is not text', () => {
    expect(refusal('version: 1\nhosts:\n  - { id: a, name: a, address: a, env: { A: [1] } }\n').code).toBe(
      'ssh-hosts-invalid',
    );
  });

  it('round-trips, writing env after ssh and before forwards', () => {
    const text = serializeHostsFile(parseHostsFile(FILE));
    expect(parseHostsFile(text)).toEqual(parseHostsFile(FILE));
    const written = serializeHostsFile(
      parseHostsFile(
        'version: 1\nhosts:\n  - id: a\n    name: a\n    address: a\n    forwards: [{ id: w, type: dynamic, port: 1080 }]\n    env: { B: two, A: one }\n    ssh: { user: u }\n',
      ),
    );
    expect(written).toBe(
      'version: 1\nhosts:\n  - id: a\n    name: a\n    address: a\n    ssh:\n      user: u\n    env:\n      B: two\n      A: one\n    forwards:\n      - id: w\n        type: dynamic\n        port: 1080\n',
    );
  });

  it('writes no env key for an entry without variables', () => {
    expect(serializeHostsFile(parseHostsFile('version: 1\nhosts:\n  - { id: a, name: a, address: a }\n'))).not.toMatch(
      /env/,
    );
  });
});

describe('resolved env', () => {
  const file = parseHostsFile(FILE);

  it('merges by name down the tree; a nearer level wins per variable', () => {
    expect(resolveHost(file, 'api-1').env).toEqual([
      { name: 'LANG', value: 'C.UTF-8', from: 'host' },
      { name: 'APP_PROFILE', value: 'eu', from: { group: 'eu' } },
      { name: 'HTTP_PROXY', value: 'http://proxy:3128', from: { group: 'prod' } },
      { name: 'TOKEN', value: '${secret:eu_token}', from: { group: 'eu' } },
    ]);
  });

  it('a host without its own env inherits its groups', () => {
    expect(resolveHost(file, 'api-2').env.map((v) => [v.name, v.value])).toEqual([
      ['LANG', 'en_US.UTF-8'],
      ['APP_PROFILE', 'eu'],
      ['HTTP_PROXY', 'http://proxy:3128'],
      ['TOKEN', '${secret:eu_token}'],
    ]);
  });

  it('a host with no env anywhere has an empty list', () => {
    expect(resolveHost(file, 'bare').env).toEqual([]);
  });
});

describe('envSecretName', () => {
  it('names the secret of a whole token, and nothing for a literal', () => {
    expect(envSecretName('${secret:eu_token}')).toBe('eu_token');
    expect(envSecretName('en_US.UTF-8')).toBeUndefined();
    expect(envSecretName('')).toBeUndefined();
  });
});
