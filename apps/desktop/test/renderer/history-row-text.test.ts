import { describe, expect, it } from 'vitest';
import {
  endpointParts,
  historyCountLabel,
  historyStatusChip,
  historyTabTitle,
  hostOf,
} from '../../src/renderer/features/history/history-row-text.js';

describe('History row text', () => {
  it('titles an entry tab with its name and local send time', () => {
    const at = new Date(2026, 9, 14, 9, 5, 7).toISOString();
    expect(historyTabTitle({ requestName: 'Pet', at })).toBe('Pet · 09:05:07');
  });

  it('pluralises the footer count', () => {
    expect(historyCountLabel(0)).toBe('0 entries');
    expect(historyCountLabel(1)).toBe('1 entry');
    expect(historyCountLabel(2)).toBe('2 entries');
  });

  it('reads the host of a URL, and keeps a placeholder as it is', () => {
    expect(hostOf('https://api.test:8443/pet/1')).toBe('api.test:8443');
    expect(hostOf('${base}/pet')).toBe('${base}/pet');
  });

  it('splits a URL into the path a row leads with and its host (G04)', () => {
    expect(endpointParts('https://api.test:8443/pets/1?full=1')).toEqual({
      path: '/pets/1?full=1',
      host: 'api.test:8443',
    });
    expect(endpointParts('${base}/pet')).toEqual({ path: '${base}/pet', host: '' });
  });

  it('names the kind of failure on a send that got no status (#732 X12)', () => {
    expect(historyStatusChip({ status: 200 })).toBe('200');
    expect(historyStatusChip({ error: { code: 'connection-refused', message: 'Connection refused.' } })).toBe(
      'refused',
    );
    expect(historyStatusChip({ error: { code: 'dns', message: 'DNS lookup failed.' } })).toBe('DNS');
    expect(historyStatusChip({ error: { code: 'something-new', message: '?' } })).toBe('err');
    expect(historyStatusChip({})).toBe('err');
  });
});
