import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FetchDocument } from '#core/http/fetch-document';
import type { LintFinding } from '#protocol-rest/rest/openapi/lint/model';

export const FIXTURES = fileURLToPath(new URL('../../../../fixtures/lint/', import.meta.url));

/** A fixture's location and text, as the CLI would hand them over. */
export async function fixture(name: string): Promise<{ text: string; location: string }> {
  const path = `${FIXTURES}${name}`;
  return { text: await readFile(path, 'utf8'), location: pathToFileURL(path).href };
}

/** Reads `file:` URLs from disk and `remote` ones from a map; records every location asked for. */
export function recordingFetch(remote: Readonly<Record<string, string>> = {}): {
  fetchDocument: FetchDocument;
  asked: string[];
} {
  const asked: string[] = [];
  const fetchDocument: FetchDocument = async (location) => {
    asked.push(location);
    const text = location.startsWith('file:') ? await readFile(fileURLToPath(location), 'utf8') : remote[location];
    if (text === undefined) throw new Error(`no such document ${location}`);
    return { location, text, bytes: new TextEncoder().encode(text) };
  };
  return { fetchDocument, asked };
}

/** `rule path` per finding: the shape most assertions compare. */
export function brief(findings: readonly LintFinding[]): string[] {
  return findings.map((finding) => `${finding.rule} ${finding.path}`);
}
