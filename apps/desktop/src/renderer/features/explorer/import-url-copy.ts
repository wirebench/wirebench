import type { ImportDialogFormat } from '../../state/ui.js';

/** What the Import dialog's URL field is called and what it shows while empty. */
export interface ImportUrlCopy {
  /** The visible label, which is also the field's accessible name. */
  readonly label: string;
  readonly placeholder: string;
}

const DEFINITION = 'Definition URL or file';

/**
 * The URL field's copy for the format picked in the dialog. It follows the picked format rather
 * than the detected one, so the label does not change under the user while they type; under
 * Auto-detect it names no format at all.
 */
export function importUrlCopy(format: ImportDialogFormat): ImportUrlCopy {
  switch (format) {
    case 'wsdl':
      return { label: 'WSDL URL', placeholder: 'https://example.test/service?wsdl' };
    case 'openapi':
      return { label: DEFINITION, placeholder: 'https://example.test/openapi.json' };
    case 'asyncapi':
      return { label: DEFINITION, placeholder: 'https://example.test/asyncapi.yaml' };
    case 'proto':
      return { label: '.proto URL', placeholder: 'https://example.test/protos/service.proto' };
    case 'postman':
      return { label: 'Collection URL', placeholder: 'https://example.test/collection.json' };
    case 'legacy-soap-project':
      return { label: 'Project file URL', placeholder: 'https://example.test/project.xml' };
    case 'auto':
    default:
      return { label: DEFINITION, placeholder: 'https://example.test/openapi.json' };
  }
}
