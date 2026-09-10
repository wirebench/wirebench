// @vitest-environment node
import type { EndpointAuth } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { effectiveAuth } from '../src/main/project-auth.js';

const basic: EndpointAuth = { type: 'basic', username: 'a' };
const none: EndpointAuth = { type: 'none' };

describe('effectiveAuth', () => {
  it('prefers request auth over endpoint and interface auth', () => {
    expect(effectiveAuth(basic, none, none)).toBe(basic);
  });

  it('falls back to endpoint auth when the request has none', () => {
    expect(effectiveAuth(undefined, basic, none)).toBe(basic);
  });

  it('falls back to interface auth when neither request nor endpoint has any', () => {
    expect(effectiveAuth(undefined, undefined, basic)).toBe(basic);
  });

  it('returns undefined when nothing configures auth at any level', () => {
    expect(effectiveAuth(undefined, undefined, undefined)).toBeUndefined();
  });

  it('an explicit type: none at a more specific level wins over a less specific one', () => {
    expect(effectiveAuth(none, basic, basic)).toBe(none);
  });
});
