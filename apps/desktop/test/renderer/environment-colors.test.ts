import { describe, expect, it } from 'vitest';
import { environmentColorCss, isEnvironmentColor } from '@wirebench/wire/environment-colors';

describe('environment colours', () => {
  it('draws a palette name with its theme token and a #rrggbb as written', () => {
    expect(environmentColorCss('red')).toBe('var(--wb-env-red)');
    expect(environmentColorCss('#12AB9F')).toBe('#12AB9F');
  });

  it('draws nothing for no colour or one it does not know', () => {
    expect(environmentColorCss(undefined)).toBeUndefined();
    expect(environmentColorCss('chartreuse')).toBeUndefined();
    expect(isEnvironmentColor('chartreuse')).toBe(false);
  });
});
