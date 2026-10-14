import { describe, expect, it } from 'vitest';
import {
  lintLocationLabel,
  lintOperation,
  pointerSegments,
} from '../../src/renderer/features/problems/lint-location.js';

describe('lintLocationLabel', () => {
  it('reads an operation response as method, path, status and media type', () => {
    expect(lintLocationLabel('/paths/~1json/get/responses/200/content/application~1json')).toBe(
      'GET /json › 200 › application/json',
    );
  });

  it('reads an operation as its method and path', () => {
    expect(lintLocationLabel('/paths/~1pets~1{id}/get')).toBe('GET /pets/{id}');
    expect(lintLocationLabel('/paths/~1pets/post/requestBody')).toBe('POST /pets › request body');
  });

  it('counts list entries from one, except response statuses', () => {
    expect(lintLocationLabel('/paths/~1pets/get/parameters/0')).toBe('GET /pets › parameters › 1');
    expect(lintLocationLabel('/servers/1/url')).toBe('servers › 2 › url');
  });

  it('keeps a trailing container key, which is the place itself', () => {
    expect(lintLocationLabel('/paths/~1pets/get/responses')).toBe('GET /pets › responses');
  });

  it('reads a path item without a method, components and the root', () => {
    expect(lintLocationLabel('/paths/~1pets')).toBe('/pets');
    expect(lintLocationLabel('/components/schemas/Pet/properties/name')).toBe('components › Pet › name');
    expect(lintLocationLabel('/info')).toBe('info');
    expect(lintLocationLabel('/')).toBe('document');
    expect(lintLocationLabel('')).toBe('document');
  });

  it('unescapes ~0 and ~1 in that order', () => {
    expect(pointerSegments('/a~01b/c~1d')).toEqual(['a~1b', 'c/d']);
  });
});

describe('lintOperation', () => {
  it('names the operation a pointer sits in', () => {
    expect(lintOperation('/paths/~1json/get/responses/200')).toEqual({ method: 'GET', path: '/json' });
  });

  it('is undefined outside an operation', () => {
    expect(lintOperation('/paths/~1json')).toBeUndefined();
    expect(lintOperation('/paths/~1json/parameters/0')).toBeUndefined();
    expect(lintOperation('/info')).toBeUndefined();
  });
});
