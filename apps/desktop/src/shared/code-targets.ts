/**
 * The Code panel's languages, for the wire schema and the renderer alike. Plain data with no zod and
 * no engine import, so the renderer may import it eagerly. The generated ones must match the
 * engine's `CODE_TARGETS`, which a main test checks.
 */

/** The languages main generates through `request.code`, with each one's own indent convention. */
export const GENERATED_CODE_TARGETS = [
  { id: 'js-fetch', label: 'JavaScript — fetch', indent: 2 },
  { id: 'node-axios', label: 'Node.js — axios', indent: 2 },
  { id: 'python-requests', label: 'Python — requests', indent: 4 },
  { id: 'go-net-http', label: 'Go — net/http', indent: 'tab' },
  { id: 'java-httpclient', label: 'Java — HttpClient', indent: 4 },
  { id: 'java-okhttp', label: 'Java — OkHttp', indent: 4 },
  { id: 'csharp-httpclient', label: 'C# — HttpClient', indent: 4 },
  { id: 'php-curl', label: 'PHP — cURL', indent: 4 },
  { id: 'ruby-net-http', label: 'Ruby — Net::HTTP', indent: 2 },
  { id: 'powershell-irm', label: 'PowerShell — Invoke-RestMethod', indent: 4 },
  { id: 'httpie', label: 'HTTPie', indent: 2 },
] as const satisfies readonly { id: string; label: string; indent: number | 'tab' }[];

export type GeneratedCodeTarget = (typeof GENERATED_CODE_TARGETS)[number]['id'];

/** Every id `request.code` answers: the generated languages and the `wirebench run` line. */
export const CODE_TARGET_IDS: readonly [
  GeneratedCodeTarget | 'wirebench-run',
  ...(GeneratedCodeTarget | 'wirebench-run')[],
] = ['wirebench-run', ...GENERATED_CODE_TARGETS.map((target) => target.id)];

export type CodeTarget = GeneratedCodeTarget | 'wirebench-run';

/** What the Code panel shows: `curl` (today's command, in the remembered shell), or a `request.code` target. */
export type CodeLanguage = 'curl' | CodeTarget;

/** Every language the panel offers, in the order its picker lists them. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  'curl',
  ...GENERATED_CODE_TARGETS.map((target) => target.id),
  'wirebench-run',
];

/** A language as its own string, for a value read back from storage. */
export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === 'string' && (CODE_LANGUAGES as readonly string[]).includes(value);
}

/** One language's layout choices. An absent field takes the request's own value (or, for indent, the language's). */
export interface CodeSettings {
  readonly indent?: number | 'tab';
  readonly followRedirects?: boolean;
  /** Milliseconds; 0 means no timeout. */
  readonly timeoutMs?: number;
}
