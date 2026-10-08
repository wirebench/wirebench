// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { enabledAreasFromEnv, parseAreaSwitches } from '../src/main/areas.js';

describe('WIREBENCH_AREAS', () => {
  it('parses id=off and id=on pairs, ignoring blanks and case', () => {
    expect(parseAreaSwitches('ssh=off, wss=OFF ,history=on')).toEqual({ ssh: false, wss: false, history: true });
  });
  it('is empty when unset or malformed', () => {
    expect(parseAreaSwitches(undefined)).toEqual({});
    expect(parseAreaSwitches('ssh')).toEqual({});
    expect(parseAreaSwitches('ssh=maybe')).toEqual({});
  });
  it('enabledAreasFromEnv drops the switched-off area', () => {
    expect(enabledAreasFromEnv({ WIREBENCH_AREAS: 'wss=off' })).toEqual([
      'explorer',
      'environments',
      'search',
      'history',
      'ssh',
    ]);
  });
});
