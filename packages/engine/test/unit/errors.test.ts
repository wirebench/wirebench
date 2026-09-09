import { describe, expect, it } from 'vitest';
import {
  HttpError,
  ProjectError,
  SchemaError,
  ValidationError,
  WirebenchError,
  WsdlParseError,
  WssError,
  isWirebenchError,
} from '../../src/errors.js';

describe('WirebenchError', () => {
  it('carries a code, message, details and cause', () => {
    const cause = new Error('root cause');
    const err = new WirebenchError('some-code', 'something went wrong', {
      details: { foo: 'bar' },
      cause,
    });

    expect(err.code).toBe('some-code');
    expect(err.message).toBe('something went wrong');
    expect(err.details).toEqual({ foo: 'bar' });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('WirebenchError');
    expect(err).toBeInstanceOf(Error);
  });

  it('allows omitting options', () => {
    const err = new WirebenchError('code', 'message');
    expect(err.details).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe('subclasses', () => {
  const cases: Array<[new (code: string, message: string) => WirebenchError, string]> = [
    [WsdlParseError, 'WsdlParseError'],
    [SchemaError, 'SchemaError'],
    [HttpError, 'HttpError'],
    [WssError, 'WssError'],
    [ProjectError, 'ProjectError'],
    [ValidationError, 'ValidationError'],
  ];

  it.each(cases)('%s sets name correctly', (Ctor, expectedName) => {
    const err = new Ctor('code', 'message');
    expect(err.name).toBe(expectedName);
    expect(err).toBeInstanceOf(WirebenchError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isWirebenchError', () => {
  it('returns true for WirebenchError and subclasses', () => {
    expect(isWirebenchError(new WirebenchError('c', 'm'))).toBe(true);
    expect(isWirebenchError(new WsdlParseError('c', 'm'))).toBe(true);
  });

  it('returns false for plain errors and non-errors', () => {
    expect(isWirebenchError(new Error('m'))).toBe(false);
    expect(isWirebenchError('not an error')).toBe(false);
    expect(isWirebenchError(undefined)).toBe(false);
  });
});
