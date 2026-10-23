import { describe, expect, it } from 'vitest';
import * as plugin from '../../src/plugin.js';

describe('@wirebench/engine/plugin', () => {
  it('exports its version and nothing else at run time', () => {
    expect(Object.keys(plugin)).toEqual(['PLUGIN_API_VERSION']);
    expect(plugin.PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
