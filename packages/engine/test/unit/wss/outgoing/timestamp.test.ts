import { describe, expect, it } from 'vitest';
import { buildTimestamp } from '../../../../src/wss/outgoing/timestamp.js';
import { serializeXml } from '../../../../src/xml/serialize.js';

const CLOCK = () => new Date('2026-09-09T12:00:00.250Z');
const UUID = () => '11111111-2222-3333-4444-555555555555';

describe('buildTimestamp', () => {
  it('writes Created and Expires at whole-second precision', () => {
    const element = buildTimestamp({ ttlSeconds: 300, millisecondPrecision: false, clock: CLOCK, uuid: UUID });
    expect(serializeXml(element)).toBe(
      '<wsu:Timestamp xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"' +
        ' wsu:Id="TS-11111111-2222-3333-4444-555555555555">' +
        '<wsu:Created>2026-09-09T12:00:00Z</wsu:Created>' +
        '<wsu:Expires>2026-09-09T12:05:00Z</wsu:Expires>' +
        '</wsu:Timestamp>',
    );
  });

  it('writes millisecond precision when asked', () => {
    const element = buildTimestamp({ ttlSeconds: 60, millisecondPrecision: true, clock: CLOCK, uuid: UUID });
    const xml = serializeXml(element);
    expect(xml).toContain('<wsu:Created>2026-09-09T12:00:00.250Z</wsu:Created>');
    expect(xml).toContain('<wsu:Expires>2026-09-09T12:01:00.250Z</wsu:Expires>');
  });

  it('omits Expires for a zero time-to-live', () => {
    const element = buildTimestamp({ ttlSeconds: 0, millisecondPrecision: false, clock: CLOCK, uuid: UUID });
    const xml = serializeXml(element);
    expect(xml).toContain('<wsu:Created>');
    expect(xml).not.toContain('Expires');
  });
});
