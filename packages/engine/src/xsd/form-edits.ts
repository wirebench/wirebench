/**
 * Structural edits on a {@link FormNode} tree — everything the Form view cannot
 * express as a plain text splice into an existing value.
 *
 * Each edit returns a *new* tree (nothing is mutated), which the caller then
 * serialises with `applyForm` and splices back over the body element's range.
 * Because the tree is rebuilt from the document before every edit, an edit can
 * never operate on a stale shape.
 */

import type { FormNode } from './form-model.js';

/** One structural change the Form view can ask for, addressed by node id. */
export type FormEdit =
  /** Make an omitted optional element (or attribute) exist, filled with placeholders. */
  | { readonly kind: 'insert-optional'; readonly nodeId: string }
  /** Remove a present optional element (or attribute) again. */
  | { readonly kind: 'remove-optional'; readonly nodeId: string }
  /** Append one occurrence to a `repeat` node. */
  | { readonly kind: 'add-repeat'; readonly nodeId: string }
  /** Drop occurrence `index` of a `repeat` node. */
  | { readonly kind: 'remove-repeat'; readonly nodeId: string; readonly index: number }
  /** Switch a `choice` node to alternative `index`, replacing whatever stood there. */
  | { readonly kind: 'select-choice'; readonly nodeId: string; readonly index: number }
  /** Set a field/attribute value structurally (used when it is not present in the text yet). */
  | { readonly kind: 'set-value'; readonly nodeId: string; readonly value: string };

/** Applies `change` to the node with `id`, rebuilding only the spine above it. */
function mapNode(node: FormNode, id: string, change: (node: FormNode) => FormNode): FormNode {
  if (node.id === id) {
    return change(node);
  }
  const children = node.children.map((child) => mapNode(child, id, change));
  const instances = node.repeat?.instances.map((instance) => mapNode(instance, id, change));
  const childrenChanged = children.some((child, i) => child !== node.children[i]);
  const instancesChanged = instances?.some((instance, i) => instance !== node.repeat?.instances[i]) === true;
  if (!childrenChanged && !instancesChanged) {
    return node;
  }
  return {
    ...node,
    children,
    ...(node.repeat !== undefined && instances !== undefined ? { repeat: { ...node.repeat, instances } } : {}),
  };
}

/**
 * Marks a not-present subtree as present, so it serialises: the node itself,
 * every required descendant, and every attribute that must be written. Optional
 * descendants stay absent — the user adds them one at a time.
 */
function materialise(node: FormNode): FormNode {
  if (node.kind === 'repeat') {
    const repeat = node.repeat;
    if (repeat === undefined) {
      return node;
    }
    const instances = repeat.instances.length > 0 ? repeat.instances : [materialise(repeat.template)];
    return { ...node, present: true, repeat: { ...repeat, instances, canRemove: instances.length > node.occurs.min } };
  }
  if (node.kind === 'choice') {
    const selected = node.choice?.selected ?? 0;
    return {
      ...node,
      present: true,
      choice: { selected },
      children: node.children.map((child, i) => (i === selected ? materialise(child) : child)),
    };
  }
  return {
    ...node,
    present: true,
    children: node.children.map((child) => (child.required || child.kind === 'attribute' ? materialise(child) : child)),
  };
}

/** Clears a subtree's presence, so it disappears from the serialised fragment. */
function dematerialise(node: FormNode): FormNode {
  return { ...node, present: false };
}

/** Re-ids a template subtree so a newly added occurrence gets stable, unique ids. */
function reid(node: FormNode, id: string): FormNode {
  return {
    ...node,
    id,
    children: node.children.map((child, i) => reid(child, `${id}/${i}`)),
    ...(node.repeat !== undefined
      ? {
          repeat: {
            ...node.repeat,
            instances: node.repeat.instances.map((instance, i) => reid(instance, `${id}#${i}`)),
            template: reid(node.repeat.template, `${id}#t`),
          },
        }
      : {}),
  };
}

function addRepeat(node: FormNode): FormNode {
  const repeat = node.repeat;
  if (repeat === undefined || !repeat.canAdd) {
    return node;
  }
  const instances = [...repeat.instances, reid(materialise(repeat.template), `${node.id}#${repeat.instances.length}`)];
  const limit = node.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : node.occurs.max;
  return {
    ...node,
    present: true,
    repeat: {
      ...repeat,
      instances,
      canAdd: instances.length < limit,
      canRemove: instances.length > node.occurs.min,
    },
  };
}

function removeRepeat(node: FormNode, index: number): FormNode {
  const repeat = node.repeat;
  if (repeat === undefined || index < 0 || index >= repeat.instances.length) {
    return node;
  }
  const instances = repeat.instances
    .filter((_, i) => i !== index)
    .map((instance, i) => reid(instance, `${node.id}#${i}`));
  const limit = node.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : node.occurs.max;
  return {
    ...node,
    present: instances.length > 0,
    repeat: {
      ...repeat,
      instances,
      canAdd: instances.length < limit,
      canRemove: instances.length > node.occurs.min,
    },
  };
}

function selectChoice(node: FormNode, index: number): FormNode {
  if (index < 0 || index >= node.children.length) {
    return node;
  }
  return {
    ...node,
    present: true,
    choice: { selected: index },
    children: node.children.map((child, i) => (i === index ? materialise(child) : dematerialise(child))),
  };
}

/**
 * Applies one structural {@link FormEdit} to `form`, returning a new tree.
 *
 * Unknown node ids and impossible edits (adding past `maxOccurs`, removing
 * below `minOccurs`) are no-ops rather than errors: the renderer only ever
 * offers the affordances the tree says are available, and a stale click must
 * not fail a request.
 *
 * @param form the tree to change
 * @param edit what to change
 */
export function applyFormEdit(form: FormNode, edit: FormEdit): FormNode {
  switch (edit.kind) {
    case 'insert-optional':
      return mapNode(form, edit.nodeId, materialise);
    case 'remove-optional':
      return mapNode(form, edit.nodeId, dematerialise);
    case 'add-repeat':
      return mapNode(form, edit.nodeId, addRepeat);
    case 'remove-repeat':
      return mapNode(form, edit.nodeId, (node) => removeRepeat(node, edit.index));
    case 'select-choice':
      return mapNode(form, edit.nodeId, (node) => selectChoice(node, edit.index));
    case 'set-value':
      return mapNode(form, edit.nodeId, (node) => ({ ...node, present: true, value: edit.value }));
  }
}
