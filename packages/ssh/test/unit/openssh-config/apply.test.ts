import { describe, expect, it } from 'vitest';
import { EMPTY_HOSTS_FILE, parseHostsFile, serializeHostsFile, type HostsFile } from '../../../src/index.js';
import { applySshConfigImport, type SshConfigImportChoices } from '../../../src/openssh-config/apply.js';
import { loadSshConfig } from '../../../src/openssh-config/load.js';
import { planSshConfigImport } from '../../../src/openssh-config/plan.js';
import { memoryIo } from './memory-io.js';

const MAIN = '/home/u/.ssh/config';
const EXISTING = parseHostsFile(`
version: 1
groups:
  - id: prod
    name: Production
    ssh: { user: deploy, auth: { agent: true } }
    hosts:
      - { id: web, name: web, address: web.example.com }
`);
async function setup(text: string, existing: HostsFile = EXISTING) {
  const document = await loadSshConfig(MAIN, memoryIo({ [MAIN]: text }));
  return planSshConfigImport({ document, existing, existingSecretNames: [] });
}
const choose = (over: Partial<SshConfigImportChoices> = {}): SshConfigImportChoices => ({
  groupName: 'From laptop',
  importDuplicates: [],
  keys: {},
  ...over,
});

describe('applySshConfigImport', () => {
  it('appends one group and leaves every existing entry as it was', async () => {
    const plan = await setup('Host api\n  User ops\n');
    const result = applySshConfigImport(plan, choose(), EXISTING);
    expect(result.groups[0]).toEqual(EXISTING.groups[0]);
    expect(result.groups[1]).toMatchObject({
      id: 'ssh-config',
      name: 'From laptop',
      ssh: { auth: { kind: 'agent' } },
      hosts: [{ id: 'api', name: 'api', address: 'api', ssh: { user: 'ops' } }],
    });
  });

  it('turns key choices into secret references, with a passphrase reference for an encrypted stored key', async () => {
    const plan = await setup(
      'Host a\n  IdentityFile ~/.ssh/a\nHost b\n  IdentityFile ~/.ssh/b\nHost c\n  IdentityFile ~/.ssh/c\n',
    );
    const result = applySshConfigImport(
      plan,
      choose({
        keys: {
          k1: { kind: 'store', secret: 'key_a' },
          k2: { kind: 'existing', secret: 'team_key' },
          k3: { kind: 'agent' },
        },
        encrypted: ['k1'],
      }),
      EMPTY_HOSTS_FILE,
    );
    const auth = Object.fromEntries((result.groups[0]?.hosts ?? []).map((h) => [h.id, h.ssh.auth]));
    expect(auth).toEqual({
      a: { kind: 'key', key: '${secret:key_a}', passphrase: '${secret:key_a_passphrase}' },
      b: { kind: 'key', key: '${secret:team_key}' },
      c: undefined, // the agent, same as the group
    });
  });

  it('imports a duplicate only when asked', async () => {
    const plan = await setup('Host web\n  HostName web.example.com\n  User deploy\n');
    expect(applySshConfigImport(plan, choose(), EXISTING).groups[1]?.hosts).toEqual([]);
    const anyway = applySshConfigImport(plan, choose({ importDuplicates: ['web-2'] }), EXISTING);
    expect(anyway.groups[1]?.hosts.map((h) => h.id)).toEqual(['web-2']);
  });

  it('refuses an unknown key ref, a bad secret name and an empty group name, without echoing the name', async () => {
    const plan = await setup('Host a\n  IdentityFile ~/.ssh/a\n');
    expect(() => applySshConfigImport(plan, choose({ keys: { k9: { kind: 'agent' } } }), EXISTING)).toThrow(/k9/);
    try {
      applySshConfigImport(plan, choose({ keys: { k1: { kind: 'store', secret: 'hunter2 pass' } } }), EXISTING);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'ssh-literal-secret' });
      expect(String((error as Error).message)).not.toContain('hunter2');
    }
    expect(() => applySshConfigImport(plan, choose({ groupName: '  ' }), EXISTING)).toThrow(/name/);
  });

  it('refuses when hosts.yaml gained an id the plan uses', async () => {
    const plan = await setup('Host api\n');
    const changed = parseHostsFile(`${serializeHostsFile(EXISTING)}hosts:\n  - { id: api, name: api, address: x }\n`);
    expect(() => applySshConfigImport(plan, choose(), changed)).toThrow(
      expect.objectContaining({ code: 'ssh-import-stale' }),
    );
  });

  it('always yields a file the model accepts', async () => {
    const configs = [
      'Host a b c\nHost *\n  User u\n  IdentityFile ~/.ssh/k\n',
      'Host t\n  ProxyJump x@gw:2200,mid.example\nHost mid.example\n',
      'Host a\n  ProxyJump b\nHost b\n  ProxyJump a\n',
      'Host web\n  HostName web.example.com\n  User deploy\nHost y\n  ProxyJump web\n',
    ];
    for (const text of configs) {
      const plan = await setup(text);
      const result = applySshConfigImport(plan, choose(), EXISTING);
      expect(parseHostsFile(serializeHostsFile(result))).toEqual(result);
    }
  });
});
