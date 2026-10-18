import { describe, expect, it } from 'vitest';
import { pathDisplayName, requestDisplayName } from '../../src/renderer/features/rest-api/request-display-name.js';

describe('requestDisplayName', () => {
  it('leaves out the method a stored name starts with', () => {
    expect(requestDisplayName('GET /pets/{id}', 'GET')).toBe('/pets/{id}');
    expect(requestDisplayName('POST /echo', 'post')).toBe('/echo');
    expect(requestDisplayName('DELETE   /pets/{id}', 'DELETE')).toBe('/pets/{id}');
  });

  it('keeps a name that starts with another method, or with the word in another case', () => {
    expect(requestDisplayName('GET /pets', 'POST')).toBe('GET /pets');
    expect(requestDisplayName('Get pets', 'GET')).toBe('Get pets');
    expect(requestDisplayName('GETTER', 'GET')).toBe('GETTER');
  });

  it('keeps a name that is the method alone, and any name without a method', () => {
    expect(requestDisplayName('GET ', 'GET')).toBe('GET ');
    expect(requestDisplayName('GET', 'GET')).toBe('GET');
    expect(requestDisplayName('GET /pets', undefined)).toBe('GET /pets');
    expect(requestDisplayName('List pets', 'GET')).toBe('List pets');
  });
});

describe('pathDisplayName', () => {
  it('shows the last part of a Runner path as the tree shows the name', () => {
    expect(pathDisplayName('Shop/Pets/GET /pets/{id}', 'GET /pets/{id}', 'GET')).toBe('Shop/Pets › /pets/{id}');
    expect(pathDisplayName('Shop/Pets//pets/{id}', '/pets/{id}', 'GET')).toBe('Shop/Pets › /pets/{id}');
    expect(pathDisplayName('Shop/GET me', 'GET me', 'GET')).toBe('Shop/me');
    expect(pathDisplayName('Shop/List pets', 'List pets', 'GET')).toBe('Shop/List pets');
    expect(pathDisplayName('Files/Read', 'Read', undefined)).toBe('Files/Read');
    expect(pathDisplayName('1. Log in', 'Log in', undefined)).toBe('1. Log in');
  });
});
