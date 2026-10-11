// packages/engine/test/unit/import/templates.test.ts
import { describe, expect, it } from 'vitest';
import { rewriteMustache } from '../../../src/import/templates.js';

describe('rewriteMustache', () => {
  it('turns {{name}} into ${name}, trimming inner spaces', () => {
    expect(rewriteMustache('{{ baseUrl }}/v1/{{id}}')).toBe('${baseUrl}/v1/${id}');
  });

  it('escapes a literal ${ so it is not read as a property', () => {
    expect(rewriteMustache('cost: ${x} and {{y}}')).toBe('cost: $${x} and ${y}');
  });

  it('maps a known dynamic {{$…}} variable onto the Dynamic scope, aliases included', () => {
    const seen = new Set<string>();
    expect(rewriteMustache('id={{$guid}}&t={{ $timestamp }}&n={{$randomFirstName}}', seen)).toBe(
      'id=${$guid}&t=${$timestamp}&n=${$randomFirstName}',
    );
    expect([...seen]).toEqual([]);
  });

  it('maps the argument forms request files use', () => {
    expect(rewriteMustache('{{$randomInt 1 100}} {{$randomInt -5 5}} {{$datetime iso8601}}')).toBe(
      '${$randomInt(1,100)} ${$randomInt(-5,5)} ${$isoTimestamp}',
    );
  });

  it('leaves an unknown dynamic variable as written and records it', () => {
    const seen = new Set<string>();
    expect(rewriteMustache('{{$processEnv HOME}} {{$nope}} {{$datetime rfc1123}}', seen)).toBe(
      '{{$processEnv HOME}} {{$nope}} {{$datetime rfc1123}}',
    );
    expect([...seen]).toEqual(['$processEnv HOME', '$nope', '$datetime rfc1123']);
  });

  it('leaves an empty {{}} alone', () => {
    expect(rewriteMustache('a{{}}b')).toBe('a{{}}b');
  });
});

describe('rewriteMustache, hostile input', () => {
  it('rewrites a long space run inside braces in linear time', () => {
    const run = ' '.repeat(100_000);
    const started = performance.now();
    rewriteMustache(`{{${run}x y`);
    expect(rewriteMustache(`{{${run}a${run}}}`)).toBe('${a}');
    expect(performance.now() - started).toBeLessThan(200);
  });
});
