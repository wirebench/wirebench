import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import {
  isPostmanCollection,
  normalizePostmanPath,
  parsePostmanCollectionText,
  translatePostmanVariables,
} from '../../../../src/rest/postman/parse.js';

describe('Postman parse and normalization', () => {
  describe('translatePostmanVariables', () => {
    it('converts double curly braces to dollar curly braces', () => {
      expect(translatePostmanVariables('{{baseUrl}}/api/{{version}}')).toBe('${baseUrl}/api/${version}');
    });

    it('tolerates whitespace inside curly braces', () => {
      expect(translatePostmanVariables('{{  my_var   }}')).toBe('${my_var}');
    });

    it('leaves plain text unchanged', () => {
      expect(translatePostmanVariables('https://example.com/users')).toBe('https://example.com/users');
    });

    it('does not touch single curly braces', () => {
      expect(translatePostmanVariables('/users/{userId}')).toBe('/users/{userId}');
    });
  });

  describe('normalizePostmanPath', () => {
    it('converts colon path parameters to curly braces', () => {
      expect(normalizePostmanPath('/users/:id')).toBe('/users/{id}');
      expect(normalizePostmanPath('/users/:userId/posts/:postId')).toBe('/users/{userId}/posts/{postId}');
    });

    it('handles query parameters and anchors correctly', () => {
      expect(normalizePostmanPath('/users/:id?active=true')).toBe('/users/{id}?active=true');
      expect(normalizePostmanPath('/users/:id#section')).toBe('/users/{id}#section');
    });

    it('leaves paths without colons unchanged', () => {
      expect(normalizePostmanPath('/users/active')).toBe('/users/active');
    });
  });

  describe('isPostmanCollection', () => {
    it('detects collections by official schema URL', () => {
      const doc = {
        info: {
          name: 'My Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [],
      };
      expect(isPostmanCollection(doc)).toBe(true);
    });

    it('detects collections by structural fingerprint', () => {
      const doc = {
        info: {
          name: 'My Collection',
        },
        item: [],
      };
      expect(isPostmanCollection(doc)).toBe(true);
    });

    it('returns false for OpenAPI / Swagger or random objects', () => {
      expect(isPostmanCollection(null)).toBe(false);
      expect(isPostmanCollection({})).toBe(false);
      expect(isPostmanCollection({ openapi: '3.0.0' })).toBe(false);
      expect(isPostmanCollection({ swagger: '2.0' })).toBe(false);
      expect(isPostmanCollection({ info: { title: 'Test' } })).toBe(false);
    });
  });

  describe('parsePostmanCollectionText', () => {
    it('throws PostmanError on invalid JSON', () => {
      expect(() => parsePostmanCollectionText('{ invalid json')).toThrow(PostmanError);
    });

    it('throws PostmanError if JSON is not a collection', () => {
      expect(() => parsePostmanCollectionText('{"hello": "world"}')).toThrow(PostmanError);
    });

    it('parses valid collection text and normalizes variables and paths', () => {
      const json = JSON.stringify({
        info: {
          name: 'Test Collection {{env}}',
          description: 'A test description',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            name: 'Get User',
            request: {
              method: 'GET',
              url: '{{baseUrl}}/users/:id',
              header: [
                {
                  key: 'X-Custom-Header',
                  value: '{{headerVal}}',
                },
              ],
            },
          },
        ],
      });

      const parsed = parsePostmanCollectionText(json);
      expect(parsed.info.name).toBe('Test Collection ${env}');
      expect(parsed.info.description).toBe('A test description');
      expect(parsed.item).toHaveLength(1);
      const req = parsed.item[0]?.request;
      expect(typeof req).toBe('object');
      if (typeof req === 'object' && req !== null) {
        expect(req.url).toEqual({ raw: '${baseUrl}/users/{id}' });
        expect(req.header).toEqual([{ key: 'X-Custom-Header', value: '${headerVal}' }]);
      }
    });
  });
});
