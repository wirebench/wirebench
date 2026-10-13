/**
 * MCP's run facet without a server (#79): the fingerprint, the approval gate, expansion, the run
 * groups, secret needs, and the secrets facet's scan and moves.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approveMcpCommand, commandDisplay, commandFingerprint } from '../../../src/mcp/approval.js';
import { expandMcpOperation, expandMcpTransport } from '../../../src/mcp/expand.js';
import { createMcpFolder, createMcpRequest, createMcpServer, mcpServersOf } from '../../../src/mcp/model.js';
import type { McpServer, McpTransport } from '../../../src/mcp/model.js';
import { mcpRun } from '../../../src/mcp/run.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import type { PropertyScopes } from '../../../src/project/properties.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { selectRequests } from '../../../src/run/select.js';
import { applySecretMoves } from '../../../src/secrets/scan/apply.js';
import { scanProjectForSecrets } from '../../../src/secrets/scan/scan.js';
import { testHost } from '../../helpers/send-host.js';

const GH = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';

const scopes = (extra: Partial<PropertyScopes> = {}): PropertyScopes => ({
  project: {},
  global: {},
  system: {},
  ...extra,
});

const project = (servers: readonly McpServer[]): Project => ({
  ...createProject('P', { id: 'p1' }),
  containers: { mcp: servers },
});

const base = { command: 'node', args: ['server.js', '--port', '1'], cwd: '/work', envNames: ['B', 'A'] };

describe('commandFingerprint', () => {
  it('is the SHA-256 hex of a canonical JSON with sorted, unique env names', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify({ command: 'node', args: ['server.js', '--port', '1'], cwd: '/work', envNames: ['A', 'B'] }),
      )
      .digest('hex');
    expect(commandFingerprint(base)).toBe(expected);
    expect(commandFingerprint({ ...base, envNames: ['A', 'B', 'A'] })).toBe(expected);
  });

  it('changes with the command, an argument, the folder or the set of variables', () => {
    const one = commandFingerprint(base);
    expect(commandFingerprint({ ...base, command: 'nodejs' })).not.toBe(one);
    expect(commandFingerprint({ ...base, args: ['server.js', '--port', '2'] })).not.toBe(one);
    expect(commandFingerprint({ ...base, args: ['server.js --port', '1'] })).not.toBe(one);
    expect(commandFingerprint({ ...base, cwd: '/other' })).not.toBe(one);
    expect(commandFingerprint({ ...base, envNames: ['A'] })).not.toBe(one);
  });
});

describe('commandDisplay', () => {
  it('quotes only what a reader would misread', () => {
    expect(commandDisplay('npx', ['-y', '@scope/server@1.2', 'a b', '', 'x"y'])).toBe(
      'npx -y @scope/server@1.2 "a b" "" "x\\"y"',
    );
  });
});

describe('approveMcpCommand', () => {
  const request = { fingerprint: 'f', display: 'node server.js', cwd: '/work', envNames: [], serverName: 'Local' };

  it('refuses without a hook, and when the hook says no', async () => {
    await expect(approveMcpCommand(testHost(), request)).rejects.toMatchObject({
      code: 'mcp-command-unapproved',
      message: expect.stringContaining('"node server.js"') as unknown,
      details: { asked: false, server: 'Local', fingerprint: 'f' },
    });
    await expect(
      approveMcpCommand(testHost({}, { approveCommand: () => Promise.resolve(false) }), request),
    ).rejects.toMatchObject({ code: 'mcp-command-unapproved', details: { asked: true } });
  });

  it('resolves when the hook approves', async () => {
    await expect(
      approveMcpCommand(testHost({}, { approveCommand: () => Promise.resolve(true) }), request),
    ).resolves.toBeUndefined();
  });
});

describe('expandMcpOperation', () => {
  it('JSON-escapes every value substituted into the arguments, and no other field', () => {
    const s = scopes({ project: { q: 'say "hi"\n', tool: 'echo' } });
    const call = expandMcpOperation({ method: 'tools/call', tool: '${tool}', arguments: '{"text":"${q}"}' }, s);
    expect(call.value).toEqual({ method: 'tools/call', tool: 'echo', arguments: '{"text":"say \\"hi\\"\\n"}' });
    expect(JSON.parse((call.value as { arguments: string }).arguments)).toEqual({ text: 'say "hi"\n' });
    const prompt = expandMcpOperation(
      { method: 'prompts/get', prompt: 'p', arguments: [{ name: 'n', value: '${q}', enabled: true }] },
      s,
    );
    expect(prompt.value).toMatchObject({ arguments: [{ value: 'say "hi"\n' }] });
  });

  it('escapes a Sequence value exactly once', () => {
    const s = scopes({ sequence: { v: 'a"b' } });
    const call = expandMcpOperation({ method: 'tools/call', tool: 't', arguments: '{"x":"${#Sequence#v}"}' }, s);
    expect(call.value).toMatchObject({ arguments: '{"x":"a\\"b"}' });
  });

  it('reports a reference nothing resolves', () => {
    const read = expandMcpOperation({ method: 'resources/read', uri: 'file:///${missing}' }, scopes());
    expect(read.unresolved.map((ref) => ref.expr)).toEqual(['${missing}']);
  });
});

describe('expandMcpTransport', () => {
  it('never lets a Sequence value into a stdio command line', () => {
    const stdio: McpTransport = { type: 'stdio', command: 'node', args: ['${#Sequence#evil}'], env: [] };
    const out = expandMcpTransport(stdio, scopes({ sequence: { evil: '--inspect' } }));
    expect(out.unresolved.map((ref) => ref.expr)).toEqual(['${#Sequence#evil}']);
  });

  it('refuses an HTTP URL whose origin a Sequence value picks', () => {
    const http: McpTransport = { type: 'http', url: 'https://${#Sequence#host}/mcp', headers: [] };
    expect(() => expandMcpTransport(http, scopes({ sequence: { host: 'evil.test' } }))).toThrow(
      expect.objectContaining({ code: 'sequence-origin-from-response' }),
    );
  });

  it('expands the env, the args, the folder, the URL and the headers', () => {
    const s = scopes({ project: { a: 'A1', dir: 'srv' } });
    expect(
      expandMcpTransport(
        {
          type: 'stdio',
          command: 'node',
          args: ['${a}'],
          cwd: '${dir}',
          env: [{ name: 'X', value: '${a}', enabled: true }],
        },
        s,
      ).value,
    ).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['A1'],
      cwd: 'srv',
      env: [{ name: 'X', value: 'A1', enabled: true }],
    });
    expect(
      expandMcpTransport(
        { type: 'sse', url: 'http://h/${a}', headers: [{ name: 'H', value: '${a}', enabled: true }] },
        s,
      ).value,
    ).toEqual({ type: 'sse', url: 'http://h/A1', headers: [{ name: 'H', value: 'A1', enabled: true }] });
  });
});

describe('mcpRun', () => {
  const server = createMcpServer('Tools', {
    id: 's1',
    order: 2,
    transport: {
      type: 'http',
      url: 'https://mcp.example.test/${path}',
      headers: [{ name: 'X-Key', value: '${secret:header_key}', enabled: true }],
      auth: { type: 'bearer', tokenRef: 'ref-bearer' },
    },
    folders: [createMcpFolder('Nested', { id: 'f1', order: 1, requests: [createMcpRequest('Deep', { id: 'r2' })] })],
    requests: [createMcpRequest('Top', { id: 'r1', order: 0 })],
  });

  it('groups every request of every server, folders included', () => {
    const groups = mcpRun.groups(project([server]));
    expect(groups.map((g) => [g.name, g.order, g.candidates.map((c) => [c.item.path, c.diskPath])])).toEqual([
      [
        'Tools',
        2,
        [
          ['Tools/Top', 'apis/Tools/requests/Top'],
          ['Tools/Nested/Deep', 'apis/Tools/requests/Nested/Deep'],
        ],
      ],
    ]);
    expect(mcpRun.whyNotRunnable(project([server]), 'r1')).toBeUndefined();
  });

  it('needs the auth secret, the transport secrets, and the request secrets', () => {
    const withArgs = {
      ...server,
      requests: [
        createMcpRequest('Top', {
          id: 'r1',
          operation: { method: 'tools/call', tool: 't', arguments: '{"k":"${secret:arg_key}"}' },
        }),
      ],
    };
    const p = { ...project([withArgs]), properties: { path: '${secret:path_part}' } };
    const needs = secretNeedsOf(selectRequests(p, []).selected, p);
    expect(needs.map((need) => need.ref).sort()).toEqual(
      ['ref-bearer', 'secret:arg_key', 'secret:header_key', 'secret:path_part'].sort(),
    );
  });

  it('needs the secrets a stdio server reaches in its env and args', () => {
    const stdio = createMcpServer('Local', {
      id: 's2',
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['--token', '${secret:arg_token}'],
        env: [
          { name: 'API_KEY', value: '${secret:env_key}', enabled: true },
          { name: 'OFF', value: '${secret:unused}', enabled: false },
        ],
      },
      requests: [createMcpRequest('List', { id: 'r3' })],
    });
    const p = project([stdio]);
    const needs = secretNeedsOf(selectRequests(p, []).selected, p);
    expect(needs.map((need) => [need.ref, need.envName])).toEqual([
      ['secret:arg_token', 'ARG_TOKEN'],
      ['secret:env_key', 'ENV_KEY'],
    ]);
  });
});

describe('the MCP secrets facet', () => {
  const stdio = createMcpServer('Local', {
    id: 's1',
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['server.js', GH],
      env: [{ name: 'API_TOKEN', value: 'plain-token-value', enabled: true }],
    },
    requests: [
      createMcpRequest('Call', {
        id: 'r1',
        operation: { method: 'tools/call', tool: 't', arguments: `{"password":"hunter2hunter2"}` },
      }),
      createMcpRequest('Prompt', {
        id: 'r2',
        operation: {
          method: 'prompts/get',
          prompt: 'p',
          arguments: [{ name: 'api_key', value: 'k-123', enabled: true }],
        },
      }),
    ],
  });
  const http = createMcpServer('Remote', {
    id: 's2',
    transport: {
      type: 'http',
      url: 'https://h.test/mcp?access_token=FAKEtok1',
      headers: [{ name: 'Authorization', value: `Bearer ${GH}`, enabled: true }],
    },
    requests: [
      createMcpRequest('Read', { id: 'r3', operation: { method: 'resources/read', uri: 'res://x?token=FAKEuri1' } }),
    ],
  });

  it('finds credentials in args, env, URL, headers, URIs, prompt arguments and tool arguments', () => {
    const findings = scanProjectForSecrets(project([stdio, http]));
    expect(findings.map((f) => [f.location, f.value, f.label])).toEqual([
      [{ kind: 'mcp-arg', apiId: 's1', index: 1 }, GH, 'Local › argument 2'],
      [
        { kind: 'mcp-env', apiId: 's1', name: 'API_TOKEN', index: 0 },
        'plain-token-value',
        'Local › variable API_TOKEN',
      ],
      [{ kind: 'mcp-arguments', requestId: 'r1' }, 'hunter2hunter2', 'Local › Call › arguments'],
      [
        { kind: 'mcp-prompt-arg', requestId: 'r2', name: 'api_key', index: 0 },
        'k-123',
        'Local › Prompt › argument api_key',
      ],
      [{ kind: 'mcp-url', apiId: 's2', name: 'access_token' }, 'FAKEtok1', 'Remote › URL'],
      [{ kind: 'mcp-header', apiId: 's2', name: 'Authorization', index: 0 }, GH, 'Remote › header Authorization'],
      [{ kind: 'mcp-uri', requestId: 'r3' }, 'FAKEuri1', 'Remote › Read › URI'],
    ]);
  });

  it('moves each finding to a secret token in place, sharing what it leaves alone', () => {
    const p = project([stdio, http]);
    const findings = scanProjectForSecrets(p);
    const moved = applySecretMoves(
      p,
      findings.map((finding, i) => ({ finding, name: `s${i}` })),
    );
    expect(moved.stale).toEqual([]);
    const [local, remote] = mcpServersOf(moved.project);
    expect(local!.transport).toMatchObject({
      args: ['server.js', '${secret:s0}'],
      env: [{ name: 'API_TOKEN', value: '${secret:s1}' }],
    });
    expect(local!.requests[0]!.operation).toMatchObject({ arguments: '{"password":"${secret:s2}"}' });
    expect(local!.requests[1]!.operation).toMatchObject({ arguments: [{ value: '${secret:s3}' }] });
    expect(remote!.transport).toMatchObject({
      url: 'https://h.test/mcp?access_token=${secret:s4}',
      headers: [{ value: 'Bearer ${secret:s5}' }],
    });
    expect(remote!.requests[0]!.operation).toMatchObject({ uri: 'res://x?token=${secret:s6}' });
    expect(scanProjectForSecrets(moved.project)).toEqual([]);
    const untouched = project([createMcpServer('Clean', { id: 's3' })]);
    expect(applySecretMoves(untouched, []).project).toBe(untouched);
  });
});
