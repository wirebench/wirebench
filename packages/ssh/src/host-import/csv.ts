import { SshModelError } from '../errors.js';
import type { ImportedSession, SessionSource } from './sessions.js';

/** The documented columns, in the template's order. Only `address` is required. */
export const HOSTS_CSV_COLUMNS = ['name', 'address', 'port', 'user', 'group', 'tags', 'key', 'jump'] as const;
type Column = (typeof HOSTS_CSV_COLUMNS)[number];
/** Columns read only to count them: their values never leave the parser. */
const PASSWORD_COLUMNS = new Set(['password', 'passphrase']);

interface CsvRecord {
  readonly line: number;
  readonly cells: string[];
}

/** RFC 4180 records: quoted cells may hold the delimiter, `""` and line breaks. */
function readRecords(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = (): void => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) records.push({ line: start, cells });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n') {
      endRecord();
      line += 1;
      start = line;
    } else if (ch !== '\r') cell += ch;
  }
  endRecord();
  return records;
}

const noAddress = (): SshModelError =>
  new SshModelError(
    'ssh-import-unreadable',
    `The CSV needs an address column; its first row names the columns (${HOSTS_CSV_COLUMNS.join(', ')})`,
  );

/**
 * Hosts from a CSV whose first row names the columns (`HOSTS_CSV_COLUMNS`, any order and case). `group` is a
 * `/`-separated folder path, `tags` a comma- or semicolon-separated list, `jump` another row's name or
 * `[user@]host[:port]`. A semicolon-separated file is read too. Password columns are counted, never kept.
 */
export function parseHostsCsv(text: string): SessionSource {
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const [header, ...rows] = readRecords(text, delimiter);
  const names = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
  if (!names.includes('address')) throw noAddress();

  const at = (column: Column): number => names.indexOf(column);
  const known = new Set<string>(HOSTS_CSV_COLUMNS);
  const ignored = new Map<string, number>();
  const sessions: ImportedSession[] = [];
  const skipped: { line: number; keyword: string; why: string }[] = [];
  let passwords = 0;

  for (const row of rows) {
    const cell = (column: Column): string | undefined => {
      const index = at(column);
      const value = index === -1 ? undefined : row.cells[index]?.trim();
      return value === undefined || value === '' ? undefined : value;
    };
    const filled = (i: number): boolean => (row.cells[i]?.trim() ?? '') !== '';
    names.forEach((name, i) => {
      if (known.has(name) || PASSWORD_COLUMNS.has(name) || !filled(i)) return;
      ignored.set(name, (ignored.get(name) ?? 0) + 1);
    });
    if (names.some((name, i) => PASSWORD_COLUMNS.has(name) && filled(i))) passwords += 1;

    const address = cell('address');
    const name = cell('name') ?? address;
    if (address === undefined || name === undefined) {
      skipped.push({ line: row.line, keyword: 'address', why: `${name ?? 'a row'}: has no address` });
      continue;
    }
    const portText = cell('port');
    const port = portText === undefined ? undefined : Number(portText);
    if (portText !== undefined && (!/^\d{1,5}$/.test(portText) || (port as number) < 1 || (port as number) > 65535)) {
      skipped.push({ line: row.line, keyword: 'port', why: `${name}: the port is not a number from 1 to 65535` });
      continue;
    }
    const user = cell('user');
    const folder = (cell('group') ?? '')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const tags = (cell('tags') ?? '')
      .split(/[,;]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
    const keyFile = cell('key');
    const jump = cell('jump');
    sessions.push({
      name,
      line: row.line,
      folder,
      address,
      ...(port === undefined ? {} : { port }),
      ...(user === undefined ? {} : { user }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(keyFile === undefined ? {} : { keyFile }),
      ...(jump === undefined ? {} : { jump }),
    });
  }
  return {
    format: 'csv',
    sessions,
    skipped,
    ignored: [...ignored].map(([keyword, count]) => ({ keyword, count })),
    notes: [],
    passwords,
  };
}
