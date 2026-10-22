import { describe, expect, it } from 'vitest';
import { DYNAMIC_GENERATORS, DynamicValues, generateDynamic, isDynamicName } from '#core/project/dynamic';

const NOW = new Date('2026-10-11T12:00:00.000Z');

function value(expr: string): string {
  const result = generateDynamic(expr, NOW);
  if (!result.ok) throw new Error(`${expr}: ${result.code} ${result.message}`);
  return result.value;
}

function code(expr: string): string {
  const result = generateDynamic(expr, NOW);
  if (result.ok) throw new Error(`${expr} resolved to ${result.value}`);
  return result.code;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('generateDynamic', () => {
  it('makes a UUID v4 under every spelling', () => {
    for (const name of ['guid', 'uuid', 'randomUUID']) expect(value(name)).toMatch(UUID);
    expect(value('guid')).not.toBe(value('guid'));
  });

  it('gives Unix seconds and ISO timestamps, with an optional offset', () => {
    expect(value('timestamp')).toBe(String(NOW.getTime() / 1000));
    expect(value('isoTimestamp')).toBe('2026-10-11T12:00:00.000Z');
    expect(value('isoTimestamp(+1d)')).toBe('2026-10-12T12:00:00.000Z');
    expect(value('isoTimestamp(-2h)')).toBe('2026-10-11T10:00:00.000Z');
    expect(value('timestamp(+30s)')).toBe(String(NOW.getTime() / 1000 + 30));
    expect(value('isoTimestamp( +1w )')).toBe('2026-10-18T12:00:00.000Z');
    expect(code('isoTimestamp(tomorrow)')).toBe('bad-arguments');
  });

  it('draws integers within the default or given bounds', () => {
    for (let i = 0; i < 50; i++) {
      const n = Number(value('randomInt'));
      expect(Number.isInteger(n) && n >= 0 && n <= 1000).toBe(true);
      const m = Number(value('randomInt(5, 7)'));
      expect(m >= 5 && m <= 7).toBe(true);
    }
    expect(value('randomInt(3,3)')).toBe('3');
    expect(value('randomInt(min=-2,max=-2)')).toBe('-2');
    expect(code('randomInt(9,1)')).toBe('bad-arguments');
    expect(code('randomInt(a,b)')).toBe('bad-arguments');
  });

  it('makes booleans and alphanumeric runs', () => {
    expect(['true', 'false']).toContain(value('randomBoolean'));
    expect(value('randomAlphaNumeric')).toMatch(/^[a-z0-9]$/);
    expect(value('randomAlphaNumeric(12)')).toMatch(/^[a-z0-9]{12}$/);
    expect(code('randomAlphaNumeric(0)')).toBe('bad-arguments');
  });

  it('makes fake data of the right shape', () => {
    expect(value('firstName')).toMatch(/^[A-Z][a-z]+$/);
    expect(value('fullName')).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(value('email')).toMatch(/^[a-z]+\.[a-z]+@example\.(com|org|net)$/);
    expect(value('userName')).toMatch(/^[a-z]+\.[a-z]+\d{1,2}$/);
    expect(value('phone')).toMatch(/^\+1-555-\d{3}-\d{4}$/);
    expect(value('streetAddress')).toMatch(/^\d+ [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(value('countryCode')).toMatch(/^[A-Z]{2}$/);
    expect(value('company').length).toBeGreaterThan(0);
    expect(value('ip')).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
    expect(value('ipv6')).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/);
    expect(value('mac')).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    expect(value('url')).toMatch(/^https:\/\/[a-z]+\.[a-z]+$/);
    expect(value('domain')).toMatch(/^[a-z]+\.[a-z]+$/);
    expect(value('hexColor')).toMatch(/^#[0-9a-f]{6}$/);
    expect(value('color')).toMatch(/^[a-z]+$/);
    expect(value('currencyCode')).toMatch(/^[A-Z]{3}$/);
    expect(value('price')).toMatch(/^\d+\.\d{2}$/);
    expect(value('fileName')).toMatch(/^[a-z]+\.[a-z0-9]+$/);
    expect(value('mimeType')).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
  });

  it('writes lorem by words, sentences or paragraphs', () => {
    expect(value('lorem(words=5)').split(' ')).toHaveLength(5);
    expect(value('lorem')).toMatch(/^[A-Z][a-z ]+\.$/);
    expect(value('lorem(sentences=3)').match(/\./g)).toHaveLength(3);
    expect(value('lorem(paragraphs=2)').split('\n\n')).toHaveLength(2);
    expect(code('lorem(words=0)')).toBe('bad-arguments');
    expect(code('lorem(words=2,sentences=2)')).toBe('bad-arguments');
    expect(code('lorem(5)')).toBe('bad-arguments');
  });

  it('picks dates inside the window', () => {
    const day = 86_400_000;
    for (let i = 0; i < 20; i++) {
      const past = Date.parse(value('datePast'));
      expect(past <= NOW.getTime() && past >= NOW.getTime() - 365 * day).toBe(true);
      const future = Date.parse(value('dateFuture(days=10)'));
      expect(future >= NOW.getTime() && future <= NOW.getTime() + 10 * day).toBe(true);
      const recent = Date.parse(value('dateRecent'));
      expect(recent <= NOW.getTime() && recent >= NOW.getTime() - day).toBe(true);
    }
    expect(value('datePast')).toMatch(ISO);
  });

  it('honours an alias and the default arguments it carries', () => {
    expect(value('randomFirstName')).toMatch(/^[A-Z][a-z]+$/);
    expect(value('randomLoremWords').split(' ')).toHaveLength(3);
    expect(value('randomLoremWords(words=2)').split(' ')).toHaveLength(2);
    expect(value('randomIPV6')).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/);
  });

  it('refuses unknown names, arguments on a generator that takes none, and bad syntax', () => {
    expect(code('nope')).toBe('missing');
    expect(code('toString')).toBe('missing');
    expect(code('guid(1)')).toBe('bad-arguments');
    expect(code('randomInt(1')).toBe('bad-arguments');
    expect(code('')).toBe('missing');
  });
});

describe('DynamicValues', () => {
  it('gives the same value for the same reference, and a fresh one for another memo', () => {
    const memo = new DynamicValues(NOW);
    const first = memo.resolve('guid');
    expect(memo.resolve('guid')).toEqual(first);
    expect(memo.resolve('uuid')).toEqual(first);
    expect(memo.resolve(' guid ')).toEqual(first);
    expect(new DynamicValues(NOW).resolve('guid')).not.toEqual(first);
  });

  it('keys by arguments too', () => {
    const memo = new DynamicValues(NOW);
    expect(memo.resolve('isoTimestamp(+1d)')).not.toEqual(memo.resolve('isoTimestamp'));
    expect(memo.resolve('randomInt( 1 , 2 )')).toEqual(memo.resolve('randomInt(1,2)'));
    expect(memo.resolve('randomLoremWords')).toEqual(memo.resolve('lorem(words=3)'));
  });
});

describe('the catalogue', () => {
  it('lists every generator the issue names, each with a description', () => {
    const names = DYNAMIC_GENERATORS.map((g) => g.name);
    for (const required of [
      'guid',
      'timestamp',
      'isoTimestamp',
      'randomInt',
      'randomBoolean',
      'randomAlphaNumeric',
      'firstName',
      'email',
      'streetAddress',
      'phone',
      'company',
      'lorem',
      'datePast',
      'dateFuture',
      'dateRecent',
      'ip',
      'ipv6',
      'mac',
      'url',
      'domain',
      'color',
      'currencyCode',
      'fileName',
      'mimeType',
    ]) {
      expect(names).toContain(required);
    }
    for (const generator of DYNAMIC_GENERATORS) expect(generator.description.length).toBeGreaterThan(0);
  });

  it('recognises names and aliases, without arguments', () => {
    expect(isDynamicName('guid')).toBe(true);
    expect(isDynamicName('randomFirstName')).toBe(true);
    expect(isDynamicName('randomInt(1,2)')).toBe(false);
    expect(isDynamicName('processEnv')).toBe(false);
    expect(isDynamicName('toString')).toBe(false);
  });
});
