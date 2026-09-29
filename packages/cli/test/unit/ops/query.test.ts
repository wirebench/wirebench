// packages/cli/test/unit/ops/query.test.ts
import { execFileSync } from 'node:child_process';
import { link, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendHistory, REDACTED_MARKER } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { MAX_RESULT_CHARS, MAX_TOTAL_CHARS, queryOp } from '../../../src/ops/query.js';
import { historyFileFor } from '../../../src/ops/paths.js';
import { MAX_FILE_BYTES } from '../../../src/ops/sources.js';
import { emptyProject, removeTempDirs, SECRET, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/** The error a call rejects with; the test fails when it does not reject. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

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

  it("masks the values of the server's WIREBENCH_SECRET_* variables and its token, for an MCP origin only", async () => {
    const fixture = await emptyProject();
    const token = 'abc123def456ghi789abc123def456ghi789';
    const text = JSON.stringify({ note: `a ${SECRET} b`, other: `c ${token} d` });
    const env = { WIREBENCH_SECRET_X: SECRET, WIREBENCH_MCP_TOKEN: token, WIREBENCH_SECRET_EMPTY: '' };

    const mcp = await runOp(queryOp, { expression: '$.*', text }, fixture.base({ env, origin: 'mcp' }));
    const cli = await runOp(queryOp, { expression: '$.*', text }, fixture.base({ env, origin: 'cli' }));

    expect(mcp.results).toEqual([`a ${REDACTED_MARKER} b`, `c ${REDACTED_MARKER} d`]);
    expect(cli.results).toEqual([`a ${SECRET} b`, `c ${token} d`]);
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

describe('op query: kind, size, files and errors', () => {
  const entryOf = (response: string, contentType: string): HistoryEntry => ({
    id: '01J0000000000000000000WXYZ',
    kind: 'rest',
    at: new Date().toISOString(),
    projectId: 'mcp-fixture',
    requestName: 'Get',
    interfaceName: 'Api',
    operationName: 'Get',
    endpoint: 'http://localhost/api',
    soapVersion: 'none',
    status: 200,
    durationMs: 1,
    ok: true,
    sizeBytes: 0,
    request: { envelopeXml: '', headers: [] },
    response: { envelopeXml: response, rawHeaders: [['Content-Type', contentType]], status: 200, statusText: 'OK' },
  });

  it('decides JSON from the text, whatever content type the message declares', async () => {
    const fixture = await emptyProject();
    const body = JSON.stringify({ user: 'ann', password: SECRET });
    for (const contentType of ['text/plain', 'application/xml', 'text/html']) {
      await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entryOf(body, contentType));
      const result = await runOp(
        queryOp,
        { expression: '$.password', historyId: '01J0000000000000000000WXYZ' },
        fixture.base(),
      );
      expect(result).toEqual({ language: 'jsonpath', results: [REDACTED_MARKER], truncated: false });
      await runOp(queryOp, { expression: '$.user', historyId: '01J0000000000000000000WXYZ' }, fixture.base());
    }
  });

  it('decides XML from the text too, and still masks its password under a JSON content type', async () => {
    const fixture = await emptyProject();
    const xml = `<a><Password>${SECRET}</Password></a>`;
    await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entryOf(xml, 'application/json'));
    const result = await runOp(
      queryOp,
      { expression: 'string(//Password)', historyId: '01J0000000000000000000WXYZ' },
      fixture.base(),
    );
    expect(result).toEqual({ language: 'xpath', results: [REDACTED_MARKER], truncated: false });
  });

  it('keeps form redaction for a declared form type', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'form.txt');
    await writeFile(file, `user=ann&password=${SECRET}`);
    await expect(runOp(queryOp, { expression: '$.user', file }, fixture.base())).rejects.toMatchObject({
      code: 'query-failed',
    });
    await appendHistory(
      historyFileFor(fixture.historyDir, 'mcp-fixture'),
      entryOf(`user=ann&password=${SECRET}`, 'application/x-www-form-urlencoded'),
    );
    // Not JSON, so the query fails, and the error does not echo the form.
    const error = await rejection(
      runOp(queryOp, { expression: '$.user', historyId: '01J0000000000000000000WXYZ' }, fixture.base()),
    );
    expect(error.message).not.toContain(SECRET);
  });

  it('escapes only the redactor marker, leaving an element named redacted intact', async () => {
    const fixture = await emptyProject();
    const xml = `<a><Password>${SECRET}</Password><redacted>keep</redacted><redacted></redacted></a>`;
    const run = async (expression: string): Promise<readonly string[]> =>
      (await runOp(queryOp, { expression, text: xml }, fixture.base())).results;
    expect(await run('string(//Password)')).toEqual([REDACTED_MARKER]);
    expect(await run('string(//redacted[1])')).toEqual(['keep']);
    expect(await run('count(//redacted)')).toEqual(['2']);
  });

  it('reads a stored entry whose masked secret is the whole text of any element as well-formed XML', async () => {
    const fixture = await emptyProject();
    // A send's masker replaced the Token's resolved value; the marker is not a Password's.
    const xml = `<a><Token>${REDACTED_MARKER}</Token><b>1</b><redacted></redacted></a>`;
    await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entryOf(xml, 'text/xml'));
    const run = async (expression: string): Promise<readonly string[]> =>
      (await runOp(queryOp, { expression, historyId: '01J0000000000000000000WXYZ' }, fixture.base())).results;

    expect(await run('string(//b)')).toEqual(['1']);
    expect(await run('string(//Token)')).toEqual([REDACTED_MARKER]);
    expect(await run('count(//redacted)')).toEqual(['1']);
  });

  it('keeps a JSON body declared as a form valid JSON, its strings whole', async () => {
    const fixture = await emptyProject();
    await appendHistory(
      historyFileFor(fixture.historyDir, 'mcp-fixture'),
      entryOf(JSON.stringify({ q: 'a&token=b', password: SECRET }), 'application/x-www-form-urlencoded'),
    );
    const run = async (expression: string): Promise<readonly string[]> =>
      (await runOp(queryOp, { expression, historyId: '01J0000000000000000000WXYZ' }, fixture.base())).results;

    expect(await run('$.q')).toEqual(['a&token=b']);
    expect(await run('$.password')).toEqual([REDACTED_MARKER]);
  });

  it('stops adding results when what is left cannot hold a whole character', async () => {
    const fixture = await emptyProject();
    const full = "string-join((1 to 65536) ! 'x')";
    const expression = `(${full}, ${full}, ${full}, string-join((1 to 65535) ! 'x'), codepoints-to-string((128512, 128512)), 'y')`;

    const result = await runOp(queryOp, { expression, text: '<a/>' }, fixture.base());

    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((item) => item.length > 0)).toBe(true);
    expect(result.results.reduce((sum, item) => sum + item.length, 0)).toBe(MAX_TOTAL_CHARS - 1);
  });

  it('cuts one result at 64 KiB and all results at 256 KiB, and says so', async () => {
    const fixture = await emptyProject();
    const one = await runOp(queryOp, { expression: "string-join((1 to 100000) ! 'x')", text: '<a/>' }, fixture.base());
    expect(one.truncated).toBe(true);
    expect(one.results).toHaveLength(1);
    expect(one.results[0]).toHaveLength(MAX_RESULT_CHARS);

    const many = await runOp(
      queryOp,
      { expression: "(1 to 10) ! string-join((1 to 40000) ! 'x')", text: '<a/>' },
      fixture.base(),
    );
    expect(many.truncated).toBe(true);
    expect(many.results.reduce((sum, item) => sum + item.length, 0)).toBe(MAX_TOTAL_CHARS);

    const small = await runOp(queryOp, { expression: "(1 to 3) ! 'x'", text: '<a/>' }, fixture.base());
    expect(small).toEqual({ language: 'xpath', results: ['x', 'x', 'x'], truncated: false });
  });

  it('does not echo a message that does not parse', async () => {
    const fixture = await emptyProject();
    const json = await rejection(
      runOp(queryOp, { expression: '$.password', text: `{"password": ${SECRET}}` }, fixture.base()),
    );
    expect(json).toMatchObject({ code: 'query-failed', message: 'the message is not well-formed JSON' });
    const xml = await rejection(runOp(queryOp, { expression: '//a', text: `<a><b>${SECRET}</a>` }, fixture.base()));
    expect(xml).toMatchObject({ code: 'query-failed', message: 'the message is not well-formed XML' });
  });

  it('keeps a bad expression on a good message as the evaluator says it', async () => {
    const fixture = await emptyProject();
    const error = await rejection(runOp(queryOp, { expression: '//[', text: '<a/>' }, fixture.base()));
    expect(error).toMatchObject({ code: 'query-failed' });
    expect(error.message).not.toContain('not well-formed');
  });

  it('refuses a History file as a file source, through a symlink too', async () => {
    const fixture = await emptyProject();
    await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entryOf(`{"password":"${SECRET}"}`, 'x'));
    const history = historyFileFor(fixture.historyDir, 'mcp-fixture');
    const link = join(await tempDir(), 'link.jsonl');
    await symlink(history, link);
    const dirLink = join(await tempDir(), 'dir-link');
    await symlink(fixture.historyDir, dirLink);
    for (const file of [history, link, join(dirLink, 'mcp-fixture.jsonl'), fixture.historyDir]) {
      const error = await rejection(runOp(queryOp, { expression: '$', file }, fixture.base()));
      expect(error).toMatchObject({
        code: 'invalid-input',
        message: 'History files are read through historyId, not file',
      });
    }
  });

  it('reports a directory as file-not-found, not a regular file', async () => {
    const fixture = await emptyProject();
    const error = await rejection(runOp(queryOp, { expression: '$', file: await tempDir() }, fixture.base()));
    expect(error).toMatchObject({ code: 'file-not-found' });
    expect(error.message).toContain('not a regular file');
  });

  it('refuses a hard link to a History file', async () => {
    const fixture = await emptyProject();
    const history = historyFileFor(fixture.historyDir, 'mcp-fixture');
    await appendHistory(history, entryOf(`{"password":"${SECRET}"}`, 'x'));
    const hard = join(await tempDir(), 'copy.txt');
    await link(history, hard);
    const error = await rejection(runOp(queryOp, { expression: '$', file: hard }, fixture.base()));
    expect(error).toMatchObject({
      code: 'invalid-input',
      message: 'History files are read through historyId, not file',
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without opening it, so no writer is waited for', async () => {
    const fixture = await emptyProject();
    const fifo = join(await tempDir(), 'pipe.xml');
    execFileSync('mkfifo', [fifo]);

    await expect(runOp(queryOp, { expression: '//a', file: fifo }, fixture.base())).rejects.toMatchObject({
      code: 'file-not-found',
      message: expect.stringContaining('not a regular file') as unknown,
    });
  });

  it('reads a file up to 16 MiB and refuses a larger one', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'big.json');
    await writeFile(file, '"x"');
    await truncate(file, MAX_FILE_BYTES + 1);
    const error = await rejection(runOp(queryOp, { expression: '$', file }, fixture.base()));
    expect(error).toMatchObject({ code: 'invalid-input', message: 'the file is larger than 16 MiB' });
  });

  it('masks a JSON body sent under a declared form content type', async () => {
    const fixture = await emptyProject();
    const entry: HistoryEntry = {
      ...entryOf('', 'x'),
      request: {
        envelopeXml: `{"password":"${SECRET}","user":"ann"}`,
        headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      },
    };
    await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entry);
    const result = await runOp(
      queryOp,
      { expression: '$.password', historyId: entry.id, direction: 'request' },
      fixture.base(),
    );
    expect(result).toEqual({ language: 'jsonpath', results: [REDACTED_MARKER], truncated: false });
  });

  it('does not cut a result between the halves of a surrogate pair', async () => {
    const fixture = await emptyProject();
    const result = await runOp(
      queryOp,
      { expression: "'x' || string-join((1 to 40000) ! codepoints-to-string(128512))", text: '<a/>' },
      fixture.base(),
    );
    const [item] = result.results;
    expect(result.truncated).toBe(true);
    expect(item).toHaveLength(MAX_RESULT_CHARS - 1);
    const last = item?.charCodeAt((item?.length ?? 1) - 1) ?? 0;
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
