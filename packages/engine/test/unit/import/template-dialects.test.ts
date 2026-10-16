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
    expect(kept.size).toBe(0);
    expect(insomniaTemplates("{% now 'millis' %}", kept)).toBe("{% now 'millis' %}");
    expect(kept).toContain('now');
    const tag = "{% response 'body', 'req_1', 'b64::JC5h::46b', 'never', 60 %}";
    expect(insomniaTemplates(tag, kept)).toContain('{% response');
    expect(kept).toContain('response');
  });

  it('keeps a filter as written', () => {
    const kept = new Set<string>();
    expect(insomniaTemplates('{{ _.base | upcase }}', kept)).toBe('{{ _.base | upcase }}');
    expect(kept.size).toBe(1);
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

describe('hoppscotchTemplates', () => {
  it('rewrites angle references', () => {
    expect(hoppscotchTemplates('<<base>>/a/<<$guid>>')).toBe('{{base}}/a/{{$guid}}');
    expect(hoppscotchTemplates('a << b')).toBe('a << b');
  });

  it('feeds rewriteMustache', () => {
    expect(rewriteMustache(hoppscotchTemplates('<<base>>/<<$guid>>'))).toBe('${base}/${$guid}');
  });

  it('returns promptly on a long run of angles', () => {
    const start = performance.now();
    hoppscotchTemplates('<'.repeat(1_000_000));
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('thunderTemplates', () => {
  it('maps the # generators and keeps the rest', () => {
    const kept = new Set<string>();
    expect(thunderTemplates('{{#guid}}', kept)).toBe('{{$guid}}');
    expect(thunderTemplates('{{#timestamp}}', kept)).toBe('{{$timestamp}}');
    expect(thunderTemplates('{{base}}', kept)).toBe('{{base}}');
    expect(kept.size).toBe(0);
    expect(thunderTemplates('{{tok | upper}}', kept)).toBe('{{tok | upper}}');
    expect(thunderTemplates('{{#random}}', kept)).toBe('{{#random}}');
    expect(kept.size).toBe(2);
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
    expect(kept.size).toBe(0);
    expect(brunoTemplates('{{?Ask me}}', kept)).toBe('{{?Ask me}}');
    expect(kept.size).toBe(1);
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
