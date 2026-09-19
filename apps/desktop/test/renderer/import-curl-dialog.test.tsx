import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCurlDialog } from '../../src/renderer/features/request-editor/import-curl-dialog.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

const SOAP_TARGET = {
  kind: 'soap' as const,
  interfaceId: 'if-1',
  bindingName: '{http://tempuri.org/}CalculatorSoap',
  operationName: 'Add',
};

const COMMAND = [
  "curl --request POST 'http://imported.test/calc.asmx' \\",
  "  --header 'Content-Type: text/xml; charset=utf-8' \\",
  '  --header \'SOAPAction: "http://tempuri.org/Add"\' \\',
  '  -u alice:s3cret \\',
  "  --data-binary @- <<'EOF'",
  '<Envelope/>',
  'EOF',
].join('\n');

describe('ImportCurlDialog', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.setState({ requests: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('previews the parsed endpoint, SOAPAction, header names and problems', async () => {
    installWirebenchApi();
    render(<ImportCurlDialog open onOpenChange={vi.fn()} target={SOAP_TARGET} />);

    await userEvent.click(screen.getByLabelText('cURL command'));
    await userEvent.paste(COMMAND);

    expect(screen.getByText('http://imported.test/calc.asmx')).toBeDefined();
    expect(screen.getByText('http://tempuri.org/Add')).toBeDefined();
    expect(screen.getByText('Content-Type, SOAPAction')).toBeDefined();
    // The preview names the dropped credential without echoing it (the pasted text itself
    // stays in the textarea, where the user put it).
    const problems = screen.getByRole('list', { name: 'Import problems' });
    expect(problems.textContent).toBe(
      'The -u credentials are not imported into a SOAP request; set auth on the Auth tab',
    );
    expect(problems.textContent).not.toContain('s3cret');
  });

  it('previews a REST import as the request it will make, without SOAP fields or SOAP problems', async () => {
    installWirebenchApi();
    render(<ImportCurlDialog open onOpenChange={vi.fn()} target={{ kind: 'rest', apiId: 'api-1' }} />);

    await userEvent.click(screen.getByLabelText('cURL command'));
    await userEvent.paste(
      "curl -XPUT https://api.test/pets/7 -H 'Authorization: Bearer tok' -u ada:hunter2 -d @pet.json",
    );

    const preview = screen.getByTestId('import-curl-preview');
    expect(preview.textContent).toContain('PUT https://api.test/pets/7');
    expect(preview.textContent).toContain('Authorization');
    expect(preview.textContent).toContain('file');
    expect(preview.textContent).toContain('Basic, as “ada”');
    expect(preview.textContent).not.toContain('SOAPAction');
    expect(preview.textContent).not.toContain('hunter2');
    expect(preview.textContent).not.toContain('tok');
    expect(screen.queryByRole('list', { name: 'Import problems' })).toBeNull();
  });

  it('imports through request.importCurl and opens the new request', async () => {
    const importCurl = vi.fn().mockResolvedValue({ ok: true, value: { requestId: 'req-2', problems: [] } });
    const snapshot = vi.fn().mockResolvedValue({ ok: true, value: { project: null } });
    installWirebenchApi({ request: { importCurl }, project: { snapshot } });
    // `refresh()` reloads from main; the mirror below stands in for the snapshot it would apply.
    useProjectStore.setState({ requests: { 'req-2': makeDraft({ id: 'req-2', name: 'Imported' }) } });
    const onOpenChange = vi.fn();
    render(<ImportCurlDialog open onOpenChange={onOpenChange} target={SOAP_TARGET} />);

    await userEvent.click(screen.getByLabelText('cURL command'));
    await userEvent.paste(COMMAND);
    await userEvent.click(screen.getByTestId('import-curl-submit'));

    expect(importCurl).toHaveBeenCalledWith({ command: COMMAND, target: SOAP_TARGET });
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['request:req-2']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot be submitted with an empty command', () => {
    installWirebenchApi();
    render(<ImportCurlDialog open onOpenChange={vi.fn()} target={SOAP_TARGET} />);

    expect(screen.getByTestId('import-curl-submit').hasAttribute('disabled')).toBe(true);
  });
});
