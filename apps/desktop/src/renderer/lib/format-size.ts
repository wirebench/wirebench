/** Byte and duration formatting for the response header line, HTTP log, and status bar. */

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Formats a byte count the way the status line reads it: `842 B`, `1.2 KB`, `3.4 MB`.
 * Sub-kilobyte values stay whole; larger ones keep one decimal (1024-based).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(Math.round(value))} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]!}`;
}

/** Decoded byte length of a base64 payload, without allocating the bytes. */
export function base64ByteLength(base64: string): number {
  if (base64.length === 0) {
    return 0;
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, (base64.length * 3) / 4 - padding);
}

/** Decodes base64 to text; returns `undefined` when the payload is not valid base64. */
export function decodeBase64Text(base64: string): string | undefined {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** `HH:MM:SS` in local time, for the HTTP log's time column. */
export function formatClockTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
