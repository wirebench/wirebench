import { describe, expect, it } from 'vitest';
import { declaredVersion, moduleReferences, renderReport, reportProblem } from './plugin-api-report.ts';

const source = (version: string, body = 'export interface A { readonly a: string; }'): string =>
  `export const PLUGIN_API_VERSION = '${version}';\n${body}\n`;

describe('the plugin API report', () => {
  it('names the version it was made for', async () => {
    expect(declaredVersion(source('1.2.3'))).toBe('1.2.3');
    expect(await renderReport(source('1.2.3'))).toContain('PLUGIN_API_VERSION: 1.2.3\n');
  });

  it('is up to date when nothing changed', async () => {
    expect(await reportProblem(source('1.0.0'), await renderReport(source('1.0.0')))).toBeUndefined();
  });

  it('ignores a comment-only change', async () => {
    const committed = await renderReport(source('1.0.0'));
    expect(await reportProblem(`/** Documented. */\n${source('1.0.0')}`, committed)).toBeUndefined();
  });

  it('refuses a changed surface under the same version', async () => {
    const committed = await renderReport(source('1.0.0'));
    const changed = source('1.0.0', 'export interface A { readonly a: string; readonly b?: number; }');
    expect(await reportProblem(changed, committed)).toMatch(/PLUGIN_API_VERSION is still 1\.0\.0/);
  });

  it('asks for a new report once the version is bumped', async () => {
    const committed = await renderReport(source('1.0.0'));
    const changed = source('1.1.0', 'export interface A { readonly a: string; readonly b?: number; }');
    expect(await reportProblem(changed, committed)).toMatch(/out of date/);
  });

  it('refuses a subpath that imports anything', async () => {
    const importing = `import type { X } from './x.js';\n${source('1.0.0', 'export type A = X;')}`;
    expect(moduleReferences(importing)).toEqual(['./x.js']);
    expect(moduleReferences(`${source('1.0.0')}export * from './y.js';`)).toEqual(['./y.js']);
    expect(moduleReferences(`${source('1.0.0')}export type B = import('./z.js').Z;`)).toHaveLength(1);
    expect(await reportProblem(importing, undefined)).toMatch(/must import nothing/);
  });
});
