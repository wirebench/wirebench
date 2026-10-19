import { describe, expect, it } from 'vitest';
import { blankModuleMarkers } from '../../../src/script/module-syntax.js';

describe('blankModuleMarkers', () => {
  it('blanks an export {} line with or without its semicolon, padded by spaces and tabs', () => {
    expect(blankModuleMarkers('export {};\n\t export{ }  \t\nx();')).toBe('\n\nx();');
  });

  it('keeps the line count and the line ends, CRLF included', () => {
    expect(blankModuleMarkers('export {};\r\nx();\r\n')).toBe('\r\nx();\r\n');
  });

  it('leaves a line with anything else on it', () => {
    const text = 'export { a };\nexport {}; x();\n// export {};\nconst s = "export {};";';
    expect(blankModuleMarkers(text)).toBe(text);
  });

  it('stays fast on a long run of tabs after the marker', () => {
    const text = `export {}${'\t'.repeat(100_000)}x`;
    const started = performance.now();
    expect(blankModuleMarkers(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
