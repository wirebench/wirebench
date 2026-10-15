import { describe, expect, it } from 'vitest';
import {
  findHighlights,
  HIGHLIGHT_RULES,
  isIPv4,
  isIPv6,
  type HighlightKind,
} from '../../src/renderer/features/ssh/output-highlight.js';

/** The highlighted text and its kind, which reads better in a failure than offsets. */
function marked(text: string): [string, HighlightKind][] {
  return findHighlights(text).map((h) => [text.slice(h.start, h.end), h.kind]);
}

describe('words', () => {
  it('marks error, warning and info words in any case', () => {
    expect(marked('ERROR: disk full, Warning: retrying, info: done')).toEqual([
      ['ERROR', 'error'],
      ['Warning', 'warning'],
      ['info', 'info'],
    ]);
    expect(marked('[FAILED] unit failed; build fail; FATAL panic')).toEqual([
      ['FAILED', 'error'],
      ['failed', 'error'],
      ['fail', 'error'],
      ['FATAL', 'error'],
      ['panic', 'error'],
    ]);
    expect(marked('Permission denied (publickey)')).toEqual([['denied', 'error']]);
    expect(marked('warn: option deprecated')).toEqual([
      ['warn', 'warning'],
      ['deprecated', 'warning'],
    ]);
  });

  it('never marks a word inside another word', () => {
    expect(marked('stderr errorlog error_log terror failover information warned infos')).toEqual([]);
  });

  it('marks a word beside punctuation', () => {
    expect(marked('(error) "warning" info.')).toEqual([
      ['error', 'error'],
      ['warning', 'warning'],
      ['info', 'info'],
    ]);
  });
});

describe('IPv4', () => {
  it('accepts dotted quads from 0 to 255', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '192.168.1.254', '255.255.255.255']) {
      expect(isIPv4(address), address).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const text of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1..2.3', 'a.b.c.d', '']) {
      expect(isIPv4(text), text).toBe(false);
    }
  });

  it('marks addresses in a line, without the port or the full stop', () => {
    expect(marked('Accepted from 10.0.0.1 port 22')).toEqual([['10.0.0.1', 'address']]);
    expect(marked('connect to 192.168.0.10:2222 failed')).toEqual([
      ['192.168.0.10', 'address'],
      ['failed', 'error'],
    ]);
    expect(marked('reached 8.8.8.8.')).toEqual([['8.8.8.8', 'address']]);
    expect(marked('inet 172.17.0.2/16 brd 172.17.255.255')).toEqual([
      ['172.17.0.2', 'address'],
      ['172.17.255.255', 'address'],
    ]);
  });

  it('leaves versions, times and addresses glued to words alone', () => {
    expect(marked('v1.2.3.4 1.2.3.4.5 1.2.3 10.0.0.1ms at 12:30:45.123 on 2026.10.14')).toEqual([]);
  });
});

describe('IPv6', () => {
  it('accepts full, shortened and IPv4-tailed forms', () => {
    for (const address of [
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      '2001:db8::1',
      'fe80::1',
      '::1',
      '::ffff:10.0.0.1',
      'FE80::ABCD',
    ]) {
      expect(isIPv6(address), address).toBe(true);
    }
  });

  it('refuses MAC addresses, times, two gaps and bare colons', () => {
    for (const text of [
      'aa:bb:cc:dd:ee:ff',
      '12:30:45',
      '1::2::3',
      '::',
      ':::',
      '1:2:3:4:5:6:7:8:9',
      '12345::1',
      '1.2.3.4::',
      'fe80::g',
    ]) {
      expect(isIPv6(text), text).toBe(false);
    }
  });

  it('marks addresses in a line', () => {
    expect(marked('inet6 fe80::42:acff:fe11:2/64 scope link')).toEqual([['fe80::42:acff:fe11:2', 'address']]);
    expect(marked('listening on [::1]:8080 and 2001:db8::1.')).toEqual([
      ['::1', 'address'],
      ['2001:db8::1', 'address'],
    ]);
  });

  it('leaves C++ scopes and hex words alone', () => {
    expect(marked('std::vector deadbeef cafe:babe ether 02:42:ac:11:00:02')).toEqual([]);
  });
});

it('keeps highlights in order and apart', () => {
  const highlights = findHighlights('error 10.0.0.1 warning ::1 info');
  expect(highlights.map((h) => h.kind)).toEqual(['error', 'address', 'warning', 'address', 'info']);
  for (const [i, h] of highlights.entries()) {
    if (i > 0) expect(h.start).toBeGreaterThanOrEqual(highlights[i - 1]!.end);
  }
});

it('lists a rule for every kind', () => {
  expect(HIGHLIGHT_RULES.map((rule) => rule.kind)).toEqual(['error', 'warning', 'info', 'address']);
});

it('stays quick on a long line of address characters', () => {
  const line = `${'1:'.repeat(5000)}x ${'1.'.repeat(5000)}`;
  const started = performance.now();
  findHighlights(line);
  expect(performance.now() - started).toBeLessThan(500);
});
