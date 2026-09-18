import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LegacyProjectError } from '../../../../src/errors.js';
import {
  LEGACY_PROJECT_NAMESPACE,
  LEGACY_PROJECT_ROOT,
  looksLikeLegacyProject,
} from '../../../../src/soap/legacy-project/format.js';
import { MAX_LEGACY_PROJECT_BYTES, readLegacySoapProject } from '../../../../src/soap/legacy-project/import.js';
import { parseLegacyProject } from '../../../../src/soap/legacy-project/parse.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../fixtures/legacy-soap-project');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

/** A project document around `body`, written with the format's identifiers from `format.ts`. */
function project(body: string, attributes = 'name="Inline"'): string {
  return `<con:${LEGACY_PROJECT_ROOT} ${attributes} xmlns:con="${LEGACY_PROJECT_NAMESPACE}">${body}</con:${LEGACY_PROJECT_ROOT}>`;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyProjectError);
    expect((error as LegacyProjectError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('looksLikeLegacyProject', () => {
  it('recognises the fixtures and nothing else', () => {
    expect(looksLikeLegacyProject(fixture('minimal.xml'))).toBe(true);
    expect(looksLikeLegacyProject(fixture('full.xml'))).toBe(true);
    expect(looksLikeLegacyProject(fixture('not-a-project.xml'))).toBe(false);
    expect(looksLikeLegacyProject('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>')).toBe(false);
  });
});

describe('parseLegacyProject', () => {
  it('reads the minimal fixture: one interface with its four-part cache, one operation, one call', () => {
    const parsed = parseLegacyProject(fixture('minimal.xml'));
    expect(parsed.name).toBe('Minimal');
    expect(parsed.interfaces).toHaveLength(1);
    const iface = parsed.interfaces[0]!;
    expect(iface).toMatchObject({
      name: 'EchoBinding',
      bindingName: '{urn:wb:nested}EchoBinding',
      definitionUrl: 'http://example.invalid/nested/service.wsdl',
      soapVersion: '1.1',
      endpoints: ['http://example.invalid/echo'],
    });
    expect(iface.cache?.rootPart).toBe('http://example.invalid/nested/service.wsdl');
    expect(iface.cache?.parts.map((part) => part.url)).toEqual([
      'http://example.invalid/nested/service.wsdl',
      'http://example.invalid/nested/types.wsdl',
      'http://example.invalid/nested/schemas/common.xsd',
      'http://example.invalid/nested/schemas/base.xsd',
    ]);
    expect(iface.operations).toHaveLength(1);
    expect(iface.operations[0]).toMatchObject({
      name: 'Echo',
      bindingOperationName: 'Echo',
      action: 'urn:wb:nested/Echo',
    });
    const call = iface.operations[0]!.calls[0]!;
    expect(call).toMatchObject({ name: 'Request 1', endpoint: 'http://example.invalid/echo', encoding: 'UTF-8' });
    expect(call.envelope).toContain('<com:EchoRequest>${#Project#greeting}</com:EchoRequest>');
    expect(call.envelope?.startsWith('<soapenv:Envelope')).toBe(true);
    expect(call.credentials.hadPassword).toBe(false);
  });

  it('keeps a text cache part verbatim and serializes an inline one back to a standalone document', () => {
    const parts = parseLegacyProject(fixture('minimal.xml')).interfaces[0]!.cache!.parts;
    expect(parts[0]!.content).toContain('<import namespace="urn:wb:nested-types" location="./types.wsdl"/>');
    const inline = parts[2]!.content;
    expect(inline.startsWith('<xs:schema')).toBe(true);
    expect(inline).toContain('xmlns:xs="http://www.w3.org/2001/XMLSchema"');
    expect(inline).toContain('<xs:include schemaLocation="base.xsd"/>');
    expect(inline).not.toContain(LEGACY_PROJECT_NAMESPACE);
  });

  it('reads credentials without ever keeping a password', () => {
    const calls = parseLegacyProject(fixture('full.xml')).interfaces[0]!.operations[0]!.calls;
    expect(calls[1]).toMatchObject({
      name: 'Staging with auth',
      timeoutMs: 15000,
      credentials: { username: 'alice', hadPassword: true, authType: 'Preemptive' },
    });
    expect(calls[2]).toMatchObject({
      endpoint: 'http://other.example.invalid:8080/echo',
      encoding: 'ISO-8859-1',
      credentials: { username: 'bob', domain: 'CORP', hadPassword: true, authType: 'NTLM' },
    });
    expect(JSON.stringify(calls)).not.toContain('not-a-real-password');
    expect(JSON.stringify(calls)).not.toContain('also-fake');
  });

  it('decompresses a gzip-compressed envelope', () => {
    const calls = parseLegacyProject(fixture('full.xml')).interfaces[0]!.operations[0]!.calls;
    const compressed = calls.find((call) => call.name === 'Compressed')!;
    expect(compressed.envelope).toContain('<com:EchoRequest>${#Project#greeting}</com:EchoRequest>');
    expect(compressed.envelopeProblem).toBeUndefined();
  });

  it('reports an envelope whose compression cannot be decoded instead of failing', () => {
    const parsed = parseLegacyProject(
      project(`<con:interface type="wsdl" name="I"><con:operation name="Op">
        <con:call name="Bad"><con:request compression="gzip">not base64 gzip</con:request></con:call>
      </con:operation></con:interface>`),
    );
    const call = parsed.interfaces[0]!.operations[0]!.calls[0]!;
    expect(call.envelope).toBeUndefined();
    expect(call.envelopeProblem).toContain('could not be decoded');
  });

  it('reads the second interface, a SOAP 1.2 version flag, WS-Addressing and an operation with no calls', () => {
    const full = parseLegacyProject(fixture('full.xml'));
    expect(full.interfaces.map((iface) => iface.name)).toEqual(['EchoBinding', 'WsiEchoBinding']);
    const wsi = full.interfaces[1]!;
    expect(wsi.operations[0]!.calls[0]!.useWsAddressing).toBe(true);
    expect(wsi.operations[1]).toMatchObject({ name: 'Unused', calls: [] });
    expect(parseLegacyProject(fixture('no-cache.xml')).interfaces[0]).toMatchObject({ soapVersion: '1.2' });
    expect(parseLegacyProject(fixture('no-cache.xml')).interfaces[0]!.cache).toBeUndefined();
  });

  it('reads project properties and environments with their endpoint overrides', () => {
    const full = parseLegacyProject(fixture('full.xml'));
    expect(full.description).toBe('Everything the v1 import reads, and the things it only reports.');
    expect(full.properties).toEqual([
      { name: 'greeting', value: 'Hello' },
      { name: 'tenant', value: 'acme' },
      { name: 'empty', value: '' },
    ]);
    expect(full.environments).toEqual([
      { name: 'Default', properties: [{ name: 'tenant', value: 'acme-dev' }], endpoints: [] },
      {
        name: 'Staging',
        properties: [{ name: 'tenant', value: 'acme-staging' }],
        endpoints: [{ interfaceName: 'EchoBinding', url: 'https://staging.example.invalid/echo' }],
      },
    ]);
  });

  it('collects every non-empty script with its owners, and skips empty ones', () => {
    const scripts = parseLegacyProject(fixture('full.xml')).scripts;
    expect(scripts.map((script) => [script.ownerPath.join(' › '), script.element, script.language])).toEqual([
      ['Smoke › Echo once › Prepare', 'script', undefined],
      ['Smoke › Echo once', 'setupScript', undefined],
      ['Smoke', 'setupScript', 'javascript'],
      ['Echo mock', 'startScript', undefined],
      ['', 'afterLoadScript', undefined],
    ]);
    expect(scripts[4]!.source).toBe("log.info('project loaded')\n// second line");
  });

  it('lists the user work v1 leaves behind', () => {
    const unmapped = parseLegacyProject(fixture('full.xml')).unmapped;
    expect(unmapped).toEqual([
      { ownerPath: ['Accounts REST'], message: 'A rest service is not imported; only SOAP interfaces are.' },
      { ownerPath: ['Smoke'], message: 'Test suite with 1 test case is not imported.' },
      { ownerPath: ['Echo mock'], message: 'Mock service is not imported.' },
    ]);
  });

  it('reports populated configuration containers', () => {
    const unmapped = parseLegacyProject(project('<con:wssContainer><con:crypto/></con:wssContainer>')).unmapped;
    expect(unmapped).toEqual([{ ownerPath: [], message: expect.stringContaining('WS-Security') as string }]);
  });

  it('rejects malformed XML, other documents, DTDs and encrypted projects with a coded error', () => {
    expectCode(() => parseLegacyProject(fixture('malformed.xml')), 'legacy-malformed');
    expectCode(() => parseLegacyProject(fixture('not-a-project.xml')), 'legacy-not-a-project');
    expectCode(() => parseLegacyProject(`<!DOCTYPE x [<!ENTITY a "b">]>${project('')}`), 'legacy-malformed');
    expectCode(
      () => parseLegacyProject(project('<con:encryptedContent>AAAA</con:encryptedContent>')),
      'legacy-encrypted',
    );
  });

  it('tolerates a bare project with nothing in it', () => {
    expect(parseLegacyProject(project('', ''))).toEqual({
      name: 'Imported project',
      properties: [],
      interfaces: [],
      environments: [],
      scripts: [],
      unmapped: [],
    });
  });
});

describe('readLegacySoapProject', () => {
  it('reads a file', async () => {
    const parsed = await readLegacySoapProject({ kind: 'file', path: resolve(FIXTURES, 'minimal.xml') });
    expect(parsed.name).toBe('Minimal');
  });

  it('fails with legacy-read-failed for a missing file and legacy-too-large for oversized text', async () => {
    await expect(readLegacySoapProject({ kind: 'file', path: resolve(FIXTURES, 'nope.xml') })).rejects.toMatchObject({
      code: 'legacy-read-failed',
    });
    await expect(
      readLegacySoapProject({ kind: 'text', text: ' '.repeat(MAX_LEGACY_PROJECT_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'legacy-too-large' });
  });
});
