import { describe, expect, it } from 'vitest';
import { SETTINGS_NAV } from '../../src/renderer/features/preferences/settings-model.js';

describe('SETTINGS_NAV (settings split spec §2)', () => {
  it('groups App settings as General, Protocols, Network and tools, This computer, Account', () => {
    expect(SETTINGS_NAV.map((group) => [group.title, group.sections.map((section) => section.id)])).toEqual([
      ['General', ['appearance', 'behaviour', 'features', 'plugins', 'shortcuts', 'updates']],
      ['Protocols', ['http', 'rest', 'wsdl', 'wsi']],
      ['Network and tools', ['proxy', 'ssl', 'git', 'mocks', 'terminal', 'ssh', 'secrets']],
      ['This computer', ['this-machine', 'paired-browsers']],
      ['Account', ['accounts', 'tokens']],
    ]);
  });
});
