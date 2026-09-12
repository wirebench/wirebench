import { describe, expect, it } from 'vitest';
import { toCurl } from '@wirebench/engine';
import { highlightCurl, type CurlLine } from '../../src/renderer/shell/curl-highlight.js';

/** Reassembles what the Code panel renders, so a test can compare it to what it was handed. */
function rendered(lines: readonly CurlLine[]): string {
  return lines.map((line) => line.map((token) => token.text).join('')).join('\n');
}

/** Every span of one kind, in order — what a colour assertion actually cares about. */
function textOf(lines: readonly CurlLine[], kind: string): string[] {
  return lines.flatMap((line) => line.filter((token) => token.kind === kind).map((token) => token.text));
}

const ENVELOPE = '<?xml version="1.0"?>\n<Envelope>\n  <Body><Add a="1"/></Body>\n</Envelope>';

const SEND = {
  endpoint: 'https://example.test/calculator.asmx',
  envelopeXml: ENVELOPE,
  soapVersion: '1.1',
  soapAction: 'http://tempuri.org/Add',
  headers: { 'X-Trace': 'abc-123' },
} as const;

describe('highlightCurl', () => {
  it('reproduces a POSIX command exactly', () => {
    const command = toCurl(SEND);
    expect(rendered(highlightCurl(command))).toBe(command);
  });

  it('reproduces a PowerShell command exactly', () => {
    const command = toCurl(SEND, { shell: 'powershell' });
    expect(rendered(highlightCurl(command))).toBe(command);
  });

  it('reproduces a command whose values carry embedded quotes', () => {
    // POSIX escapes an embedded quote as `'\''`, PowerShell doubles it — a scanner that ended the
    // string at the first inner quote would still round-trip, but would colour the rest wrongly.
    const quoted = { ...SEND, headers: { 'X-Note': "it's fine" } };
    for (const shell of ['posix', 'powershell'] as const) {
      const command = toCurl(quoted, { shell });
      const lines = highlightCurl(command);
      expect(rendered(lines)).toBe(command);
      expect(textOf(lines, 'string').some((text) => text.includes('X-Note'))).toBe(true);
    }
  });

  it('names the command and its flags', () => {
    const lines = highlightCurl(toCurl(SEND));
    expect(textOf(lines, 'command')).toEqual(['curl']);
    expect(textOf(lines, 'flag')).toEqual(['--request', '--header', '--header', '--header', '--data-binary']);
  });

  it('recognises `curl.exe` as the command', () => {
    expect(textOf(highlightCurl(toCurl(SEND, { shell: 'powershell' })), 'command')).toEqual(['curl.exe']);
  });

  it('treats the whole POSIX heredoc body as body, not shell', () => {
    expect(textOf(highlightCurl(toCurl(SEND)), 'body').join('\n')).toBe(ENVELOPE);
  });

  it('treats the whole PowerShell here-string body as body, not shell', () => {
    expect(textOf(highlightCurl(toCurl(SEND, { shell: 'powershell' })), 'body').join('\n')).toBe(ENVELOPE);
  });

  it('does not mistake an XML line inside the body for a flag', () => {
    // A body line can start with anything, `--` included (an XML comment opens with `<!--`).
    const commented = { ...SEND, envelopeXml: '<!-- --request -->\n<Envelope/>' };
    const lines = highlightCurl(toCurl(commented));
    // Exactly the command's own five flags: the `--request` inside the comment contributed none.
    expect(textOf(lines, 'flag')).toEqual(['--request', '--header', '--header', '--header', '--data-binary']);
    expect(textOf(lines, 'body').join('\n')).toBe(commented.envelopeXml);
    expect(rendered(lines)).toBe(toCurl(commented));
  });

  it('returns one empty line for an empty command, so nothing renders', () => {
    expect(rendered(highlightCurl(''))).toBe('');
  });
});
