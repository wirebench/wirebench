import { describe, expect, it } from 'vitest';
import {
  brunoTemplates,
  hoppscotchTemplates,
  insomniaTemplates,
  thunderTemplates,
  unshieldTemplates,
  unshieldText,
} from '../../../src/import/template-dialects.js';
import { rewriteMustache } from '../../../src/import/templates.js';

/** What a value becomes after the dialect, the shared rewrite and the unshield step. */
function through(dialect: (text: string) => string, text: string): string {
  return unshieldText(rewriteMustache(dialect(text)));
}

describe('insomniaTemplates', () => {
  it('rewrites the variable forms to {{name}}', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ _.base }}/x', kept)).toBe('{{base}}/x');
    expect(insomniaTemplates("{{ _['my-key'] }}", kept)).toBe('{{my-key}}');
    expect(insomniaTemplates('{{ _.db.host }}', kept)).toBe('{{db.host}}');
    expect(insomniaTemplates('{{ _.users[0].id }}', kept)).toBe('{{users.0.id}}');
    expect(insomniaTemplates('{{ base }}', kept)).toBe('{{base}}');
    expect(insomniaTemplates('{{base}}', kept)).toBe('{{base}}');
    expect(kept.size).toBe(0);
  });

  it('maps uuid and now tags to dynamic names and keeps the others', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates("{% uuid 'v4' %}", kept)).toBe('{{$guid}}');
    expect(insomniaTemplates("{% now 'iso-8601' %}", kept)).toBe('{{$isoTimestamp}}');
    expect(insomniaTemplates("{% now 'unix' %}", kept)).toBe('{{$timestamp}}');
    expect(insomniaTemplates("{% now 'millis' %}", kept)).toBe("{% now 'millis' %}");
    const chained = "{% response 'body', 'req_1', 'b64::JC5h::46b', 'never', 60 %}";
    expect(insomniaTemplates(chained, kept)).toBe(chained);
    expect([...kept]).toEqual(['now', 'response']);
  });

  it('names a block tag once, by its opening tag', () => {
    const kept = new Set<string>();
    insomniaTemplates('{% if _.a %}x{% endif %}', kept);
    expect([...kept]).toEqual(['if']);
  });

  it('points a vault reference at its secret only when the vault variable became one', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ _.vault.tok }}', kept, new Set(['tok']))).toBe('{{tok}}');
    expect(through((t) => insomniaTemplates(t, kept), '{{ _.vault.other }}')).toBe('{{ _.vault.other }}');
    expect(kept).toContain('{{ _.vault.other }}');
  });

  it('keeps a filter as written, never as a reference', () => {
    const kept = new Set<string>();
    expect(through((t) => insomniaTemplates(t, kept), '{{ _.base | upcase }}/x')).toBe('{{ _.base | upcase }}/x');
    expect(kept).toContain('{{ _.base | upcase }}');
  });

  it('ends in ${name} after the shared rewrite', () => {
    expect(through((t) => insomniaTemplates(t, new Set()), '{{ _.base }}/{{ _.db.host }}')).toBe('${base}/${db.host}');
    expect(through((t) => insomniaTemplates(t, new Set()), "{% uuid 'v4' %}")).toBe('${$guid}');
  });
});

describe('insomniaTemplates: names with whitespace', () => {
  it('keeps a key with whitespace as written and reports it', () => {
    const kept = new Set<string>();
    expect(through((t) => insomniaTemplates(t, kept), "{{ _['my key'] }}")).toBe("{{ _['my key'] }}");
    expect([...kept]).toEqual(["{{ _['my key'] }}"]);
  });

  it('still maps a key with a hyphen', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates("{{ _['my-key'] }}", kept)).toBe('{{my-key}}');
    expect(kept.size).toBe(0);
  });
});

describe('hoppscotchTemplates', () => {
  it('rewrites <<name>> and predefined names', () => {
    expect(hoppscotchTemplates('<<base>>/a/<<$guid>>')).toBe('{{base}}/a/{{$guid}}');
    expect(hoppscotchTemplates('a << b >> c')).toBe('a << b >> c');
    expect(through(hoppscotchTemplates, '<<base>>/x')).toBe('${base}/x');
  });

  it('keeps a name with whitespace as written and reports it, but not a spaced-out << >>', () => {
    const kept = new Set<string>();
    expect(hoppscotchTemplates('<<a b>>/<<base>>', kept)).toBe('<<a b>>/{{base}}');
    expect(hoppscotchTemplates('a << b >> c', kept)).toBe('a << b >> c');
    expect([...kept]).toEqual(['<<a b>>']);
  });
});

describe('thunderTemplates', () => {
  it('maps the system variables a generator fits', () => {
    const kept = new Set<string>();
    expect(thunderTemplates('{{#guid}}', kept)).toBe('{{$guid}}');
    expect(thunderTemplates('{{#number, 1, 5}}', kept)).toBe('{{$randomInt 1 5}}');
    expect(thunderTemplates("{{#date, 'X'}}", kept)).toBe('{{$timestamp}}');
    expect(thunderTemplates('{{#dateISO}}', kept)).toBe('{{$isoTimestamp}}');
    expect(thunderTemplates('{{#timestamp}}', kept)).toBe('{{$timestamp}}');
    expect(through((t) => thunderTemplates(t, kept), '{{#guid}}')).toBe('${$guid}');
    expect(kept.size).toBe(0);
  });

  it('keeps the others and filters as written', () => {
    const kept = new Set<string>();
    expect(through((t) => thunderTemplates(t, kept), '{{tok | upper}}')).toBe('{{tok | upper}}');
    expect(through((t) => thunderTemplates(t, kept), '{{#date, {year: -1}}}')).toBe('{{#date, {year: -1}}}');
    expect(through((t) => thunderTemplates(t, kept), '{{#date}}')).toBe('{{#date}}');
    expect(kept).toContain('{{tok | upper}}');
    expect(kept).toContain('{{#date}}');
  });

  it('keeps scanning after a # call that never closes', () => {
    const kept = new Set<string>();
    expect(thunderTemplates('{{#date, {{#guid}}', kept)).toBe('{{#date, {{$guid}}');
    expect(thunderTemplates('{{ x {{#guid}}', kept)).toBe('{{ x {{$guid}}');
    expect(kept.size).toBe(0);
  });

  it('reports a # call with an object argument whole, closing on balanced braces', () => {
    const kept = new Set<string>();
    expect(through((t) => thunderTemplates(t, kept), 'a{{#date, {year: -1}}}b{{base}}')).toBe(
      'a{{#date, {year: -1}}}b${base}',
    );
    expect([...kept]).toEqual(['{{#date, {year: -1}}}']);
  });

  it('leaves a plain variable for the shared rewrite', () => {
    expect(through((t) => thunderTemplates(t, new Set()), '{{base}}/x')).toBe('${base}/x');
  });
});

describe('brunoTemplates', () => {
  it('turns process.env into the System scope', () => {
    const kept = new Set<string>();
    expect(through((t) => brunoTemplates(t, kept), '{{process.env.TOKEN}}')).toBe('${#System#TOKEN}');
    expect(kept.size).toBe(0);
  });

  it('keeps a prompt as written', () => {
    const kept = new Set<string>();
    expect(through((t) => brunoTemplates(t, kept), '{{?Ask me}}')).toBe('{{?Ask me}}');
    expect(kept).toContain('{{?Ask me}}');
  });
});

describe('unshieldTemplates', () => {
  it('restores every string in arrays and plain objects', () => {
    const kept = new Set<string>();
    const shielded = thunderTemplates('{{a | b}}', kept);
    expect(shielded).not.toBe('{{a | b}}');
    expect(unshieldTemplates({ list: [shielded, 1], nested: { text: shielded } })).toEqual({
      list: ['{{a | b}}', 1],
      nested: { text: '{{a | b}}' },
    });
  });
});

describe('hostile input', () => {
  // A backtracking pattern on these inputs runs for seconds or never ends; the linear one takes about a
  // tenth of a second, and several times that under coverage instrumentation. The limit sits between.
  const LIMIT_MS = 2_000;

  it('a long run of unclosed # calls returns quickly (thunder)', () => {
    const started = performance.now();
    thunderTemplates(`${'{{#'.repeat(300_000)}}}}`, new Set());
    thunderTemplates(`${'{{#{'.repeat(250_000)}}}}`, new Set());
    thunderTemplates(`${'{{#date, {'.repeat(100_000)}}}}`, new Set());
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  it('a long run of << with spaced names returns quickly (hoppscotch)', () => {
    const started = performance.now();
    hoppscotchTemplates(`${'<<a b'.repeat(200_000)}>>`, new Set());
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  const run = '{'.repeat(1024 * 1024);
  const cases: [string, (text: string) => string][] = [
    ['insomnia', (t) => insomniaTemplates(t, new Set())],
    ['hoppscotch', hoppscotchTemplates],
    ['thunder', (t) => thunderTemplates(t, new Set())],
    ['bruno', (t) => brunoTemplates(t, new Set())],
  ];
  for (const [name, dialect] of cases) {
    it(`a 1 MB run of '{' returns quickly (${name})`, () => {
      const started = performance.now();
      dialect(run);
      dialect(`${run}}}`);
      dialect('<'.repeat(1024 * 1024) + '>>');
      expect(performance.now() - started).toBeLessThan(LIMIT_MS);
    });
  }
});
