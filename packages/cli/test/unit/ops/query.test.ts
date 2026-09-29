// packages/cli/test/unit/ops/query.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendHistory, REDACTED_MARKER } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { queryOp } from '../../../src/ops/query.js';
import { historyFileFor } from '../../../src/ops/paths.js';
import { emptyProject, removeTempDirs, SECRET, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

describe('op query', () => {
  it('runs XPath on XML, with the document prefixes and given ones', async () => {
    const fixture = await emptyProject();
    expect(await runOp(queryOp, { expression: 'string(//*:result)', text: ADD_RESPONSE }, fixture.base())).toEqual({
      language: 'xpath',
      results: ['5'],
      truncated: false,
    });
    const prefixed = await runOp(queryOp, { expression: 'string(//c:result)', text: ADD_RESPONSE }, fixture.base());
    expect(prefixed.results).toEqual(['5']);
    const given = await runOp(
      queryOp,
      { expression: 'string(//calc:result)', text: ADD_RESPONSE, namespaces: { calc: 'urn:wirebench:calculator' } },
      fixture.base(),
    );
    expect(given.results).toEqual(['5']);
  });

  it('runs JSONPath on JSON, read from a file', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'pets.json');
    await writeFile(file, '[{"id":1,"name":"Rex"},{"id":2,"name":"Tom"}]');
    const result = await runOp(queryOp, { expression: '$[*].name', file }, fixture.base());
    expect(result).toEqual({ language: 'jsonpath', results: ['Rex', 'Tom'], truncated: false });
  });

  it('reports a bad expression, and takes exactly one source', async () => {
    const fixture = await emptyProject();
    await expect(runOp(queryOp, { expression: '//[', text: ADD_RESPONSE }, fixture.base())).rejects.toMatchObject({
      code: 'query-failed',
    });
    await expect(
      runOp(queryOp, { expression: '//a', text: ADD_RESPONSE, file: 'x.xml' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(runOp(queryOp, { expression: '//a' }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(runOp(queryOp, { expression: '//a', historyId: 'nope' }, fixture.base())).rejects.toMatchObject({
      code: 'history-entry-not-found',
    });
  });

  it('reports a file that is not there, with the resolved path', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(queryOp, { expression: '//a', file: join(await tempDir(), 'missing.xml') }, fixture.base()),
    ).rejects.toMatchObject({ code: 'file-not-found' });
  });

  describe('redaction', () => {
    const LOGIN =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
      'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>ann</wsse:Username>' +
      `<wsse:Password>${SECRET}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>` +
      '<soapenv:Body/></soapenv:Envelope>';

    it('masks a WS-Security password however XPath selects it, and gives no way to probe it', async () => {
      const fixture = await emptyProject();
      const run = (expression: string): Promise<{ results: readonly string[] }> =>
        runOp(queryOp, { expression, text: LOGIN }, fixture.base());
      expect((await run('string(//*:Password)')).results).toEqual([REDACTED_MARKER]);
      expect((await run('//*:Password/text()')).results).toEqual([REDACTED_MARKER]);
      const node = await run('//*:UsernameToken');
      // A serialised node shows the marker as XML text.
      expect(node.results.join('')).toContain('<wsse:Password>&lt;redacted&gt;</wsse:Password>');
      expect(node.results.join('')).not.toContain(SECRET);
      expect((await run(`//*:Password = '${SECRET}'`)).results).toEqual(['false']);
      expect((await run('string(//*:Username)')).results).toEqual(['ann']);
    });

    it('masks a secret-keyed JSON value, whole, under any path', async () => {
      const fixture = await emptyProject();
      const file = join(await tempDir(), 'login.json');
      await writeFile(file, JSON.stringify({ user: 'ann', password: SECRET, nested: { token: { value: SECRET } } }));
      const result = async (expression: string): Promise<readonly string[]> =>
        (await runOp(queryOp, { expression, file }, fixture.base())).results;
      expect(await result('$.password')).toEqual([REDACTED_MARKER]);
      expect(await result('$.nested.token.value')).toEqual([]);
      expect(await result('$.user')).toEqual(['ann']);
      expect((await result('$..*')).join('')).not.toContain(SECRET);
    });

    it('masks a History entry read as request or response', async () => {
      const fixture = await emptyProject();
      const entry: HistoryEntry = {
        id: '01J0000000000000000000ABCD',
        kind: 'soap',
        at: new Date().toISOString(),
        projectId: 'mcp-fixture',
        requestName: 'Login',
        interfaceName: 'Auth',
        operationName: 'Login',
        endpoint: 'http://localhost/auth',
        soapVersion: '1.1',
        status: 200,
        durationMs: 1,
        ok: true,
        sizeBytes: 0,
        request: { envelopeXml: LOGIN.replaceAll(REDACTED_MARKER, SECRET), headers: [] },
        response: { envelopeXml: LOGIN, rawHeaders: [['Content-Type', 'text/xml']], status: 200, statusText: 'OK' },
      };
      await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entry);
      for (const direction of ['request', 'response'] as const) {
        const result = await runOp(
          queryOp,
          { expression: 'string(//*:Password)', historyId: entry.id, direction },
          fixture.base(),
        );
        expect(result.results).toEqual([REDACTED_MARKER]);
      }
    });
  });
});
