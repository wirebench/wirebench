/**
 * `${$` completion in the body editors (#333): it opens only inside a dynamic reference being typed,
 * and offers every generator with what accepting it writes.
 */
import { describe, expect, it } from 'vitest';
import { buildDynamicCompletionItems, dynamicCompletionContext } from '../../src/renderer/editor/dynamic-completion.js';

describe('dynamicCompletionContext', () => {
  it('opens after ${$ and after ${#Dynamic#, with what is typed so far', () => {
    expect(dynamicCompletionContext('<a>${$')).toEqual({ prefix: '', start: 6 });
    expect(dynamicCompletionContext('id=${$gu')).toEqual({ prefix: 'gu', start: 6 });
    expect(dynamicCompletionContext('${#Dynamic#iso')).toEqual({ prefix: 'iso', start: 11 });
  });

  it('stays shut elsewhere', () => {
    expect(dynamicCompletionContext('$guid')).toBeUndefined();
    expect(dynamicCompletionContext('${guid')).toBeUndefined();
    expect(dynamicCompletionContext('${$guid}')).toBeUndefined();
    expect(dynamicCompletionContext('$${$gu')).toBeUndefined();
    expect(dynamicCompletionContext('${$randomInt(1,')).toBeUndefined();
  });
});

describe('buildDynamicCompletionItems', () => {
  it('lists every generator, closing the reference unless a } follows', () => {
    const items = buildDynamicCompletionItems(false);
    const guid = items.find((item) => item.label === 'guid');
    expect(guid).toMatchObject({ insertText: 'guid}', detail: 'A random UUID (version 4)' });
    expect(guid?.documentation).toContain('uuid');
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(['isoTimestamp', 'lorem', 'email']));
    expect(buildDynamicCompletionItems(true).find((item) => item.label === 'guid')?.insertText).toBe('guid');
  });

  it('names the arguments a generator takes', () => {
    const randomInt = buildDynamicCompletionItems(false).find((item) => item.label === 'randomInt');
    expect(randomInt?.documentation).toContain('min,max');
  });
});
