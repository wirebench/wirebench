/**
 * `wirebench ssh forward` arguments (#460, forwarding spec D7): its flags, and the usage errors that exit 2
 * before anything is read.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../../src/args.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';

const FINGERPRINT = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';

describe('wirebench ssh forward arguments', () => {
  it('parses the host alone with every default', () => {
    expect(parseCliArgs(['ssh', 'forward', 'db-1'])).toEqual({
      command: 'ssh-forward',
      host: 'db-1',
      rules: [],
      ports: {},
      hostKeys: [],
      allowNetworkBind: false,
      secretSources: DEFAULT_CLI_SECRET_SOURCES,
      json: false,
      quiet: false,
    });
  });

  it('parses rules and every flag', () => {
    expect(
      parseCliArgs([
        'ssh',
        'forward',
        'db-1',
        'pg',
        'socks',
        '--workspace',
        'ws',
        '--port',
        'pg=6543',
        '--port',
        'socks=1081',
        '--host-key',
        FINGERPRINT,
        '--known-hosts',
        'keys.json',
        '--allow-network-bind',
        '--no-secret-sources',
        '--json',
        '-q',
      ]),
    ).toEqual({
      command: 'ssh-forward',
      host: 'db-1',
      rules: ['pg', 'socks'],
      workspace: 'ws',
      ports: { pg: 6543, socks: 1081 },
      hostKeys: [FINGERPRINT],
      knownHosts: 'keys.json',
      allowNetworkBind: true,
      secretSources: { ...DEFAULT_CLI_SECRET_SOURCES, enabled: false },
      json: true,
      quiet: true,
    });
  });

  it('takes the secret-source trust flags as run does', () => {
    const parsed = parseCliArgs(['ssh', 'forward', 'db-1', '--trust-secret-sources']);
    expect(parsed).toMatchObject({ secretSources: { enabled: true, trust: { mode: 'any' } } });
  });

  it.each([
    [['ssh', 'forward', 'db-1', '--port', 'pg'], /--port must be "<rule>=<port>"/],
    [['ssh', 'forward', 'db-1', '--port', 'pg=0'], /--port must be "<rule>=<port>"/],
    [['ssh', 'forward', 'db-1', '--port', 'pg=70000'], /--port must be "<rule>=<port>"/],
    [['ssh', 'forward', 'db-1', '--port', '=22'], /--port must be "<rule>=<port>"/],
    [['ssh', 'forward', 'db-1', '--host-key', 'MD5:aa:bb'], /--host-key takes a SHA256:<base64> fingerprint/],
    [['ssh', 'forward', 'db-1', '--host-key', 'SHA256:not base64!'], /--host-key takes a SHA256:<base64>/],
    [['ssh', 'forward', 'db-1', '--host-key', 'SHA256:'], /--host-key takes a SHA256:<base64>/],
    [['ssh', 'forward'], /<host> or --group is required/],
    [['ssh', 'forward', 'db-1', '--group', 'dev'], /--group starts the group's own rules/],
    [['ssh', 'connect', 'db-1'], /unknown subcommand "connect"/],
    [['ssh'], /unknown subcommand ""/],
    [['ssh', 'forward', 'db-1', '--env', 'prod'], /Unknown option '--env'/],
    [
      ['ssh', 'forward', 'db-1', '--trust-secret-sources', '--trust-secret-sources-hash', 'a'.repeat(64)],
      /cannot be combined/,
    ],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it('parses --group with no host (#583)', () => {
    expect(parseCliArgs(['ssh', 'forward', '--group', 'dev', '--port', 'db-1/pg=6543'])).toMatchObject({
      command: 'ssh-forward',
      group: 'dev',
      rules: [],
      ports: { 'db-1/pg': 6543 },
    });
    expect(parseCliArgs(['ssh', 'forward', '--group', 'dev'])).not.toHaveProperty('host');
  });

  it('has its own help topic', () => {
    expect(parseCliArgs(['ssh', '--help'])).toEqual({ command: 'help', topic: 'ssh' });
    expect(parseCliArgs(['ssh', 'forward', '--help'])).toEqual({ command: 'help', topic: 'ssh' });
    expect(parseCliArgs(['--help', 'ssh'])).toEqual({ command: 'help', topic: 'ssh' });
  });
});
