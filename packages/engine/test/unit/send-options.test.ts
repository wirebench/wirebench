import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_PROPERTIES } from '../../src/project/model.js';
import type { RequestProperties } from '../../src/project/model.js';
import { DEFAULT_PREFERENCES, mergePreferences } from '../../src/project/preferences.js';
import { toSendInput } from '../../src/send-options.js';
import type { SendRequestInput, ToSendInputArgs } from '../../src/send-options.js';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><a><b>?</b><c>1</c></a></soapenv:Body></soapenv:Envelope>';

function request(properties: Partial<RequestProperties> = {}, extra: Partial<SendRequestInput> = {}): SendRequestInput {
  return {
    properties: { ...DEFAULT_REQUEST_PROPERTIES, ...properties },
    soapVersion: '1.1',
    headers: [],
    envelopeXml: ENVELOPE,
    ...extra,
  };
}

function build(args: Partial<ToSendInputArgs> & { request?: SendRequestInput } = {}) {
  return toSendInput({
    request: args.request ?? request(),
    endpoint: args.endpoint ?? 'http://example.test/soap',
    ...(args.preferences !== undefined ? { preferences: args.preferences } : {}),
    ...(args.projectSettings !== undefined ? { projectSettings: args.projectSettings } : {}),
    ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
    ...(args.attachmentResolvers !== undefined ? { attachmentResolvers: args.attachmentResolvers } : {}),
  });
}

const RESOLVERS = {
  resolver: () => Promise.resolve(new Uint8Array([1])),
  resolveFile: () => Promise.resolve(new Uint8Array([2])),
  resourceRoot: '/projects/demo/res',
};

const ATTACHMENT = {
  id: 'A1',
  name: 'invoice.pdf',
  contentType: 'application/pdf',
  size: 1,
  type: 'MIME' as const,
  contentId: 'A1@wirebench',
  cached: true,
  source: { kind: 'cache' as const, sha256: 'a'.repeat(64) },
};

describe('toSendInput mapping', () => {
  it('maps the transport properties one for one', () => {
    const input = build({
      request: request({
        encoding: 'ISO-8859-1',
        followRedirects: true,
        skipSoapAction: true,
        maxSizeBytes: 4096,
        bindAddress: '127.0.0.1',
      }),
    });
    expect(input.encoding).toBe('ISO-8859-1');
    expect(input.followRedirects).toBe(true);
    expect(input.skipSoapAction).toBe(true);
    expect(input.maxSizeBytes).toBe(4096);
    expect(input.localAddress).toBe('127.0.0.1');
  });

  it('omits an empty bind address rather than binding to ""', () => {
    expect(build({ request: request({ bindAddress: '' }) }).localAddress).toBeUndefined();
  });

  it('carries the endpoint, soap version and action through', () => {
    const input = build({ request: request({}, { soapVersion: '1.2', soapAction: 'urn:Add' }) });
    expect(input.endpoint).toBe('http://example.test/soap');
    expect(input.soapVersion).toBe('1.2');
    expect(input.soapAction).toBe('urn:Add');
  });
});

describe('toSendInput timeout precedence', () => {
  const preferences = mergePreferences({ http: { socketTimeoutMs: 11_000 } });

  it('prefers the request property', () => {
    const input = build({
      request: request({ timeoutMs: 100 }),
      preferences,
      projectSettings: { defaultTimeoutMs: 5000 },
    });
    expect(input.timeoutMs).toBe(100);
  });

  it('falls back to the project setting', () => {
    expect(build({ preferences, projectSettings: { defaultTimeoutMs: 5000 } }).timeoutMs).toBe(5000);
  });

  it('falls back to the preference when the project says nothing', () => {
    expect(build({ preferences }).timeoutMs).toBe(11_000);
  });

  it('falls back to the built-in defaults with no preferences at all', () => {
    expect(build().timeoutMs).toBe(DEFAULT_PREFERENCES.http.socketTimeoutMs);
  });
});

describe('toSendInput headers', () => {
  it('adds the preferred User-Agent and Accept-Encoding', () => {
    const input = build();
    expect(input.headers?.['User-Agent']).toBe('Wirebench/0.1');
    expect(input.headers?.['Accept-Encoding']).toBe('gzip, deflate');
    expect(input.headers?.['Connection']).toBeUndefined();
  });

  it("leaves the request's own User-Agent alone, whatever its casing", () => {
    const input = build({ request: request({}, { headers: [{ name: 'user-agent', value: 'Mine/9' }] }) });
    expect(input.headers?.['user-agent']).toBe('Mine/9');
    expect(input.headers?.['User-Agent']).toBeUndefined();
  });

  it('omits Accept-Encoding when response compression is off', () => {
    const preferences = mergePreferences({ http: { responseCompression: false } });
    expect(build({ preferences }).headers?.['Accept-Encoding']).toBeUndefined();
  });

  it('adds Connection: close when connection reuse is off', () => {
    const preferences = mergePreferences({ http: { closeConnections: true } });
    expect(build({ preferences }).headers?.['Connection']).toBe('close');
  });

  it('asks the transport to gzip the body when request compression is on', () => {
    const preferences = mergePreferences({ http: { requestCompression: 'gzip' } });
    expect(build({ preferences }).compressBody).toBe('gzip');
    expect(build().compressBody).toBeUndefined();
  });
});

describe('toSendInput envelope transforms', () => {
  it('leaves the envelope alone when no transform is requested', () => {
    expect(build().envelopeXml).toBe(ENVELOPE);
  });

  it('removes empty content, then strips whitespace, then pretty prints — in that order', () => {
    const preferences = mergePreferences({ editor: { tabSize: 2 } });
    const input = build({
      request: request({ removeEmptyContent: true, stripWhitespaces: true, prettyPrint: true }),
      preferences,
    });
    // The `?` placeholder element is gone, and what is left is indented two spaces per level.
    expect(input.envelopeXml).not.toContain('<b>');
    expect(input.envelopeXml).toContain('\n  <soapenv:Body>');
    expect(input.envelopeXml).toContain('\n      <c>1</c>');
  });

  it('requests entitizing only when the property is set', () => {
    expect(build().entitize).toBeUndefined();
    expect(build({ request: request({ entitizeProperties: true }) }).entitize).toBe(true);
  });

  it('leaves attachments alone when no resolver can read their bytes', () => {
    const input = build({
      request: request({ enableMtom: true, forceMtom: true, disableMultiparts: true }),
      attachments: [ATTACHMENT],
    });
    expect(input.attachmentOptions).toBeUndefined();
    expect(input.attachments).toBeUndefined();
    expect(input.envelopeXml).toBe(ENVELOPE);
  });

  it('passes the MTOM/attachment properties and resolvers straight through', () => {
    const input = build({
      request: request({
        enableMtom: true,
        forceMtom: true,
        disableMultiparts: true,
        encodeAttachments: true,
        enableInlineFiles: true,
        inlineResponseAttachments: true,
        expandMtomAttachments: true,
      }),
      attachments: [ATTACHMENT],
      attachmentResolvers: RESOLVERS,
    });

    expect(input.attachments).toEqual([ATTACHMENT]);
    expect(input.attachmentOptions).toMatchObject({
      enableMtom: true,
      forceMtom: true,
      disableMultiparts: true,
      encodeAttachments: true,
      enableInlineFiles: true,
      inlineResponseAttachments: true,
      expandMtomAttachments: true,
      resolver: RESOLVERS.resolver,
      resolveFile: RESOLVERS.resolveFile,
      resourceRoot: RESOLVERS.resourceRoot,
    });
    // The envelope is not rewritten here: MTOM and inline files happen inside the send.
    expect(input.envelopeXml).toBe(ENVELOPE);
  });

  it('reports the flags even for a request with no attachments, so inline files still work', () => {
    const input = build({
      request: request({ enableInlineFiles: true }),
      attachmentResolvers: { resolver: RESOLVERS.resolver, resolveFile: RESOLVERS.resolveFile },
    });
    expect(input.attachments).toEqual([]);
    expect(input.attachmentOptions?.enableInlineFiles).toBe(true);
    expect(input.attachmentOptions?.resourceRoot).toBeUndefined();
  });
});

describe('toSendInput content-type charset', () => {
  it('reflects a non-default encoding into the Content-Type charset (SOAP 1.1)', () => {
    const input = build({ request: request({ encoding: 'ISO-8859-1' }) });
    expect(input.headers?.['Content-Type']).toBe('text/xml;charset=ISO-8859-1');
  });

  it('reflects the charset for SOAP 1.2, keeping the action parameter', () => {
    const input = build({
      request: request({ encoding: 'ISO-8859-1' }, { soapVersion: '1.2', soapAction: 'urn:Add' }),
    });
    expect(input.headers?.['Content-Type']).toBe('application/soap+xml;charset=ISO-8859-1;action="urn:Add"');
  });

  it('leaves Content-Type unset for the default UTF-8 encoding', () => {
    expect(build().headers?.['Content-Type']).toBeUndefined();
  });

  it('never overrides a Content-Type the request already set', () => {
    const input = build({
      request: request(
        { encoding: 'ISO-8859-1' },
        { headers: [{ name: 'Content-Type', value: 'text/xml;charset=custom' }] },
      ),
    });
    expect(input.headers?.['Content-Type']).toBe('text/xml;charset=custom');
  });
});
