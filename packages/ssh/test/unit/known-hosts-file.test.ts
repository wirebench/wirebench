import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyKnownHostsFileImport,
  addKnownHostsFileHosts,
  hostFieldMatches,
  knownHostsFileRowsOf,
  literalHostOf,
  parseHostsFile,
  resolveHost,
  knownHostsNameFor,
  lexKnownHostsFile,
  planKnownHostsFileImport,
  type HostsFile,
  type KnownHostEntry,
  type KnownHostsTarget,
} from '../../src/index.js';

const FIXTURE = readFileSync(new URL('../fixtures/known_hosts', import.meta.url), 'utf8');

const FP = {
  a: 'SHA256:zXKOo91Z+uaXv5p6WtsMIte0yY6ZWYRdRmkIcAbuVF8',
  b: 'SHA256:V2DUyxbxrFsZDteUJdP0ohJZF62/h2Kx1ka5w8w4Odc',
  c: 'SHA256:OVl7CTJbfE1fGrPkCQsF/Y3s2zmI/od7fa52k/GCOLM',
  d: 'SHA256:WSVIBsv2b8Jo9LYTQaTPfjNLlL/DO+t8JT7x9GRyq4E',
  e: 'SHA256:KMzWXEew6lD6/N/gfmjgerguquHA5QR+Am59oBzppcU',
  ecdsa: 'SHA256:rHy7n9a5k3LHcfddoDNzL4TRlhV0uq5rQEAeErKnZEM',
};
const ED = 'ssh-ed25519';
const ECDSA = 'ecdsa-sha2-nistp256';

const target = (address: string, port: number, ...names: string[]): KnownHostsTarget => ({
  address,
  port,
  names: names.length > 0 ? names : [address],
});

const TARGETS: readonly KnownHostsTarget[] = [
  target('plain.example.com', 22, 'Plain'),
  target('port.example.com', 2222),
  target('port.example.com', 22, 'Port on 22'),
  target('hashed.example.com', 22),
  target('hashed-port.example.com', 2200),
  target('api.wild.example.com', 22),
  target('secret.wild.example.com', 22),
  target('192.0.2.10', 22, 'By address'),
  target('nothing.example.net', 22),
];

describe('knownHostsNameFor', () => {
  it('is the bare name on port 22 and [name]:port otherwise, lower-cased', () => {
    expect(knownHostsNameFor('Example.COM', 22)).toBe('example.com');
    expect(knownHostsNameFor('example.com', 2222)).toBe('[example.com]:2222');
  });
});

describe('hostFieldMatches', () => {
  it('matches a comma list exactly, ignoring case', () => {
    expect(hostFieldMatches('a.example.com,192.0.2.1', 'a.example.com')).toBe(true);
    expect(hostFieldMatches('A.EXAMPLE.com', 'a.example.com')).toBe(true);
    expect(hostFieldMatches('a.example.com', 'b.example.com')).toBe(false);
  });
  it('keeps [host]:port apart from the bare name', () => {
    expect(hostFieldMatches('[a.example.com]:2222', '[a.example.com]:2222')).toBe(true);
    expect(hostFieldMatches('[a.example.com]:2222', 'a.example.com')).toBe(false);
    expect(hostFieldMatches('a.example.com', '[a.example.com]:2222')).toBe(false);
  });
  it('honours * and ? wildcards and a negation that wins', () => {
    expect(hostFieldMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(hostFieldMatches('?.example.com', 'ab.example.com')).toBe(false);
    expect(hostFieldMatches('*.example.com,!b.example.com', 'b.example.com')).toBe(false);
    expect(hostFieldMatches('!b.example.com', 'a.example.com')).toBe(false);
  });
  it('matches a hashed field by its salted HMAC', () => {
    const hashed = '|1|l4D68XqeF5+1+Nk7XeJS++uI6Js=|ceCy9Fw90tNXsIDs9jbSu4mKbdY=';
    expect(hostFieldMatches(hashed, 'hashed.example.com')).toBe(true);
    expect(hostFieldMatches(hashed, 'other.example.com')).toBe(false);
    expect(hostFieldMatches('|1|broken', 'hashed.example.com')).toBe(false);
  });
});

describe('lexKnownHostsFile', () => {
  it('reads keys and markers, skips comments and blanks, and reports unreadable lines', () => {
    const lexed = lexKnownHostsFile(FIXTURE);
    expect(lexed.entries.map((e) => [e.line, e.marker ?? '', e.keyType, e.fingerprint])).toEqual([
      [3, '', ED, FP.a],
      [4, '', ED, FP.d],
      [5, '', ED, FP.b],
      [6, '', ED, FP.c],
      [7, '', ED, FP.e],
      [8, '', ECDSA, FP.ecdsa],
      [9, 'cert-authority', ED, FP.a],
      [10, 'revoked', ED, FP.d],
      [11, '', ED, FP.a],
      [13, '', ED, FP.d],
    ]);
    // A broken line, and a key whose blob is not the type its line names.
    expect(lexed.unreadable).toEqual([12, 15]);
  });
  it('accepts CRLF line ends and a trailing comment', () => {
    const lexed = lexKnownHostsFile(
      `h.example.com ${ED} AAAAC3NzaC1lZDI1NTE5AAAAIFkkhXbJ97x8Tj1gby0rDZaHuAitc9GASuajfe+AItng a b\r\n`,
    );
    expect(lexed.entries.map((e) => e.fingerprint)).toEqual([FP.a]);
    expect(lexed.unreadable).toEqual([]);
  });
});

describe('planKnownHostsFileImport', () => {
  const plan = planKnownHostsFileImport({ text: FIXTURE, targets: TARGETS, trusted: [] });
  const rows = (list: typeof plan.add) =>
    list.map((r) => [r.host, r.keyType, r.fingerprint, r.names.join('|'), r.line]);

  it('gives each matching host the keys its plain, port, hashed and pattern lines name', () => {
    expect(rows(plan.add)).toEqual([
      ['plain.example.com:22', ED, FP.a, 'Plain', 3],
      ['192.0.2.10:22', ED, FP.a, 'By address', 3],
      ['port.example.com:2222', ED, FP.d, 'port.example.com', 4],
      ['hashed.example.com:22', ED, FP.b, 'hashed.example.com', 5],
      ['hashed-port.example.com:2200', ED, FP.c, 'hashed-port.example.com', 6],
      ['api.wild.example.com:22', ED, FP.e, 'api.wild.example.com', 7],
      ['plain.example.com:22', ECDSA, FP.ecdsa, 'Plain', 8],
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.trusted).toEqual([]);
  });

  it('lists what it leaves out, by line', () => {
    expect(plan.skipped).toEqual([
      { line: 9, reason: 'cert-authority' },
      { line: 10, reason: 'revoked' },
      { line: 12, reason: 'unreadable' },
      // A second ed25519 key for plain.example.com: the first line already gave it one.
      { line: 13, reason: 'duplicate' },
      { line: 15, reason: 'unreadable' },
    ]);
  });

  it('merges hosts that share an address and port into one row', () => {
    const shared = planKnownHostsFileImport({
      text: FIXTURE,
      targets: [target('plain.example.com', 22, 'One'), target('PLAIN.example.com', 22, 'Two')],
      trusted: [],
    });
    expect(rows(shared.add)).toEqual([
      ['plain.example.com:22', ED, FP.a, 'One|Two', 3],
      ['plain.example.com:22', ECDSA, FP.ecdsa, 'One|Two', 8],
    ]);
  });

  it('sorts rows against the keys already trusted: the same key is trusted, another is a conflict', () => {
    const trusted: KnownHostEntry[] = [
      { host: 'plain.example.com:22', keyType: ED, fingerprint: FP.a },
      { host: 'port.example.com:2222', keyType: ED, fingerprint: FP.e },
    ];
    const sorted = planKnownHostsFileImport({ text: FIXTURE, targets: TARGETS, trusted });
    expect(rows(sorted.trusted)).toEqual([['plain.example.com:22', ED, FP.a, 'Plain', 3]]);
    expect(sorted.conflicts.map((r) => [r.host, r.fingerprint, r.previous])).toEqual([
      ['port.example.com:2222', FP.d, FP.e],
    ]);
    expect(sorted.add.map((r) => r.host)).not.toContain('port.example.com:2222');
  });

  it('plans nothing from an empty file or for no hosts', () => {
    expect(planKnownHostsFileImport({ text: '', targets: TARGETS, trusted: [] }).add).toEqual([]);
    const none = planKnownHostsFileImport({ text: FIXTURE, targets: [], trusted: [] });
    expect(none.add).toEqual([]);
    // Hashed and pattern-only lines name no one server; the plain ones are offered as unsaved hosts.
    expect(none.skipped.filter((s) => s.reason === 'no-host').map((s) => s.line)).toEqual([5, 6, 7]);
  });
});

describe('applyKnownHostsFileImport', () => {
  const trusted: KnownHostEntry[] = [
    { host: 'port.example.com:2222', keyType: ED, fingerprint: FP.e },
    { host: 'kept.example.com:22', keyType: ED, fingerprint: FP.b },
  ];
  const plan = planKnownHostsFileImport({ text: FIXTURE, targets: TARGETS, trusted });

  it('adds new keys and keeps a conflicting stored key unless it is chosen for replacing', () => {
    const kept = applyKnownHostsFileImport(plan, [], trusted);
    expect(kept.added).toBe(6);
    expect(kept.replaced).toBe(0);
    expect(kept.kept).toBe(1);
    expect(kept.entries).toContainEqual({ host: 'port.example.com:2222', keyType: ED, fingerprint: FP.e });
    expect(kept.entries).toContainEqual({ host: 'kept.example.com:22', keyType: ED, fingerprint: FP.b });
    expect(kept.entries).toContainEqual({ host: 'hashed.example.com:22', keyType: ED, fingerprint: FP.b });

    const replaced = applyKnownHostsFileImport(plan, [{ host: 'port.example.com:2222', keyType: ED }], trusted);
    expect(replaced.replaced).toBe(1);
    expect(replaced.entries).toContainEqual({ host: 'port.example.com:2222', keyType: ED, fingerprint: FP.d });
    expect(replaced.entries.filter((e) => e.host === 'port.example.com:2222')).toHaveLength(1);
  });

  it('never overwrites a key trusted after the preview unless that slot was chosen', () => {
    const now: KnownHostEntry[] = [...trusted, { host: 'hashed.example.com:22', keyType: ED, fingerprint: FP.a }];
    const result = applyKnownHostsFileImport(plan, [], now);
    expect(result.entries).toContainEqual({ host: 'hashed.example.com:22', keyType: ED, fingerprint: FP.a });
    expect(result.kept).toBe(2);
    expect(result.added).toBe(5);
  });
});

describe('hostFieldMatches patterns', () => {
  it('treats only * and ? as special, and backtracks over *', () => {
    expect(hostFieldMatches('a.b', 'axb')).toBe(false);
    expect(hostFieldMatches('[a]:22*', '[a]:2222')).toBe(true);
    expect(hostFieldMatches('*a*b', 'xaxab')).toBe(true);
    expect(hostFieldMatches('*a*b', 'xaxa')).toBe(false);
    expect(hostFieldMatches('**', 'anything')).toBe(true);
    expect(hostFieldMatches('a?', 'a')).toBe(false);
  });
});

describe('literalHostOf', () => {
  it('takes the first plain name, on port 22 or from [name]:port', () => {
    expect(literalHostOf('Web.Example.com,192.0.2.1')).toEqual({ address: 'web.example.com', port: 22 });
    expect(literalHostOf('[db.example.com]:2222')).toEqual({ address: 'db.example.com', port: 2222 });
    expect(literalHostOf('*.example.com,!x.example.com,plain')).toEqual({ address: 'plain', port: 22 });
    expect(literalHostOf('::1')).toEqual({ address: '::1', port: 22 });
    expect(literalHostOf('[::1]:2200')).toEqual({ address: '::1', port: 2200 });
  });

  it('gives none for a hashed field, patterns alone or a malformed port', () => {
    expect(literalHostOf('|1|l4D68XqeF5+1+Nk7XeJS++uI6Js=|ceCy9Fw90tNXsIDs9jbSu4mKbdY=')).toBeUndefined();
    expect(literalHostOf('*.example.com,!secret.example.com,web?')).toBeUndefined();
    expect(literalHostOf('[a]:0')).toBeUndefined();
    expect(literalHostOf('[a]:70000')).toBeUndefined();
    expect(literalHostOf('[a]')).toBeUndefined();
    expect(literalHostOf('[]:22')).toBeUndefined();
  });
});

describe('planKnownHostsFileImport unsaved servers', () => {
  it('lists the servers plain lines name that no host dials, one per address and port', () => {
    const plan = planKnownHostsFileImport({ text: FIXTURE, targets: TARGETS, trusted: [] });
    expect(plan.unsaved).toEqual([
      {
        host: 'unrelated.example.org:22',
        address: 'unrelated.example.org',
        port: 22,
        keys: [{ keyType: ED, fingerprint: FP.a, line: 11 }],
      },
    ]);
  });

  it('gathers each server key types and leaves hashed lines not imported', () => {
    const plan = planKnownHostsFileImport({ text: FIXTURE, targets: [], trusted: [] });
    expect(plan.add).toEqual([]);
    expect(plan.unsaved.map((s) => [s.host, s.keys.map((k) => [k.keyType, k.line])])).toEqual([
      // Line 3 names plain.example.com first; line 8 adds its ECDSA key, line 13 repeats an ed25519 one.
      [
        'plain.example.com:22',
        [
          [ED, 3],
          [ECDSA, 8],
        ],
      ],
      ['port.example.com:2222', [[ED, 4]]],
      ['unrelated.example.org:22', [[ED, 11]]],
    ]);
    expect(plan.skipped.filter((s) => s.reason === 'duplicate').map((s) => s.line)).toEqual([13]);
  });
});

describe('addKnownHostsFileHosts', () => {
  const plan = planKnownHostsFileImport({ text: FIXTURE, targets: [], trusted: [] });
  const [plain, port] = plan.unsaved;
  const FILE: HostsFile = parseHostsFile(
    [
      'version: 1',
      'groups:',
      '  - id: lab',
      '    name: Lab',
      '    ssh: { port: 2200, user: ops }',
      'hosts:',
      '  - id: plain-example-com',
      '    name: Taken id',
      '    address: other.example.com',
      '',
    ].join('\n'),
  );

  it('adds each chosen server at the top level, named after its address, with no user', () => {
    const { file, added } = addKnownHostsFileHosts(FILE, [plain!, port!]);
    expect(added).toEqual(['plain-example-com-2', 'port-example-com']);
    expect(file.hosts.slice(1)).toEqual([
      { id: 'plain-example-com-2', name: 'plain.example.com', address: 'plain.example.com', tags: [], ssh: {} },
      {
        id: 'port-example-com',
        name: 'port.example.com',
        address: 'port.example.com',
        tags: [],
        ssh: { port: 2222 },
      },
    ]);
    expect(resolveHost(file, 'plain-example-com-2').ssh.user.value).toBeUndefined();
    expect(FILE.hosts).toHaveLength(1);
  });

  it('adds into a chosen group, keeping the port the file named over the group one', () => {
    const { file } = addKnownHostsFileHosts(FILE, [plain!], 'lab');
    const host = file.groups[0]!.hosts[0]!;
    expect(host.ssh).toEqual({ port: 22 });
    expect(resolveHost(file, host.id).ssh.port.value).toBe(22);
  });

  it('skips a server some host dials by now, and refuses a group that is gone', () => {
    const dialled = addKnownHostsFileHosts(FILE, [plain!]).file;
    expect(addKnownHostsFileHosts(dialled, [plain!]).added).toEqual([]);
    expect(() => addKnownHostsFileHosts(FILE, [plain!], 'gone')).toThrow(
      expect.objectContaining({ code: 'ssh-import-stale' }),
    );
  });

  it('trusts the chosen servers keys through the same apply', () => {
    const rows = knownHostsFileRowsOf([plain!]);
    const result = applyKnownHostsFileImport({ ...plan, add: [...plan.add, ...rows] }, [], []);
    expect(result.added).toBe(2);
    expect(result.entries).toEqual([
      { host: 'plain.example.com:22', keyType: ED, fingerprint: FP.a },
      { host: 'plain.example.com:22', keyType: ECDSA, fingerprint: FP.ecdsa },
    ]);
  });
});
