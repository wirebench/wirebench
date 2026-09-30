// packages/cli/test/unit/ops/validate.test.ts
import { appendHistory } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { importOp } from '../../../src/ops/import.js';
import { sendOp } from '../../../src/ops/send.js';
import { historyFileFor } from '../../../src/ops/paths.js';
import { validateOp } from '../../../src/ops/validate.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  restItem,
  restProject,
  SECRET,
  soapProject,
  startServer,
  tempDir,
} from './helpers.js';

afterEach(removeTempDirs);

const envelope = (result: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  `<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>${result}</c:result></c:AddResponse>` +
  '</soapenv:Body></soapenv:Envelope>';

describe('op validate', () => {
  it('validates a SOAP response against the XSD, with positions', async () => {
    const fixture = await soapProject();
    const good = await runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('5') }, fixture.base());
    expect(good).toMatchObject({
      kind: 'soap',
      operation: 'CalculatorService/Add',
      direction: 'response',
      valid: true,
    });
    expect(good.problems.filter((problem) => problem.severity === 'error')).toEqual([]);

    const bad = await runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('five') }, fixture.base());
    expect(bad.valid).toBe(false);
    expect(bad.problems[0]).toMatchObject({ severity: 'error', line: expect.any(Number) as unknown });
  });

  it('validates a generated SOAP request as a request', async () => {
    const fixture = await soapProject();
    const generated = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());
    if (generated.kind !== 'soap') throw new Error('expected SOAP');
    const result = await runOp(
      validateOp,
      { operation: 'CalculatorService/Add', text: generated.body, direction: 'request' },
      fixture.base(),
    );
    expect(result).toMatchObject({ direction: 'request', valid: true });
  });

  it('checks a REST body against the OpenAPI response schema', async () => {
    const fixture = await restProject();
    const good = await runOp(
      validateOp,
      { operation: 'Pets/listPets', text: '[{"id":1,"name":"Rex"}]' },
      fixture.base(),
    );
    expect(good).toMatchObject({ kind: 'rest', status: 200, contract: 'ok', valid: true, problems: [] });

    const bad = await runOp(validateOp, { operation: 'Pets/listPets', text: '[{"id":"one"}]' }, fixture.base());
    expect(bad).toMatchObject({ kind: 'rest', contract: 'violation', valid: false });
    expect(bad.problems.length).toBeGreaterThan(0);

    await expect(
      runOp(validateOp, { operation: 'Pets/listPets', text: '{}', direction: 'request' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('calls a REST body it could not check valid but not checked, and an undeclared status invalid', async () => {
    const fixture = await restProject();
    const huge = JSON.stringify([{ id: 1, name: 'x'.repeat(1_100_000) }]);

    const skipped = await runOp(validateOp, { operation: 'Pets/listPets', text: huge }, fixture.base());
    expect(skipped).toMatchObject({ contract: 'skipped', valid: true, checked: false, truncated: false });

    const unmatched = await runOp(validateOp, { operation: 'Pets/listPets', text: '[]', status: 500 }, fixture.base());
    expect(unmatched).toMatchObject({ contract: 'unmatched', valid: false, checked: true });

    const ok = await runOp(validateOp, { operation: 'Pets/listPets', text: '[]' }, fixture.base());
    expect(ok).toMatchObject({ contract: 'ok', valid: true, checked: true });
  });

  it('lists at most 50 problems for REST and SOAP alike, and says when it cut them', async () => {
    const fixture = await restProject();
    const many = JSON.stringify(Array.from({ length: 60 }, () => ({ id: 'one' })));
    const rest = await runOp(validateOp, { operation: 'Pets/listPets', text: many }, fixture.base());
    expect(rest).toMatchObject({ contract: 'violation', valid: false, truncated: true });
    expect(rest.problems).toHaveLength(50);

    const soap = await soapProject();
    // Each wrong body child is a problem of its own.
    const children = Array.from(
      { length: 60 },
      () => '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>five</c:result></c:AddResponse>',
    ).join('');
    const text =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      `<soapenv:Body>${children}</soapenv:Body></soapenv:Envelope>`;
    const broken = await runOp(validateOp, { operation: 'CalculatorService/Add', text }, soap.base());
    expect(broken).toMatchObject({ kind: 'soap', valid: false, checked: true, truncated: true });
    expect(broken.problems).toHaveLength(50);

    const fine = await runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('5') }, soap.base());
    expect(fine).toMatchObject({ checked: true, truncated: false });
    // Two fixture imports and three validations: over 5 s on the Windows runner.
  }, 20_000);

  it('reads a History entry and finds its operation through the saved request', async () => {
    const fixture = await restProject();
    const pets = await startServer(() => ({
      headers: { 'Content-Type': 'application/json' },
      body: '[{"id":"one","name":"Rex"}]',
    }));
    try {
      await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
      const sent = await runOp(
        sendOp,
        { item: await restItem(fixture.dir, 'GET', '/pets'), environment: 'local' },
        fixture.base(),
      );
      const result = await runOp(validateOp, { historyId: sent.historyId }, fixture.base());
      expect(result).toMatchObject({ kind: 'rest', operation: 'Pets/GET /pets', status: 200, contract: 'violation' });
    } finally {
      await pets.close();
    }
  });

  it('asks for an operation when the source names none', async () => {
    const fixture = await soapProject();
    await expect(runOp(validateOp, { text: envelope('5') }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  it('reads a file, and reports one that is not there', async () => {
    const fixture = await soapProject();
    const file = join(await tempDir(), 'add-response.xml');
    await writeFile(file, envelope('5'));
    expect(await runOp(validateOp, { operation: 'CalculatorService/Add', file }, fixture.base())).toMatchObject({
      valid: true,
    });
    await expect(
      runOp(
        validateOp,
        { operation: 'CalculatorService/Add', file: join(await tempDir(), 'missing.xml') },
        fixture.base(),
      ),
    ).rejects.toMatchObject({ code: 'file-not-found' });
  });

  it('takes exactly one source', async () => {
    const fixture = await soapProject();
    await expect(
      runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('5'), file: 'x.xml' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(runOp(validateOp, { operation: 'CalculatorService/Add' }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  describe('redaction and History', () => {
    const entryOf = (overrides: {
      status?: number;
      response?: NonNullable<HistoryEntry['response']>;
    }): HistoryEntry => ({
      id: '01J0000000000000000000ABCD',
      kind: 'soap',
      at: new Date().toISOString(),
      projectId: 'mcp-fixture',
      requestName: 'Add',
      interfaceName: 'CalculatorService',
      operationName: 'Add',
      endpoint: 'http://localhost/calc',
      soapVersion: '1.1',
      durationMs: 1,
      ok: false,
      sizeBytes: 0,
      request: { envelopeXml: '<a/>', headers: [] },
      ...overrides,
    });

    it('never returns a message value a redactor masks, even where a problem quotes the value', async () => {
      // A response schema whose Password element allows one value only: a violation quotes the value.
      const wsdl = (await readFile(CALCULATOR_WSDL, 'utf8')).replace(
        '<xs:element name="result" type="xs:int"/>',
        '<xs:element name="result" type="xs:int"/>' +
          '<xs:element name="Password"><xs:simpleType><xs:restriction base="xs:string">' +
          '<xs:enumeration value="ok"/></xs:restriction></xs:simpleType></xs:element>',
      );
      const file = join(await tempDir(), 'calculator-password.wsdl');
      await writeFile(file, wsdl);
      const fixture = await emptyProject();
      await runOp(importOp, { source: file }, fixture.base());
      const bad = envelope('5').replace('</c:result>', `</c:result><c:Password>${SECRET}</c:Password>`);
      const soap = await runOp(validateOp, { operation: 'CalculatorService/Add', text: bad }, fixture.base());
      expect(soap.valid).toBe(false);
      expect(soap.problems.map((problem) => problem.message).join('\n')).toContain('redacted');
      expect(JSON.stringify(soap)).not.toContain(SECRET);

      const rest = await runOp(
        validateOp,
        { operation: 'Pets/listPets', text: `[{"id":"one","password":"${SECRET}"}]` },
        (await restProject()).base(),
      );
      expect(rest).toMatchObject({ kind: 'rest', valid: false });
      expect(JSON.stringify(rest)).not.toContain(SECRET);
    });

    it('validates a stored response whose password the send masked', async () => {
      const fixture = await soapProject();
      const stored = envelope('5').replace(
        '<soapenv:Body>',
        '<soapenv:Header><wsse:Security xmlns:wsse="urn:wsse"><wsse:Password><redacted></wsse:Password></wsse:Security></soapenv:Header><soapenv:Body>',
      );
      await appendHistory(
        historyFileFor(fixture.historyDir, 'mcp-fixture'),
        entryOf({
          status: 200,
          response: { envelopeXml: stored, rawHeaders: [['Content-Type', 'text/xml']], status: 200, statusText: 'OK' },
        }),
      );
      const result = await runOp(
        validateOp,
        { operation: 'CalculatorService/Add', historyId: '01J0000000000000000000ABCD' },
        fixture.base(),
      );
      expect(result).toMatchObject({ kind: 'soap', valid: true });
    });

    it('refuses a History entry that has no response, and an unknown one', async () => {
      const fixture = await soapProject();
      await appendHistory(historyFileFor(fixture.historyDir, 'mcp-fixture'), entryOf({}));
      await expect(
        runOp(
          validateOp,
          { operation: 'CalculatorService/Add', historyId: '01J0000000000000000000ABCD' },
          fixture.base(),
        ),
      ).rejects.toMatchObject({ code: 'history-no-response' });
      await expect(
        runOp(validateOp, { operation: 'CalculatorService/Add', historyId: 'nope' }, fixture.base()),
      ).rejects.toMatchObject({ code: 'history-entry-not-found' });
    });
  });
});
