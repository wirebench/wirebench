import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '#core/errors';
import { DATA_FILE_LIMITS, dataFormatOf, parseDataFile } from '#core/run/data-file';

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isWirebenchError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('dataFormatOf', () => {
  it('reads the format from the extension, case-insensitively', () => {
    expect(dataFormatOf('rows.csv')).toBe('csv');
    expect(dataFormatOf('/a/b/Rows.JSON')).toBe('json');
  });

  it('refuses any other extension', () => {
    expect(refusal(() => dataFormatOf('rows.txt')).code).toBe('data-file-format');
    expect(refusal(() => dataFormatOf('rows')).code).toBe('data-file-format');
  });
});

describe('parseDataFile: CSV', () => {
  it('reads a header row and one row per record', () => {
    expect(parseDataFile('user,id\nann,1\nbob,2\n', 'csv')).toEqual({
      columns: ['user', 'id'],
      rows: [
        { user: 'ann', id: '1' },
        { user: 'bob', id: '2' },
      ],
    });
  });

  it('drops a BOM, accepts CRLF, and skips blank lines', () => {
    expect(parseDataFile('﻿a,b\r\n1,2\r\n\r\n3,4', 'csv').rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('follows RFC 4180 quoting: commas, quotes and line breaks inside quotes', () => {
    const text = 'name,note\n"Smith, J","said ""hi""\nthen left"\n';
    expect(parseDataFile(text, 'csv').rows).toEqual([{ name: 'Smith, J', note: 'said "hi"\nthen left' }]);
  });

  it('keeps leading and trailing spaces in values, and trims column names', () => {
    expect(parseDataFile(' a , b\n x ,y', 'csv')).toEqual({ columns: ['a', 'b'], rows: [{ a: ' x ', b: 'y' }] });
  });

  it('gives missing trailing fields an empty value', () => {
    expect(parseDataFile('a,b,c\n1', 'csv').rows).toEqual([{ a: '1', b: '', c: '' }]);
  });

  it('keeps a column named __proto__ as an own value', () => {
    const [row] = parseDataFile('__proto__\nx', 'csv').rows;
    expect(Object.hasOwn(row!, '__proto__')).toBe(true);
    expect(row!['__proto__']).toBe('x');
  });

  it('refuses a record with more fields than the header, naming its line', () => {
    const { code, message } = refusal(() => parseDataFile('a\n1\n2,secretvalue', 'csv'));
    expect(code).toBe('data-file-invalid');
    expect(message).toContain('line 3');
    expect(message).not.toContain('secretvalue');
  });

  it('refuses an empty or duplicate column name', () => {
    expect(refusal(() => parseDataFile('a,,b\n1,2,3', 'csv')).code).toBe('data-file-invalid');
    expect(refusal(() => parseDataFile('a,a\n1,2', 'csv')).message).toContain('"a"');
  });

  it('refuses an unterminated quote', () => {
    expect(refusal(() => parseDataFile('a\n"oops', 'csv')).code).toBe('data-file-invalid');
  });

  it('refuses a file without rows', () => {
    expect(refusal(() => parseDataFile('a,b\n', 'csv')).code).toBe('data-file-empty');
    expect(refusal(() => parseDataFile('', 'csv')).code).toBe('data-file-empty');
  });
});

describe('parseDataFile: JSON', () => {
  it('reads an array of objects, coercing values to text', () => {
    const text = JSON.stringify([{ s: 'x', n: 1.5, b: true, z: null, o: { k: [1, 2] } }]);
    expect(parseDataFile(text, 'json')).toEqual({
      columns: ['s', 'n', 'b', 'z', 'o'],
      rows: [{ s: 'x', n: '1.5', b: 'true', z: '', o: '{"k":[1,2]}' }],
    });
  });

  it('takes the union of the keys, first seen first, missing values empty', () => {
    expect(parseDataFile('[{"a":"1"},{"b":"2","a":"3"}]', 'json')).toEqual({
      columns: ['a', 'b'],
      rows: [
        { a: '1', b: '' },
        { a: '3', b: '2' },
      ],
    });
  });

  it('refuses text that is not an array of objects, naming the item', () => {
    expect(refusal(() => parseDataFile('{"a":1}', 'json')).code).toBe('data-file-invalid');
    expect(refusal(() => parseDataFile('[{"a":1}, 2]', 'json')).message).toContain('item 2');
    expect(refusal(() => parseDataFile('not json', 'json')).code).toBe('data-file-invalid');
  });

  it('refuses an empty array', () => {
    expect(refusal(() => parseDataFile('[]', 'json')).code).toBe('data-file-empty');
  });
});

describe('parseDataFile: limits', () => {
  it('refuses more rows than the limit', () => {
    const text = `a\n${'1\n'.repeat(DATA_FILE_LIMITS.maxRows + 1)}`;
    expect(refusal(() => parseDataFile(text, 'csv')).code).toBe('data-file-too-large');
  });

  it('refuses more columns than the limit', () => {
    const header = Array.from({ length: DATA_FILE_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
    expect(refusal(() => parseDataFile(`${header}\n1`, 'csv')).code).toBe('data-file-too-large');
  });

  it('refuses text over the size limit', () => {
    const text = `a\n${'x'.repeat(DATA_FILE_LIMITS.maxBytes)}`;
    expect(refusal(() => parseDataFile(text, 'csv')).code).toBe('data-file-too-large');
  });
});
