/** Thrown for any command-line mistake; `main` turns it into exit code 2. */
export class UsageError extends Error {
  readonly code = 'usage-error';
}
