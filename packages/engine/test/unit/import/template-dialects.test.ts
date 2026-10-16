import { describe, expect, it } from 'vitest';
import {
  brunoTemplates,
  hoppscotchTemplates,
  insomniaTemplates,
  thunderTemplates,
} from '../../../src/import/template-dialects.js';
import { rewriteMustache } from '../../../src/import/templates.js';

describe('insomniaTemplates', () => {
  it('rewrites variable references', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ _.base }}/x', kept)).toBe('{{base}}/x');
    expect(insomniaTemplates("{{ _['my-key'] }}", kept)).toBe('{{my-key}}');
    expect(insomniaTemplates('{{ _.db.host }}', kept)).toBe('{{db.host}}');
    expect(insomniaTemplates('{{ _.users[0].id }}', kept)).toBe('{{users.0.id}}');
    expect(insomniaTemplates('{{ base }}', kept)).toBe('{{base}}');
    expect(insomniaTemplates('{{ _.vault.tok }}', kept)).toBe('{{tok}}');
    expect(kept.size).toBe(0);
  });

  it('maps the generator tags it can and keeps the rest', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates("{% uuid 'v4' %}", kept)).toBe('{{$guid}}');
    expect(insomniaTemplates("{% now 'iso-8601' %}", kept)).toBe('{{$isoTimestamp}}');
    expect(insomniaTemplates("{% now 'unix' %}", kept)).toBe('{{$timestamp}}');
    expect(insomniaTemplates('{% uuid %}', kept)).toBe('{{$guid}}');
    expect([...kept]).toEqual([]);
    expect(insomniaTemplates("{% now 'millis' %}", kept)).toBe("{% now 'millis' %}");
    expect(kept).toContain('now');
    const tag = "{% response 'body', 'req_1', 'b64::JC5h::46b', 'never', 60 %}";
    expect(insomniaTemplates(tag, kept)).toBe(tag);
    expect([...kept]).toEqual(['now', 'response']);
  });

  it('keeps a filter as written', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ _.base | upcase }}', kept)).toBe('{{ _.base | upcase }}');
    expect([...kept]).toEqual(['filter']);
  });

  it('keeps scanning after a rejected span', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ x {{ _.base }}', kept)).toBe('{{ x {{base}}');
    expect(insomniaTemplates('{{ {{ _.base }}', kept)).toBe('{{ {{base}}');
  });

  it('keeps a key with whitespace', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates("{{ _['my key'] }}", kept)).toBe("{{ _['my key'] }}");
    expect([...kept]).toEqual(["_['my key']"]);
  });

  it('feeds rewriteMustache', () => {
    const kept = new Set<string>();
    expect(rewriteMustache(insomniaTemplates('{{ _.base }}/{% uuid "v4" %}', kept))).toBe('${base}/${$guid}');
  });

  it('returns promptly on a long run of braces', () => {
    const start = performance.now();
    insomniaTemplates('{'.repeat(1_000_000), new Set());
    insomniaTemplates('{%'.repeat(500_000), new Set());
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('timestamp dialects through rewriteMustache', () => {
  it.each([
    ["{% now 'iso-8601' %}", '${$isoTimestamp}', insomniaTemplates],
    ["{% now 'unix' %}", '${$timestamp}', insomniaTemplates],
    ['{{#dateISO}}', '${$isoTimestamp}', thunderTemplates],
    ['{{#timestamp}}', '${$timestamp}', thunderTemplates],
  ] as const)('%s becomes %s', (input, expected, dialect) => {
    expect(rewriteMustache(dialect(input, new Set()))).toBe(expected);
  });
});

describe('hoppscotchTemplates', () => {
  it('rewrites angle references', () => {
    expect(hoppscotchTemplates('<<base>>/a/<<$guid>>', new Set())).toBe('{{base}}/a/{{$guid}}');
    expect(hoppscotchTemplates('a << b', new Set())).toBe('a << b');
  });

  it('keeps scanning after a rejected span', () => {
    expect(hoppscotchTemplates('1 << 2 and <<base>>', new Set())).toBe('1 << 2 and {{base}}');
  });

  it('keeps a name with whitespace', () => {
    const kept = new Set<string>();
    expect(hoppscotchTemplates('<<a b>>', kept)).toBe('<<a b>>');
    expect([...kept]).toEqual(['a b']);
  });

  it('feeds rewriteMustache', () => {
    expect(rewriteMustache(hoppscotchTemplates('<<base>>/<<$guid>>', new Set()))).toBe('${base}/${$guid}');
  });

  it('returns promptly on a long run of angles', () => {
    const start = performance.now();
    hoppscotchTemplates('<'.repeat(1_000_000), new Set());
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('thunderTemplates', () => {
  it('maps the # generators and keeps the rest', () => {
    const kept = new Set<string>();
    expect(thunderTemplates('{{#guid}}', kept)).toBe('{{$guid}}');
    expect(thunderTemplates('{{#timestamp}}', kept)).toBe('{{$timestamp}}');
    expect(thunderTemplates('{{base}}', kept)).toBe('{{base}}');
    expect(thunderTemplates('{{#dateISO}}', kept)).toBe('{{$isoTimestamp}}');
    expect([...kept]).toEqual([]);
    expect(thunderTemplates('{{tok | upper}}', kept)).toBe('{{tok | upper}}');
    expect(thunderTemplates('{{#random}}', kept)).toBe('{{#random}}');
    expect([...kept]).toEqual(['tok | upper', '#random']);
  });

  it('keeps a generator call with arguments whole', () => {
    const kept = new Set<string>();
    expect(thunderTemplates('{{#number, 1, 5}}', kept)).toBe('{{#number, 1, 5}}');
    expect(thunderTemplates('a{{#date, {year: -1}}}b{{base}}', kept)).toBe('a{{#date, {year: -1}}}b{{base}}');
    expect([...kept]).toEqual(['#number, 1, 5', '#date, {year: -1}']);
  });

  it('keeps scanning after an unclosed open', () => {
    expect(thunderTemplates('{{ x {{#guid}}', new Set())).toBe('{{ x {{$guid}}');
    expect(thunderTemplates('{{#date, {{#guid}}', new Set())).toBe('{{#date, {{$guid}}');
  });

  it('feeds rewriteMustache', () => {
    expect(rewriteMustache(thunderTemplates('{{base}}/{{#guid}}', new Set()))).toBe('${base}/${$guid}');
  });

  it('returns promptly on a long run of braces', () => {
    const start = performance.now();
    thunderTemplates('{'.repeat(1_000_000), new Set());
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('brunoTemplates', () => {
  it('maps process.env and keeps prompts', () => {
    const kept = new Set<string>();
    expect(brunoTemplates('{{process.env.TOKEN}}', kept)).toBe('{{#System#TOKEN}}');
    expect(brunoTemplates('{{base}}', kept)).toBe('{{base}}');
    expect([...kept]).toEqual([]);
    expect(brunoTemplates('{{?Ask me}}', kept)).toBe('{{?Ask me}}');
    expect([...kept]).toEqual(['?Ask me']);
  });

  it('keeps scanning after an unclosed open', () => {
    expect(brunoTemplates('{{ x {{process.env.T}}', new Set())).toBe('{{ x {{#System#T}}');
  });

  it('feeds rewriteMustache', () => {
    expect(rewriteMustache(brunoTemplates('{{process.env.TOKEN}}/{{$guid}}', new Set()))).toBe(
      '${#System#TOKEN}/${$guid}',
    );
  });

  it('returns promptly on a long run of braces', () => {
    const start = performance.now();
    brunoTemplates('{'.repeat(1_000_000), new Set());
    expect(performance.now() - start).toBeLessThan(50);
  });
});
