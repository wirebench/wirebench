import { MAX_TEAMS_NAME_LENGTH } from '@wirebench/engine';
import { nameInvalid } from './errors.js';

/**
 * §6: team and workspace names are trimmed and 1–80 characters after trimming. The schema bounded
 * the raw string already; this catches a name of spaces only.
 */
export function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_TEAMS_NAME_LENGTH) throw nameInvalid();
  return name;
}
