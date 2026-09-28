/**
 * Turns a TypeScript script into the JavaScript the sandbox runs, by erasing its types.
 *
 * Node's `module.stripTypeScriptTypes` in `strip` mode replaces every type annotation with
 * whitespace, so each remaining character keeps its line and column and a run-time error points at
 * the right place in the file. It handles erasable syntax only; the checker (`erasableSyntaxOnly`)
 * refuses the rest before a script gets here.
 *
 * Node 24 still marks the function experimental and warns on its first use. That one warning is
 * silenced here; any other warning goes through untouched. A test pins the output of a fixture, so a
 * change in a later Node shows up in CI.
 */
import { stripTypeScriptTypes } from 'node:module';

let warningSilenced = false;

function silenceStripWarning(): void {
  if (warningSilenced) {
    return;
  }
  warningSilenced = true;
  const emit = process.emitWarning.bind(process);
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (
      (type === 'ExperimentalWarning' || (warning instanceof Error && warning.name === 'ExperimentalWarning')) &&
      text.includes('stripTypeScriptTypes')
    ) {
      return;
    }
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  };
}

/** Thrown when the script is not valid erasable TypeScript; carries Node's message. */
export class StripError extends Error {}

/** The script with its types erased, positions unchanged. */
export function stripTypes(source: string): string {
  silenceStripWarning();
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (error) {
    throw new StripError(error instanceof Error ? error.message : String(error));
  }
}
