/** The Params tab's wording and its list of the URL's `${…}` variables (G09). */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { VariableAssistContext, type VariableAssist } from '../../src/renderer/components/variable-field.js';
import type { RequestVariables } from '../../src/renderer/editor/variable-assist.js';
import { ParamsTab } from '../../src/renderer/features/rest-editor/params-tab.js';
import { urlVariableRows } from '../../src/renderer/features/rest-editor/url-variables.js';

const variables: RequestVariables = {
  entries: [
    {
      name: 'host',
      scope: 'Env',
      value: 'dev.example',
      masked: false,
      shadowed: false,
      edit: { kind: 'environment', id: 'e1' },
    },
  ],
  secretNames: ['api_key'],
};

describe('urlVariableRows (G09)', () => {
  it('lists each reference once, with where it resolves and its value', () => {
    const rows = urlVariableRows('https://${host}/a/${host}?k=${secret:api_key}&m=${missing}', variables);
    expect(rows.map((row) => row.raw)).toEqual(['${host}', '${secret:api_key}', '${missing}']);
    expect(rows[0]).toMatchObject({ value: 'dev.example', unresolved: false });
    expect(rows[0]?.source).not.toBe('Unresolved');
    expect(rows[1]).toMatchObject({ source: 'Secret', unresolved: false });
    expect(rows[1]?.value).not.toContain('api_key');
    expect(rows[2]).toMatchObject({ source: 'Unresolved', unresolved: true });
  });

  it('says only a send can tell before the variables have arrived', () => {
    expect(urlVariableRows('https://${host}/', undefined)).toEqual([
      { raw: '${host}', source: 'Resolved when sent', value: '', unresolved: false },
    ]);
  });

  it('lists nothing for a URL with path parameters only', () => {
    expect(urlVariableRows('https://api.test/pets/{id}', variables)).toEqual([]);
  });
});

describe('ParamsTab (G09)', () => {
  afterEach(() => {
    cleanup();
  });

  const assist: VariableAssist = { variables, setAsVariable: () => {}, openEdit: () => {} };

  it('names the path-parameter syntax when there are none', () => {
    render(<ParamsTab url="https://${host}/pets" pathParams={[]} query={[]} onChange={() => {}} />);
    expect(screen.getByText('No path parameters like {id} in this URL.')).toBeDefined();
  });

  it('lists the URL variables and where each resolves', () => {
    render(
      <VariableAssistContext.Provider value={assist}>
        <ParamsTab url="https://${host}/pets" pathParams={[]} query={[]} onChange={() => {}} />
      </VariableAssistContext.Provider>,
    );
    const list = screen.getByTestId('rest-url-variables');
    const [row] = within(list).getAllByTestId('rest-url-variable');
    expect(row?.textContent).toContain('${host}');
    expect(row?.textContent).toContain('dev.example');
  });

  it('shows no variable list for a URL without variables', () => {
    render(<ParamsTab url="https://api.test/pets" pathParams={[]} query={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('rest-url-variables')).toBeNull();
  });
});
