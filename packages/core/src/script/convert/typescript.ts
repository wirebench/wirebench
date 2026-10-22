/**
 * The TypeScript compiler, loaded on the first conversion. The engine's entry re-exports the
 * converter, and loading the compiler takes over 100 ms, so nothing that only imports the engine
 * (the desktop's main process, the command line) pays for it at start-up.
 */
import { createRequire } from 'node:module';
import type ts from 'typescript';

let loaded: typeof ts | undefined;

export function typescript(): typeof ts {
  loaded ??= createRequire(import.meta.url)('typescript') as typeof ts;
  return loaded;
}
