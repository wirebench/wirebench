/**
 * `scanProjectForSecrets`: every credential stored in plain text in a project, for the review
 * dialog shown before a manual save or Sync commit (docs/specs/2026-09-22-secret-scanning-design.md).
 *
 * Pure module: no I/O.
 */
import { createHash } from 'node:crypto';
import type { Project } from '../../project/model.js';
import { detectInText } from './rules.js';
import { scanTargets } from './walk.js';
import type { SecretFinding, SecretLocation } from './walk.js';

/**
 * The id of the `occurrence`-th (from 0) match of `value` in the text at `location`. Counting equal
 * values rather than taking the offset keeps an id when text before it is edited. The value goes
 * last, after two NUL-ended fields (a location's JSON holds no raw NUL), so no value can be read as
 * another value's occurrence.
 */
function findingId(location: SecretLocation, value: string, occurrence: number): string {
  return createHash('sha256')
    .update(JSON.stringify(location))
    .update('\0')
    .update(String(occurrence))
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 16);
}

/** Every finding in `project`. The same project always yields the same findings with the same ids. */
export function scanProjectForSecrets(project: Project): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const target of scanTargets(project)) {
    const matches = detectInText(target.text, target.context);
    const seen = new Map<string, number>();
    const { location } = target;
    const inUrl = location.kind === 'rest-url' || location.kind === 'ws-url';
    for (const match of matches) {
      const value = target.text.slice(match.start, match.end);
      const occurrence = seen.get(value) ?? 0;
      seen.set(value, occurrence + 1);
      // A URL finding under a query parameter carries its key, for the name the dialog proposes.
      const at: SecretLocation = inUrl && match.name !== undefined ? { ...location, name: match.name } : location;
      findings.push({
        id: findingId(at, value, occurrence),
        location: at,
        rule: match.rule,
        label: target.label,
        valueStart: match.start,
        valueEnd: match.end,
        value,
      });
    }
  }
  return findings;
}

/** The only form of a value that leaves main: its first 3 characters, `…`, and its length. */
export function maskedPreview(value: string): string {
  const shown = value.length > 6 ? value.slice(0, 3) : '';
  return `${shown}… (${value.length} chars)`;
}
