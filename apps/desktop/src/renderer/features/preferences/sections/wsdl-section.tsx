import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/**
 * WSDL import and request-generation defaults. `sampleValues`/`typeComments`/`includeOptional`
 * are the `GenerateOptions` every generate, recreate and Form insert passes to the engine;
 * `cacheDefinitions` is the default for a newly imported interface.
 */
export function WsdlSection({ preferences, update }: SectionProps) {
  const wsdl = preferences.wsdl;
  return (
    <>
      <SettingsGroup title="Definitions">
        <BooleanSetting
          label="Cache definitions"
          value={wsdl.cacheDefinitions}
          onChange={(cacheDefinitions) => update({ wsdl: { cacheDefinitions } })}
          hint="Default for a newly imported interface."
        />
        <BooleanSetting
          label="Compress the cache"
          value={wsdl.compression}
          onChange={(compression) => update({ wsdl: { compression } })}
        />
        <BooleanSetting
          label="Strict schema handling"
          value={wsdl.strictSchema}
          onChange={(strictSchema) => update({ wsdl: { strictSchema } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Generated requests">
        <BooleanSetting
          label="Sample values"
          value={wsdl.sampleValues}
          onChange={(sampleValues) => update({ wsdl: { sampleValues } })}
          hint="Fill leaves with schema-derived samples instead of ? placeholders."
        />
        <BooleanSetting
          label="Type comments"
          value={wsdl.typeComments}
          onChange={(typeComments) => update({ wsdl: { typeComments } })}
        />
        <BooleanSetting
          label="Include optional elements"
          value={wsdl.includeOptional}
          onChange={(includeOptional) => update({ wsdl: { includeOptional } })}
        />
        <BooleanSetting
          label="Pretty print"
          value={wsdl.prettyPrint}
          onChange={(prettyPrint) => update({ wsdl: { prettyPrint } })}
        />
        <BooleanSetting
          label="Name requests with the binding"
          value={wsdl.nameWithBinding}
          onChange={(nameWithBinding) => update({ wsdl: { nameWithBinding } })}
        />
      </SettingsGroup>
    </>
  );
}
