/**
 * A deliberately small, best-effort read of a pasted `curl` command, used only to show the
 * user what they pasted before they commit to importing it. The authoritative parse is the
 * engine's `fromCurl`, which runs in main (`request.importCurl`) — the renderer may not import
 * the engine's Node-side modules, and a preview must never be the thing that writes a request.
 */

/** What {@link previewCurl} could make out of the pasted text. */
export interface CurlPreview {
  readonly endpoint: string | undefined;
  readonly soapAction: string | undefined;
  /** Header names, in the order they appear. Values are not shown — a paste may carry secrets. */
  readonly headers: readonly string[];
  readonly hasBody: boolean;
  readonly bodyLength: number;
  /** Things the real import will drop, named the same way `fromCurl` names them. */
  readonly problems: readonly string[];
}

const HEADER_RE = /(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g;
const URL_RE = /(?:^|\s)(?:--url\s+)?(?:'(https?:\/\/[^']*)'|"(https?:\/\/[^"]*)"|(https?:\/\/\S+))/;
const HEREDOC_RE = /<<\s*'?(\w+)'?\r?\n([\s\S]*?)\r?\n\1/;
const HERESTRING_RE = /@'\r?\n([\s\S]*?)\r?\n'@/;
const INLINE_DATA_RE = /(?:-d|--data|--data-raw|--data-binary)\s+(?:'([^']*)'|"([^"]*)")/;

/** Parses `text` well enough to describe it; never throws, and never surfaces header values. */
export function previewCurl(text: string): CurlPreview {
  const headers: string[] = [];
  const problems: string[] = [];
  let soapAction: string | undefined;

  for (const match of text.matchAll(HEADER_RE)) {
    const header = match[1] ?? match[2] ?? match[3] ?? '';
    const separator = header.indexOf(':');
    const name = separator > 0 ? header.slice(0, separator).trim() : header.trim();
    if (name.length === 0) {
      continue;
    }
    headers.push(name);
    if (name.toLowerCase() === 'soapaction') {
      soapAction = header
        .slice(separator + 1)
        .trim()
        .replace(/^"|"$/g, '');
    }
  }

  if (/(?:^|\s)(?:-u|--user)\s/.test(text)) {
    problems.push('basic-auth-ignored');
  }
  if (/(?:-d|--data|--data-raw|--data-binary)\s+@(?!-)/.test(text)) {
    problems.push('data-from-file-unsupported');
  }

  const urlMatch = URL_RE.exec(text);
  const body =
    HEREDOC_RE.exec(text)?.[2] ??
    HERESTRING_RE.exec(text)?.[1] ??
    INLINE_DATA_RE.exec(text)?.[1] ??
    INLINE_DATA_RE.exec(text)?.[2];

  return {
    endpoint: urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3],
    soapAction,
    headers,
    hasBody: body !== undefined,
    bodyLength: body?.length ?? 0,
    problems,
  };
}
