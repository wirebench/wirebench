/**
 * The curl flags both command readers (SOAP in `curl.ts`, REST in `../rest/curl.ts`) need to agree
 * on: which ones take no value. A reader that skips a flag it has no field for must also skip that
 * flag's value, or the value is read as the URL; and it must not skip the token after a flag that
 * has none, or the URL is swallowed instead.
 */

/** Flags that take no value, so a parser must not eat the token after them. */
export const VALUELESS_FLAGS = new Set([
  '-k',
  '--insecure',
  '-L',
  '--location',
  '-s',
  '--silent',
  '-v',
  '--verbose',
  '-i',
  '--include',
  '-f',
  '--fail',
  '-g',
  '--globoff',
  '--compressed',
  '-4',
  '-6',
  '--http1.0',
  '--http1.1',
  '--http2',
  '--http2-prior-knowledge',
  '--http3',
  '-G',
  '--get',
  '-I',
  '--head',
  '-O',
  '--remote-name',
  '-J',
  '--remote-header-name',
  '-S',
  '--show-error',
  '-N',
  '--no-buffer',
  '-#',
  '--progress-bar',
  '-n',
  '--netrc',
  '-j',
  '--junk-session-cookies',
  '--basic',
  '--digest',
  '--ntlm',
  '--negotiate',
  '--anyauth',
  '--fail-with-body',
  '--location-trusted',
  '--path-as-is',
  '--raw',
  '--no-keepalive',
  '--tcp-nodelay',
  '--ssl',
  '--ssl-reqd',
  '--tlsv1',
  '--tlsv1.0',
  '--tlsv1.1',
  '--tlsv1.2',
  '--tlsv1.3',
]);

/**
 * Splits a bundle of short flags the way curl reads it: `-sSL` is three flags, and the first letter
 * that takes a value ends the bundle, the rest being its value (`-XPUT`, `-sXPOST`, `-uada:pw`).
 */
export function expandBundles(tokens: readonly string[]): string[] {
  return tokens.flatMap((token) => {
    if (!/^-[A-Za-z0-9#]./.test(token)) {
      return [token];
    }
    const out: string[] = [];
    for (let at = 1; at < token.length; at += 1) {
      const flag = `-${token.charAt(at)}`;
      out.push(flag);
      if (!VALUELESS_FLAGS.has(flag)) {
        const value = token.slice(at + 1);
        if (value !== '') {
          out.push(value);
        }
        break;
      }
    }
    return out;
  });
}

/** Whether a flag this reader does not handle stands alone: listed as value-less, or `--name=value`. */
export function takesNoValue(flag: string): boolean {
  return VALUELESS_FLAGS.has(flag) || flag.includes('=');
}
