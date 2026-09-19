import { describe, expect, it } from 'vitest';
import { citedImages, compareImages } from './check-docs-images.ts';

describe('citedImages', () => {
  it('reads Markdown images and HTML src attributes under the site base', () => {
    const page = [
      '![The picker](/wirebench/images/getting-started/workspace-picker.png)',
      '<img src="/wirebench/images/rest-client/rest-response.png" alt="" />',
      '[A page, not an image](/wirebench/guides/rest-client/)',
    ].join('\n');
    expect(citedImages(page)).toEqual(['getting-started/workspace-picker.png', 'rest-client/rest-response.png']);
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
