import { describe, expect, it } from 'vitest';
import { ReportBuilder, ScriptCollector, flattenValue } from '../../../src/import/index.js';

describe('ScriptCollector', () => {
  it('saves pre, post and tests under the API slug', () => {
    const c = new ScriptCollector('shop', new ReportBuilder());
    c.add('login', 'pre', 'a()', 'Login');
    c.add('login', 'post', 'b()', 'Login');
    c.add('login', 'tests', 'c()', 'Login');
    expect(c.files().map((f) => f.path)).toEqual([
      'imported-scripts/shop/login.pre.js',
      'imported-scripts/shop/login.post.js',
      'imported-scripts/shop/login.tests.js',
    ]);
  });

  it('numbers a repeated item slug', () => {
    const c = new ScriptCollector('shop', new ReportBuilder());
    c.add('Get-Item', 'pre', 'a()', 'x');
    c.add('Get-Item', 'pre', 'b()', 'y');
    expect(c.files().map((f) => f.path)).toEqual([
      'imported-scripts/shop/get-item.pre.js',
      'imported-scripts/shop/get-item-2.pre.js',
    ]);
  });

  it('ignores blank source', () => {
    const c = new ScriptCollector('shop', new ReportBuilder());
    c.add('a', 'pre', '  \n', 'A');
    expect(c.files()).toEqual([]);
  });

  it('reportDialects names each dialect once', () => {
    const report = new ReportBuilder();
    const c = new ScriptCollector('shop', report);
    c.add('a', 'pre', 'pm.test(1); pm.x()', 'A');
    c.add('b', 'post', 'insomnia.env.get("x"); notpm.foo(); bru.setVar()', 'B');
    c.reportDialects();
    const warnings = report.build().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pm.');
    expect(warnings[0]).toContain('insomnia.');
    expect(warnings[0]).toContain('bru.');
    expect(warnings[0]).not.toContain('pw.');
    expect(warnings[0]?.split('pm.').length).toBe(2);
  });
});

describe('flattenValue', () => {
  it('flattens nested objects and arrays', () => {
    expect(flattenValue('cfg', { db: { host: 'x' }, ids: [1], on: true, none: null })).toEqual([
      ['cfg.db.host', 'x'],
      ['cfg.ids.0', '1'],
      ['cfg.on', 'true'],
      ['cfg.none', ''],
    ]);
  });

  it('keeps a string as it is', () => {
    expect(flattenValue('k', 'v')).toEqual([['k', 'v']]);
  });
});
