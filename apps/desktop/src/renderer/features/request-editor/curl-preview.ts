/**
 * A deliberately small, best-effort read of a pasted `curl` command, used only to show the
 * user what they pasted before they commit to importing it. The authoritative parse is the
 * engine's `fromCurl`, which runs in main (`request.importCurl`) — the renderer may not import
 * the engine's Node-side modules, and a preview must never be the thing that writes a request.
 *
 * The same command reads differently by target: a SOAP import keeps an envelope and a SOAPAction and
 * drops credentials, a REST import keeps a method, a body kind and Basic auth. The preview shows the
 * fields the chosen target will fill in, and only the problems that target has.
 */

/** What {@link previewCurl} could make out of the pasted text. */
export interface CurlPreview {
  readonly endpoint: string | undefined;
  readonly soapAction: string | undefined;
  /** Header names, in the order they appear. Values are not shown — a paste may carry secrets. */
  readonly headers: readonly string[];
  readonly hasBody: boolean;
  readonly bodyLength: number;
  /** The method a REST import will use: `-X`, else HEAD for `-I`, GET for `-G`, POST with a body. */
  readonly method: string;
  /** What a REST import makes of the body flags, most specific first, as the engine decides it. */
  readonly bodyKind: 'multipart' | 'form' | 'file' | 'JSON' | 'raw' | undefined;
  /** The `-u` username, for Basic auth. Never the password. */
  readonly basicUsername: string | undefined;
  /** Things the real import will drop, named the same way `fromCurl` names them. */
  readonly problems: readonly string[];
}

const HEADER_RE = /(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g;
const URL_RE = /(?:^|\s)(?:--url\s+)?(?:'(https?:\/\/[^']*)'|"(https?:\/\/[^"]*)"|(https?:\/\/\S+))/;
const HEREDOC_RE = /<<\s*'?(\w+)'?\r?\n([\s\S]*?)\r?\n\1/;
const HERESTRING_RE = /@'\r?\n([\s\S]*?)\r?\n'@/;
const INLINE_DATA_RE = /(?:-d|--data|--data-raw|--data-binary)\s+(?:'([^']*)'|"([^"]*)")/;
const METHOD_RE = /(?:^|\s)(?:-X\s*|--request\s+)['"]?([A-Za-z]+)/;
const USER_RE = /(?:^|\s)(?:-u\s*|--user\s+)(?:'([^':]*)|"([^":]*)|([^\s:'"]+))/;

/** Whether the command carries one of `flags` as a word of its own. */
function has(text: string, ...flags: readonly string[]): boolean {
  return flags.some((flag) =>
    new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(text),
  );
}

/**
 * Parses `text` well enough to describe it for `target`; never throws, and never surfaces header
 * values or a password.
 */
export function previewCurl(text: string, target: 'soap' | 'rest' = 'soap'): CurlPreview {
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

  const userMatch = USER_RE.exec(text);
  const basicUsername = userMatch?.[1] ?? userMatch?.[2] ?? userMatch?.[3];
  const dataFromFile = /(?:-d|--data|--data-raw|--data-binary)\s+@(?!-)/.test(text);
  // Only SOAP drops these: the REST import turns `-u` into Basic auth and `-d @file` into a file body.
  if (target === 'soap' && basicUsername !== undefined) {
    problems.push('basic-auth-ignored');
  }
  if (target === 'soap' && dataFromFile) {
    problems.push('data-from-file-unsupported');
  }

  const urlMatch = URL_RE.exec(text);
  const body =
    HEREDOC_RE.exec(text)?.[2] ??
    HERESTRING_RE.exec(text)?.[1] ??
    INLINE_DATA_RE.exec(text)?.[1] ??
    INLINE_DATA_RE.exec(text)?.[2];

  const json = has(text, '--json');
  const bodyKind: CurlPreview['bodyKind'] = has(text, '-F', '--form')
    ? 'multipart'
    : has(text, '--data-urlencode')
      ? 'form'
      : dataFromFile
        ? 'file'
        : json
          ? 'JSON'
          : body !== undefined
            ? 'raw'
            : undefined;
  const dataInQuery = has(text, '-G', '--get');
  const method =
    METHOD_RE.exec(text)?.[1]?.toUpperCase() ??
    (has(text, '-I', '--head') ? 'HEAD' : dataInQuery || bodyKind === undefined ? 'GET' : 'POST');

  return {
    endpoint: urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3],
    soapAction,
    headers,
    hasBody: body !== undefined,
    bodyLength: body?.length ?? 0,
    method,
    bodyKind: dataInQuery ? undefined : bodyKind,
    basicUsername,
    problems,
  };
}

/** A problem as the import names it (`fromCurl`'s codes, `fromRestCurl`'s sentences), in words. */
export function describeCurlProblem(problem: string): string {
  if (problem === 'basic-auth-ignored') {
    return 'The -u credentials are not imported into a SOAP request; set auth on the Auth tab';
  }
  if (problem === 'data-from-file-unsupported') {
    return 'A body read from a file (-d @file) is not imported into a SOAP request';
  }
  if (problem.startsWith('ignored-flag:')) {
    return `Ignored ${problem.slice('ignored-flag:'.length)}`;
  }
  return problem;
}
