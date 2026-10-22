/**
 * Whether pasted text is a `curl` command at all, before either cURL parser reads it.
 *
 * Both parsers skip a leading `curl` and read whatever else is there as flags and a URL, so
 * `wget http://example.com` used to import as a GET to `{base}wget`. The import now refuses text
 * whose first word is not `curl` (or `curl.exe`), after an optional `$ ` copied with a shell prompt.
 * No imports, so the renderer's preview runs exactly this check through `@wirebench/engine/rest`.
 */

/** A `$ ` shell prompt copied along with the command. */
const PROMPT_RE = /^\s*\$\s+/;

/** `text` without a leading `$ ` prompt, which is not part of the command. */
export function stripShellPrompt(text: string): string {
  return text.replace(PROMPT_RE, '');
}

/** Why `text` is not a curl command, in a sentence, or `undefined` when it is one (or is empty). */
export function notCurlReason(text: string): string | undefined {
  const first = /^\S+/.exec(stripShellPrompt(text).trimStart())?.[0];
  if (first === undefined || first === 'curl' || first === 'curl.exe') {
    return undefined;
  }
  const shown = first.length > 40 ? `${first.slice(0, 40)}…` : first;
  return `Not a curl command: it starts with “${shown}”. Paste a command that starts with curl.`;
}
