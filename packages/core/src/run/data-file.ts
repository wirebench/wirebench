/**
 * The rows of a data-driven run (#336): a CSV file with a header row, or a JSON array of flat objects.
 * Each row is one iteration's `${#Data#column}` values, so every value is text.
 *
 * A refusal names the line (CSV) or the item (JSON), never a value: a data file may hold anything.
 */
import { WirebenchError } from '../errors.js';

export type DataFormat = 'csv' | 'json';

/** A data file's columns, in file order, and its rows. Every row has a value for every column. */
export interface DataTable {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export const DATA_FILE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 100_000, maxColumns: 1_000 } as const;

const invalid = (message: string): WirebenchError => new WirebenchError('data-file-invalid', message);
const tooLarge = (message: string): WirebenchError => new WirebenchError('data-file-too-large', message);

/**
 * The format a data file's extension names.
 *
 * @throws WirebenchError `data-file-format` for anything but `.csv` and `.json`
 */
export function dataFormatOf(path: string): DataFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  throw new WirebenchError('data-file-format', 'A data file must be a .csv or a .json file');
}

/**
 * Parses a data file's text.
 *
 * @throws WirebenchError `data-file-invalid`, `data-file-empty` or `data-file-too-large`
 */
export function parseDataFile(text: string, format: DataFormat): DataTable {
  if (text.length > DATA_FILE_LIMITS.maxBytes) {
    throw tooLarge(`A data file can hold at most ${DATA_FILE_LIMITS.maxBytes} bytes`);
  }
  const table = format === 'csv' ? parseCsv(text) : parseJson(text);
  if (table.rows.length === 0) {
    throw new WirebenchError('data-file-empty', 'The data file has no rows');
  }
  return table;
}

/** A row object without a prototype, so a column named `__proto__` is an own value like any other. */
function rowOf(columns: readonly string[], values: (column: string, index: number) => string): Record<string, string> {
  const row = Object.create(null) as Record<string, string>;
  columns.forEach((column, index) => {
    row[column] = values(column, index);
  });
  return row;
}

function checkColumns(count: number): void {
  if (count > DATA_FILE_LIMITS.maxColumns) {
    throw tooLarge(`A data file can have at most ${DATA_FILE_LIMITS.maxColumns} columns`);
  }
}

function checkRows(count: number): void {
  if (count > DATA_FILE_LIMITS.maxRows) {
    throw tooLarge(`A data file can have at most ${DATA_FILE_LIMITS.maxRows} rows`);
  }
}

/** One CSV record's fields, with the line it starts on. */
interface CsvRecord {
  readonly line: number;
  readonly fields: string[];
}

/** RFC 4180 records: quoted fields may hold commas, `""` and line breaks; CRLF and LF both end a record. */
function csvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let quoteLine = 0;
  const endRecord = (): void => {
    fields.push(field);
    // A blank line is a record of one empty field: skipped.
    if (!(fields.length === 1 && fields[0] === '')) records.push({ line: recordLine, fields });
    fields = [];
    field = '';
    recordLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      quoteLine = line;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      endRecord();
    } else {
      field += c;
    }
  }
  if (quoted) throw invalid(`A quoted field opened on line ${quoteLine} is never closed`);
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

function parseCsv(text: string): DataTable {
  const records = csvRecords(text.startsWith('﻿') ? text.slice(1) : text);
  const [header, ...body] = records;
  if (header === undefined) return { columns: [], rows: [] };
  checkColumns(header.fields.length);
  const columns = header.fields.map((name) => name.trim());
  const seen = new Set<string>();
  for (const [index, column] of columns.entries()) {
    if (column === '') throw invalid(`Column ${index + 1} of the header row has no name`);
    if (seen.has(column)) throw invalid(`The header row names "${column}" twice`);
    seen.add(column);
  }
  checkRows(body.length);
  const rows = body.map(({ line, fields }) => {
    if (fields.length > columns.length) {
      throw invalid(`The record on line ${line} has ${fields.length} fields; the header names ${columns.length}`);
    }
    return rowOf(columns, (_column, index) => fields[index] ?? '');
  });
  return { columns, rows };
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function parseJson(text: string): DataTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('The data file is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw invalid('A JSON data file must be an array of objects');
  const items: readonly unknown[] = parsed;
  checkRows(items.length);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid(`The data file's item ${index + 1} is not an object`);
    }
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    checkColumns(columns.length);
  }
  const rows = (items as readonly Record<string, unknown>[]).map((item) =>
    rowOf(columns, (column) => (Object.hasOwn(item, column) ? cellText(item[column]) : '')),
  );
  return { columns, rows };
}
