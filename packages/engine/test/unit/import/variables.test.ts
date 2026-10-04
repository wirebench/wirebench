import { describe, expect, it } from 'vitest';
import { formatImportReport, ReportBuilder, uniqueName } from '../../../src/import/report.js';
import { importedScriptPath } from '../../../src/import/scripts.js';
import { credentialLookingNames, VariableSetBuilder } from '../../../src/import/variables.js';

const plain = (name: string, value = 'v') => ({ name, value, enabled: true, secret: false });

describe('uniqueName', () => {
  it('numbers a taken name, ignoring case', () => {
    expect(uniqueName('Staging', ['staging'])).toBe('Staging 2');
    expect(uniqueName('Staging', ['Staging', 'Staging 2'])).toBe('Staging 3');
    expect(uniqueName('Prod', ['Staging'])).toBe('Prod');
  });
});

describe('VariableSetBuilder', () => {
  it('keeps the first definition of a name and notes the repeat', () => {
    const report = new ReportBuilder();
    const set = new VariableSetBuilder('Staging', report);
    set.add(plain('host', 'a'));
    set.add(plain('host', 'b'), 'folder "Users"');
    expect(set.build()).toEqual({ name: 'Staging', variables: [plain('host', 'a')] });
    expect(set.size).toBe(1);
    expect(report.build().notes).toEqual([
      'Staging: "host" is defined more than once (folder "Users"); the first value was kept.',
    ]);
  });
});

describe('credentialLookingNames', () => {
  it('lists plain variables whose names look like credentials, never secrets', () => {
    const sets = [{ name: 'e', variables: [plain('apiToken'), plain('host'), { ...plain('password'), secret: true }] }];
    expect(credentialLookingNames(sets)).toEqual(['apiToken']);
  });
});

describe('formatImportReport', () => {
  it('writes warnings first, then notes', () => {
    expect(formatImportReport({ warnings: ['w'], notes: ['n'] })).toBe('Warning: w\nNote: n');
  });
});

describe('importedScriptPath', () => {
  it('places scripts under imported-scripts and numbers a repeat', () => {
    const taken = new Set<string>();
    expect(importedScriptPath('pets', 'get-user', 'tests.js', taken)).toBe('imported-scripts/pets/get-user.tests.js');
    expect(importedScriptPath('pets', 'get-user', 'tests.js', taken)).toBe('imported-scripts/pets/get-user-2.tests.js');
  });
});
