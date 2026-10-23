// packages/engine/test/unit/plugin-api.types.ts
/**
 * The plugin API against the engine's own types (phase 7 spec §5). Nothing runs this file: `tsc -b`
 * checks it through `tsconfig.test.json`. Where the plugin sees exactly what the engine has, the two
 * are assignable both ways; where it sees a narrower view, the engine's type is assignable to it, so a
 * field a plugin relies on cannot disappear from the engine unnoticed.
 */
import type { Layout as EngineLayout } from '#core/http/codegen/target';
import type { GeneratedCode as EngineGeneratedCode } from '#core/http/codegen/index';
import type { PluginManifestData } from '#core/extension/plugin/manifest';
import type { PluginImportData } from '#core/extension/plugin/results';
import type { JsonReport } from '#core/run/report';
import type { GeneratedCode, ImportResult, Layout, PluginManifest, RunReport } from '../../src/plugin.js';

type Assignable<From, To> = [From] extends [To] ? true : false;
type Same<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

export const layout: Same<Layout, EngineLayout> = true;
export const generated: Same<GeneratedCode, EngineGeneratedCode> = true;
export const report: Assignable<JsonReport, RunReport> = true;
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// Every manifest an author types against the plugin API is one the loader's schema can hold.
export const manifest: Assignable<PluginManifest, DeepReadonly<PluginManifestData>> = true;

// Every result an importer can be typed to return is one the host's check can hold.
export const importResult: Assignable<ImportResult, DeepReadonly<PluginImportData>> = true;
