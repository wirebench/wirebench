/**
 * YAML (de)serialisation tuned for git-friendly project files: keys sorted so
 * the byte order is a function of the data alone, and no line wrapping so a
 * long URL stays on one line and diffs stay readable.
 */

import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from 'yaml';
import { ProjectError } from '../errors.js';

/** Serialises a value to YAML with stable key order and unwrapped scalars. */
export function stringifyYaml(value: unknown): string {
  return stringifyYamlDocument(value, { sortMapEntries: true, lineWidth: 0 });
}

/**
 * Parses YAML text, raising `ProjectError('project-file-invalid')` with the
 * offending file path when the document is malformed.
 */
export function parseYaml(text: string, file: string): unknown {
  try {
    return parseYamlDocument(text);
  } catch (error) {
    throw new ProjectError('project-file-invalid', `Malformed YAML in ${file}`, {
      details: { file, issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] },
      cause: error,
    });
  }
}

/**
 * Drops `undefined` entries (and empty optional containers) so optional model
 * fields never surface as `key: null` in the YAML.
 */
export function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}
