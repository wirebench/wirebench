import { describe, expect, it } from 'vitest';
import { prettyFrameText } from '../../../src/ws/pretty.js';

describe('prettyFrameText', () => {
  it('indents JSON', () =>
    expect(prettyFrameText('{"a":[1,2]}')).toEqual({ language: 'json', pretty: '{\n  "a": [\n    1,\n    2\n  ]\n}' }));
  it('leaves a bare number or word as text', () => {
    expect(prettyFrameText('42').language).toBe('text');
    expect(prettyFrameText('ping').language).toBe('text');
  });
  it('recognises XML', () => expect(prettyFrameText('<a><b>1</b></a>').language).toBe('xml'));
  it('returns broken JSON untouched', () =>
    expect(prettyFrameText('{"a":')).toEqual({ language: 'text', pretty: '{"a":' }));
});
