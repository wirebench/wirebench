import { describe, expect, it } from 'vitest';
import { SITES, citedImages, compareImages } from './check-docs-images.ts';

const DOCS_PREFIX = '/wirebench/docs/images/';
const SITE_PREFIX = '/wirebench/images/';

describe('citedImages', () => {
  it('reads Markdown images and HTML src attributes under the docs base', () => {
    const page = [
      '![The picker](/wirebench/docs/images/getting-started/workspace-picker.png)',
      '<img src="/wirebench/docs/images/rest-client/rest-response.png" alt="" />',
      '[A page, not an image](/wirebench/docs/guides/rest-client/)',
    ].join('\n');
    expect(citedImages(page, DOCS_PREFIX)).toEqual([
      'getting-started/workspace-picker.png',
      'rest-client/rest-response.png',
    ]);
  });

  it('finds an image a landing-site page cites under the site prefix', () => {
    const page = '<img src="/wirebench/images/home/response.png" alt="A response" />';
    expect(citedImages(page, SITE_PREFIX)).toEqual(['home/response.png']);
  });

  it('does not take a docs citation for a landing-site one', () => {
    const page = '![A response](/wirebench/docs/images/home/response.png)';
    expect(citedImages(page, SITE_PREFIX)).toEqual([]);
  });

  it('does not take a landing-site citation for a docs one', () => {
    const page = '<img src="/wirebench/images/home/response.png" alt="" />';
    expect(citedImages(page, DOCS_PREFIX)).toEqual([]);
  });

  it('treats the prefix literally, not as a pattern', () => {
    expect(citedImages('/wirebenchXimages/a.png', '/wirebench.images/')).toEqual([]);
  });
});

describe('SITES', () => {
  it('lists the user guide and the landing site', () => {
    expect(SITES.map((site) => site.name)).toEqual(['docs-site', 'site']);
  });

  it('keeps the docs-site layout', () => {
    expect(SITES[0]).toMatchObject({
      contentDir: 'docs-site/src/content/docs',
      imagesDir: 'docs-site/public/images',
      prefix: DOCS_PREFIX,
    });
    expect(SITES[0]!.pagePattern.test('guides/a.mdx')).toBe(true);
    expect(SITES[0]!.pagePattern.test('index.astro')).toBe(false);
  });

  it('reads the landing site from .astro pages', () => {
    expect(SITES[1]).toMatchObject({
      contentDir: 'site/src',
      imagesDir: 'site/public/images',
      prefix: SITE_PREFIX,
    });
    expect(SITES[1]!.pagePattern.test('pages/index.astro')).toBe(true);
    expect(SITES[1]!.pagePattern.test('guides/a.md')).toBe(false);
  });
});

describe('compareImages', () => {
  it('reports images a page cites that are not on disk', () => {
    expect(compareImages(['a.png', 'b.png'], ['a.png']).missing).toEqual(['b.png']);
  });

  it('reports images on disk that no page cites', () => {
    expect(compareImages(['a.png'], ['a.png', 'old.png']).orphaned).toEqual(['old.png']);
  });

  it('counts an image cited by two pages once', () => {
    expect(compareImages(['a.png', 'a.png'], ['a.png'])).toEqual({ missing: [], orphaned: [] });
  });
});
