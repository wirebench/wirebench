import { describe, expect, it } from 'vitest';
import { flattenValue, ScriptCollector } from '../../../src/import/client-import.js';
import { ReportBuilder } from '../../../src/import/report.js';

describe('ScriptCollector', () => {
  it('saves pre, post and tests under the API slug', () => {
    const report = new ReportBuilder();
    const scripts = new ScriptCollector('orders', report);
    scripts.add('create', 'pre', 'a();', 'Create');
    scripts.add('create', 'post', 'b();', 'Create');
    scripts.add('create', 'tests', 'c();', 'Create');
    expect(scripts.files()).toEqual([
      { path: 'imported-scripts/orders/create.pre.js', source: 'a();' },
      { path: 'imported-scripts/orders/create.post.js', source: 'b();' },
      { path: 'imported-scripts/orders/create.tests.js', source: 'c();' },
    ]);
    expect(report.build().notes).toContain(
      'Create: its pre-request script was saved to imported-scripts/orders/create.pre.js and is never run.',
    );
  });

  it('numbers a repeated item slug', () => {
    const scripts = new ScriptCollector('api', new ReportBuilder());
    scripts.add('get', 'pre', 'a();', 'Get');
    scripts.add('get', 'pre', 'b();', 'Get');
    expect(scripts.files().map((file) => file.path)).toEqual([
      'imported-scripts/api/get.pre.js',
      'imported-scripts/api/get-2.pre.js',
    ]);
  });

  it('ignores blank source', () => {
    const scripts = new ScriptCollector('api', new ReportBuilder());
    scripts.add('get', 'pre', '  \n', 'Get');
    expect(scripts.files()).toEqual([]);
  });

  it('reportDialects names each dialect once', () => {
    const report = new ReportBuilder();
    const scripts = new ScriptCollector('api', report);
    scripts.add('a', 'pre', 'insomnia.environment.get("x"); insomnia.test()', 'A');
    scripts.add('b', 'post', 'pm.test("ok"); hopp.env.get("y")', 'B');
    scripts.reportDialects();
    expect(report.build().warnings).toEqual([
      'The saved scripts call pm., insomnia., hopp.; Wirebench does not run them. Port what they do to Wirebench scripts by hand.',
    ]);
  });
});

describe('flattenValue', () => {
  it('flattens nested objects and arrays', () => {
    expect(flattenValue('v', { db: { host: 'x', port: 5432 }, ids: [1, true], none: null })).toEqual([
      ['v.db.host', 'x'],
      ['v.db.port', '5432'],
      ['v.ids.0', '1'],
      ['v.ids.1', 'true'],
      ['v.none', ''],
    ]);
  });

  it('keeps a string as it is, and an empty container as its JSON', () => {
    expect(flattenValue('name', 'a {{b}}')).toEqual([['name', 'a {{b}}']]);
    expect(flattenValue('empty', {})).toEqual([['empty', '{}']]);
    expect(flattenValue('list', [])).toEqual([['list', '[]']]);
  });
});
