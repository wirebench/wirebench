import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ContractChange } from '../../../src/contract-diff/model.js';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { diffWsdlContracts } from '../../../src/wsdl/contract-diff.js';

const fixtures = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/contract-diff/', import.meta.url));

const load = (name: string): Promise<WsdlImportResult> => importWsdl({ kind: 'file', path: join(fixtures, name) });

const row = (change: ContractChange): string =>
  [change.severity, change.kind, change.operation ?? '-', change.location ?? '-'].join(' ');

let v1: WsdlImportResult;
let v2: WsdlImportResult;

beforeAll(async () => {
  v1 = await load('v1.wsdl');
  v2 = await load('v2.wsdl');
});

const SIDES = { old: { label: 'v1.wsdl' }, new: { label: 'v2.wsdl' } };

describe('diffWsdlContracts', () => {
  it('finds every change of the fixture pair, classified, breaking first', () => {
    const diff = diffWsdlContracts(v1, v2, SIDES);
    expect(diff.format).toBe('wsdl');
    expect(diff.operationsCompared).toBe(2);
    expect(diff.changes.map(row)).toEqual([
      'breaking operation-removed OrderBinding#CancelOrder -',
      'breaking endpoint-moved - -',
      'breaking type-narrowed OrderBinding#PlaceOrder request.quantity',
      'breaking field-required OrderBinding#PlaceOrder request.note',
      'breaking enum-values-removed OrderBinding#PlaceOrder request.priority',
      'breaking soap-action-changed OrderBinding#GetStatus -',
      'breaking enum-values-added OrderBinding#GetStatus response.status',
      'compatible operation-added OrderBinding#TrackOrder -',
      'compatible field-added OrderBinding#PlaceOrder response.eta',
    ]);
  });

  it('says what changed in words', () => {
    const messages = diffWsdlContracts(v1, v2, SIDES).changes.map((change) => change.message);
    expect(messages).toContain('endpoint http://example.invalid/orders/v1 moved to http://example.invalid/orders/v2');
    expect(messages).toContain('enumeration values removed: "low"');
    expect(messages).toContain('SOAP action "urn:wb:orders:GetStatus" became "urn:wb:orders:GetOrderStatus"');
  });

  it('finds nothing between a contract and itself', () => {
    const diff = diffWsdlContracts(v1, v1, SIDES);
    expect(diff.changes).toEqual([]);
    expect(diff.operationsCompared).toBe(3);
  });

  it('reads the reverse direction with the reverse classification', () => {
    const rows = diffWsdlContracts(v2, v1, SIDES).changes.map(row);
    expect(rows).toContain('compatible type-widened OrderBinding#PlaceOrder request.quantity');
    expect(rows).toContain('compatible field-optional OrderBinding#PlaceOrder request.note');
    expect(rows).toContain('breaking field-removed OrderBinding#PlaceOrder response.eta');
  });
});
