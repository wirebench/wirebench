// @vitest-environment node
import type { EndpointAuth } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { effectiveAuth } from '../src/main/project-auth.js';

const basic: EndpointAuth = { type: 'basic', username: 'a' };
const none: EndpointAuth = { type: 'none' };

describe('effectiveAuth', () => {
  it('prefers request auth over the interface fallback', () => {
    expect(effectiveAuth(basic, undefined, 'override', none)).toBe(basic);
  });

  it('falls back to endpoint auth when the request has none', () => {
    expect(effectiveAuth(undefined, basic, 'override', none)).toBe(basic);
  });

  it('falls back to interface auth when neither request nor endpoint has any', () => {
    expect(effectiveAuth(undefined, undefined, 'override', basic)).toBe(basic);
  });

  it('returns undefined when nothing configures auth at any level', () => {
    expect(effectiveAuth(undefined, undefined, 'override', undefined)).toBeUndefined();
  });

  it('an explicit type: none on the request wins over the interface fallback', () => {
    expect(effectiveAuth(none, undefined, 'complement', basic)).toBe(none);
  });
});

describe('effectiveAuth — endpoint auth mode', () => {
  it('override lets the endpoint replace the request credentials', () => {
    expect(effectiveAuth(basic, none, 'override')).toBe(none);
  });

  it('complement only fills the blanks the request left', () => {
    expect(effectiveAuth({ type: 'basic', username: 'a' }, { type: 'basic', passwordRef: 'r' }, 'complement')).toEqual({
      type: 'basic',
      username: 'a',
      passwordRef: 'r',
    });
  });
});
