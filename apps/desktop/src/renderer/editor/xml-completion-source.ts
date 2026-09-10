import type { XmlCompletionCandidate, XmlCompletionSource } from './xml-language.js';

/** Builds an {@link XmlCompletionSource} backed by the `xml.completions` IPC channel. */
export function ipcCompletionSource(interfaceId: string): XmlCompletionSource {
  return {
    interfaceId,
    async fetchCompletions({ path, partial }) {
      const result = await window.wirebench.xml.completions({ interfaceId, path: [...path], partial });
      if (!result.ok) {
        return { items: [] };
      }
      const items: XmlCompletionCandidate[] = result.value.items.map((item) => ({
        name: item.name,
        namespaceUri: item.namespaceUri,
        ...(item.documentation !== undefined ? { documentation: item.documentation } : {}),
      }));
      return { items };
    },
  };
}
