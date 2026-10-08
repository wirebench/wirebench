import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROJECT_SCHEMA_BASE_URL, projectJsonSchemas } from '../packages/engine/src/project-files.ts';
import { FORMAT_VERSION } from '../packages/engine/src/project/model.ts';
import { MARKERS, PAGE, renderEditorSettings } from './project-schemas.ts';
import { splice } from './docs-server-config.ts';

describe('project-schemas', () => {
  it('maps each schema to its files, matched wherever the project folder sits', () => {
    const settings = renderEditorSettings(projectJsonSchemas());
    const parsed = JSON.parse(settings.replace(/^```json\n|\n```$/g, '')) as {
      'yaml.schemas': Record<string, string[]>;
    };
    const mapping = parsed['yaml.schemas'];
    expect(mapping[`${PROJECT_SCHEMA_BASE_URL}/v${FORMAT_VERSION}/manifest.schema.json`]).toEqual([
      '**/wirebench.yaml',
    ]);
    expect(mapping[`${PROJECT_SCHEMA_BASE_URL}/v${FORMAT_VERSION}/golden.schema.json`]).toEqual(['**/*.golden.yaml']);
  });

  it('keeps the reference page in step with the schemas', async () => {
    const text = await readFile(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), 'utf-8');
    expect(splice(text, renderEditorSettings(projectJsonSchemas()), MARKERS)).toBe(text);
  });
});
