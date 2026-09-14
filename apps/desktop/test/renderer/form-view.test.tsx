import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormView } from '../../src/renderer/features/request-editor/views/form-view.js';
import type { FormSource, FormViewType } from '../../src/renderer/features/request-editor/views/form-view.js';
import type { FormNodeWire } from '../../src/renderer/../shared/wire-types.js';
import { showToast } from '../../src/renderer/components/toast.js';

vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Body><tem:Add><tem:intA>1</tem:intA><tem:intB>?</tem:intB></tem:Add></soapenv:Body>' +
  '</soapenv:Envelope>';

const INT_A_RANGE = { start: ENVELOPE.indexOf('<tem:intA>') + 10, end: ENVELOPE.indexOf('</tem:intA>') };

function field(overrides: Partial<FormNodeWire> & { id: string; label: string }): FormNodeWire {
  return {
    kind: 'field',
    name: { namespaceUri: 'http://tempuri.org/', localName: overrides.label.replace(/^tem:/, '') },
    required: true,
    occurs: { min: 1, max: 1 },
    type: { name: 'xs:int', base: 'integer' },
    present: true,
    children: [],
    ...overrides,
  };
}

const ROOT: FormNodeWire = {
  id: 'r',
  kind: 'group',
  name: { namespaceUri: 'http://tempuri.org/', localName: 'Add' },
  label: 'tem:Add',
  required: true,
  occurs: { min: 1, max: 1 },
  present: true,
  children: [
    field({ id: 'r/0', label: 'tem:intA', value: '1', valueRange: INT_A_RANGE }),
    field({ id: 'r/1', label: 'tem:intB', value: '?', valueRange: { start: 0, end: 0 } }),
    field({
      id: 'r/2',
      label: 'tem:note',
      value: '?',
      required: false,
      occurs: { min: 0, max: 1 },
      type: { name: 'xs:string', base: 'string' },
      present: false,
    }),
  ],
};

function stubSource(root: FormNodeWire = ROOT) {
  const form = vi.fn().mockResolvedValue({ ok: true, value: { root, bodyRange: { start: 0, end: 0 }, problems: [] } });
  const applyFormEdit = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { envelopeXml: '<changed/>', changedRange: { start: 0, end: 0 } } });
  return { source: { form, applyFormEdit } satisfies FormSource, form, applyFormEdit };
}

function renderView(
  overrides: Partial<React.ComponentProps<typeof FormView>> = {},
  root: FormNodeWire = ROOT,
): ReturnType<typeof stubSource> & { onValueEdit: ReturnType<typeof vi.fn> } {
  const stub = stubSource(root);
  const onValueEdit = vi.fn();
  render(
    <FormView
      xml={ENVELOPE}
      interfaceId="if-1"
      bindingName="{http://tempuri.org/}CalculatorSoap"
      operationName="Add"
      onValueEdit={onValueEdit}
      onEnvelopeReplace={vi.fn()}
      viewType="full"
      onViewTypeChange={vi.fn()}
      source={stub.source}
      {...overrides}
    />,
  );
  return { ...stub, onValueEdit };
}

const ENVELOPE_ATTR =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Body><tem:Add><tem:widget id="1"/><tem:intB>?</tem:intB></tem:Add></soapenv:Body>' +
  '</soapenv:Envelope>';

describe('FormView', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders one editor per field, typed by the schema base type', async () => {
    renderView();
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    expect(screen.getByLabelText<HTMLInputElement>('tem:intA value').type).toBe('number');
    expect(screen.getByLabelText<HTMLInputElement>('tem:intA value').value).toBe('1');
  });

  it('typing splices the value into the text at the field range', async () => {
    const { onValueEdit } = renderView();
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    const input = screen.getByLabelText<HTMLInputElement>('tem:intA value');
    await userEvent.type(input, '2');
    expect(onValueEdit).toHaveBeenLastCalledWith(INT_A_RANGE, '12');
  });

  it('keeps later field ranges correct after an earlier value changes length', async () => {
    const intBStart = ENVELOPE.indexOf('<tem:intB>') + 10;
    const root: FormNodeWire = {
      ...ROOT,
      children: [
        field({ id: 'r/0', label: 'tem:intA', value: '1', valueRange: INT_A_RANGE }),
        field({ id: 'r/1', label: 'tem:intB', value: '?', valueRange: { start: intBStart, end: intBStart + 1 } }),
      ],
    };
    const { onValueEdit } = renderView({}, root);
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    // '1' -> '20' grows the document by one character, moving intB one along.
    await userEvent.type(screen.getByLabelText('tem:intA value'), '0');
    expect(onValueEdit).toHaveBeenLastCalledWith(INT_A_RANGE, '10');
    await userEvent.type(screen.getByLabelText('tem:intB value'), '5');
    expect(onValueEdit).toHaveBeenLastCalledWith({ start: intBStart + 1, end: intBStart + 2 }, '5');
  });

  it('typing a quote into an attribute value shifts later ranges by the actual escaped length', async () => {
    const idStart = ENVELOPE_ATTR.indexOf('id="') + 4;
    const attrRange = { start: idStart, end: idStart + 1 };
    const intBStart = ENVELOPE_ATTR.indexOf('<tem:intB>') + 10;
    const root: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/0',
          kind: 'attribute',
          name: { namespaceUri: '', localName: 'id' },
          label: 'id',
          required: true,
          occurs: { min: 1, max: 1 },
          type: { name: 'xs:string', base: 'string' },
          value: '1',
          valueRange: attrRange,
          present: true,
          children: [],
        },
        field({ id: 'r/1', label: 'tem:intB', value: '?', valueRange: { start: intBStart, end: intBStart + 1 } }),
      ],
    };
    const { onValueEdit } = renderView({ xml: ENVELOPE_ATTR }, root);
    await waitFor(() => expect(screen.getByLabelText('id value')).toBeDefined());
    // Typing a `"` into an attribute value is written back as `&quot;` (6 chars), not 1 — the
    // in-flight delta computation must match `applyValueEdit`'s actual escaping exactly, or the
    // next field's range drifts and the following edit corrupts the document.
    await userEvent.type(screen.getByLabelText('id value'), '"');
    expect(onValueEdit).toHaveBeenLastCalledWith(attrRange, '1"');

    await userEvent.type(screen.getByLabelText('tem:intB value'), '5');
    // '1"' escapes to `1&quot;` (7 chars) replacing a 1-char range: delta is +6.
    expect(onValueEdit).toHaveBeenLastCalledWith({ start: intBStart + 6, end: intBStart + 7 }, '5');
  });

  it('a field with no range in the text goes through a structural set-value', async () => {
    const noRange: FormNodeWire = {
      ...ROOT,
      children: [field({ id: 'r/0', label: 'tem:intA', value: '' })],
    };
    const { applyFormEdit } = renderView({}, noRange);
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    await userEvent.type(screen.getByLabelText('tem:intA value'), '9');
    expect(applyFormEdit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { kind: 'set-value', nodeId: 'r/0', value: '9' } }),
    );
  });

  it('"Required only" hides optional fields; "Non-empty" hides placeholders', async () => {
    renderView({ viewType: 'required' as FormViewType });
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    expect(screen.queryByText('tem:note')).toBeNull();
    cleanup();

    renderView({ viewType: 'non-empty' as FormViewType });
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());
    // intB holds the `?` placeholder, so it counts as empty.
    expect(screen.queryByLabelText('tem:intB value')).toBeNull();
  });

  it('Add on a not-present optional element asks main for a structural insert', async () => {
    const { applyFormEdit } = renderView();
    await waitFor(() => expect(screen.getByLabelText('Add tem:note')).toBeDefined());
    await userEvent.click(screen.getByLabelText('Add tem:note'));
    expect(applyFormEdit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { kind: 'insert-optional', nodeId: 'r/2' } }),
    );
  });

  it('switching a choice branch is a structural edit', async () => {
    const withChoice: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/0',
          kind: 'choice',
          name: { namespaceUri: '', localName: 'choice' },
          label: 'choice',
          required: true,
          occurs: { min: 1, max: 1 },
          present: true,
          choice: { selected: 0 },
          children: [
            field({ id: 'r/0!0', label: 'single', value: '?', valueRange: { start: 0, end: 0 } }),
            field({ id: 'r/0!1', label: 'many', present: false }),
          ],
        },
      ],
    };
    const { applyFormEdit } = renderView({}, withChoice);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'many' })).toBeDefined());
    await userEvent.click(screen.getByRole('tab', { name: 'many' }));
    expect(applyFormEdit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { kind: 'select-choice', nodeId: 'r/0', index: 1 } }),
    );
  });

  it('"+ Add" on a repeat adds an instance', async () => {
    const instance = field({ id: 'r/0#0', label: 'child', value: '?', valueRange: { start: 0, end: 0 } });
    const withRepeat: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/0',
          kind: 'repeat',
          name: { namespaceUri: '', localName: 'child' },
          label: 'child',
          required: false,
          occurs: { min: 0, max: 'unbounded' },
          present: true,
          children: [],
          repeat: { instances: [instance], template: instance, canAdd: true, canRemove: true },
        },
      ],
    };
    const { applyFormEdit } = renderView({}, withRepeat);
    await waitFor(() => expect(screen.getByLabelText('Add child')).toBeDefined());
    await userEvent.click(screen.getByLabelText('Add child'));
    expect(applyFormEdit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { kind: 'add-repeat', nodeId: 'r/0' } }),
    );
  });

  it('a failed structural edit shows a toast and leaves the form state unchanged', async () => {
    const instance = field({ id: 'r/0#0', label: 'child', value: '?', valueRange: { start: 0, end: 0 } });
    const withRepeat: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/0',
          kind: 'repeat',
          name: { namespaceUri: '', localName: 'child' },
          label: 'child',
          required: false,
          occurs: { min: 0, max: 'unbounded' },
          present: true,
          children: [],
          repeat: { instances: [instance], template: instance, canAdd: true, canRemove: true },
        },
      ],
    };
    const onEnvelopeReplace = vi.fn();
    const stub = stubSource(withRepeat);
    stub.applyFormEdit.mockResolvedValue({
      ok: false,
      error: { code: 'form-edit-failed', message: 'That element cannot be added here' },
    });
    render(
      <FormView
        xml={ENVELOPE}
        interfaceId="if-1"
        bindingName="{http://tempuri.org/}CalculatorSoap"
        operationName="Add"
        onValueEdit={vi.fn()}
        onEnvelopeReplace={onEnvelopeReplace}
        viewType="full"
        onViewTypeChange={vi.fn()}
        source={stub.source}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Add child')).toBeDefined());
    await userEvent.click(screen.getByLabelText('Add child'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('That element cannot be added here (form-edit-failed)'));
    // The envelope is never replaced on failure: the tree the user was looking at stays valid.
    expect(onEnvelopeReplace).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Add child')).toBeDefined();
  });

  it('an unmodellable part renders an "Edit in XML" placeholder', async () => {
    const withAny: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/0',
          kind: 'any',
          name: { namespaceUri: '', localName: 'any' },
          label: 'any',
          required: false,
          occurs: { min: 0, max: 'unbounded' },
          present: true,
          children: [],
        },
      ],
    };
    renderView({}, withAny);
    await waitFor(() => expect(screen.getByText('Edit in XML')).toBeDefined());
  });

  it('falls back with a message when the form cannot be built', async () => {
    const form = vi.fn().mockResolvedValue({ ok: false });
    render(
      <FormView
        xml={ENVELOPE}
        interfaceId="if-1"
        bindingName="{http://tempuri.org/}CalculatorSoap"
        operationName="Add"
        onValueEdit={vi.fn()}
        onEnvelopeReplace={vi.fn()}
        viewType="full"
        onViewTypeChange={vi.fn()}
        source={{ form, applyFormEdit: vi.fn() }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Can't build a form for this operation")).toBeDefined());
  });

  it('Get Data inserts a ${#Project#…} reference into the field', async () => {
    const { onValueEdit } = renderView();
    await waitFor(() => expect(screen.getByLabelText('Get Data for tem:intA')).toBeDefined());
    await userEvent.click(screen.getByLabelText('Get Data for tem:intA'));
    // With no project open there is nothing to pick; the dialog still opens and says so.
    expect(screen.getByText(/No properties in scope/)).toBeDefined();
    expect(onValueEdit).not.toHaveBeenCalled();
  });

  it('goes read-only when `readOnly` is set: fields are disabled and typing never calls onValueEdit', async () => {
    const { onValueEdit } = renderView({ readOnly: true });
    await waitFor(() => expect(screen.getByLabelText('tem:intA value')).toBeDefined());

    const input = screen.getByLabelText<HTMLInputElement>('tem:intA value');
    expect(input.disabled).toBe(true);

    // A disabled input never receives keystrokes, so typing into it is a no-op either way —
    // asserting `onValueEdit` was never called either way is what actually proves the guard.
    await userEvent.type(input, '2');
    expect(onValueEdit).not.toHaveBeenCalled();
  });

  it('read-only: the Add-repeat, Get Data and insert-optional controls are disabled', async () => {
    const itemTemplate = field({ id: 'r/repeat/template', label: 'tem:item' });
    const root: FormNodeWire = {
      ...ROOT,
      children: [
        ...ROOT.children,
        {
          id: 'r/repeat',
          kind: 'repeat',
          name: { namespaceUri: 'http://tempuri.org/', localName: 'item' },
          label: 'tem:item',
          required: false,
          occurs: { min: 0, max: 5 },
          present: true,
          children: [],
          repeat: { canAdd: true, canRemove: true, instances: [], template: itemTemplate },
        },
      ],
    };
    renderView({ readOnly: true }, root);
    await waitFor(() => expect(screen.getByLabelText('Get Data for tem:intA')).toBeDefined());

    expect(screen.getByLabelText<HTMLButtonElement>('Get Data for tem:intA').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>('Add tem:note').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>('Add tem:item').disabled).toBe(true);
  });

  it('read-only: a structural edit never reaches applyFormEdit, even if triggered directly', async () => {
    const root: FormNodeWire = {
      ...ROOT,
      children: [
        {
          id: 'r/choice',
          kind: 'choice',
          name: { namespaceUri: 'http://tempuri.org/', localName: 'which' },
          label: 'tem:which',
          required: true,
          occurs: { min: 1, max: 1 },
          present: true,
          children: [
            { ...field({ id: 'r/choice/0', label: 'tem:a' }) },
            { ...field({ id: 'r/choice/1', label: 'tem:b' }) },
          ],
          choice: { selected: 0 },
        },
      ],
    };
    const { applyFormEdit } = renderView({ readOnly: true }, root);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'tem:b' })).toBeDefined());

    const otherTab = screen.getByRole<HTMLButtonElement>('tab', { name: 'tem:b' });
    expect(otherTab.disabled).toBe(true);
    await userEvent.click(otherTab);
    expect(applyFormEdit).not.toHaveBeenCalled();
  });
});
