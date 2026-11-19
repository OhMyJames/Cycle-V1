import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useI18n } from "./i18n.tsx";

type Choice = {
  const: string;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
};

type Property = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: Choice[];
  default?: string;
};

type Option = {
  value: string;
  label: string;
  description?: string | undefined;
  recommended?: boolean;
};

/** Marks the choice the agent suggests, in a choice's `_meta`. Mirrors `META.recommended` of `@cycle/protocol`, which the page may not import. */
const RECOMMENDED = "cycle/recommended";

/** A property's values, with a name and a line on each when the schema gives them (`oneOf`). */
export const optionsOf = (property: Property): Option[] | undefined => {
  if (Array.isArray(property.oneOf)) {
    return property.oneOf
      .filter((c) => typeof c?.const === "string")
      .map((c) => ({
        value: c.const,
        label: c.title ?? c.const,
        description: c.description,
        recommended: c._meta?.[RECOMMENDED] === true,
      }));
  }
  return property.enum?.map((v) => ({ value: v, label: v }));
};

/** The settings an agent says it has, from its JSON Schema: a choice if it lists values, else text. */
export const propertiesOf = (schema: Record<string, unknown>): [string, Property][] => {
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  return Object.entries(properties).filter(([, p]) => p.type === undefined || p.type === "string");
};

export type ConfigFormProps = {
  schema: Record<string, unknown>;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /**
   * Whether a setting with no value shows the schema's `default`. True for what a new session will
   * get; false for a session that exists, whose unknown setting is not necessarily today's default.
   */
  defaults?: boolean;
};

export function ConfigForm({ schema, value, onChange, defaults = true }: ConfigFormProps) {
  const { t } = useI18n();
  const set = (key: string, next: string | null) => {
    const { [key]: _old, ...rest } = value;
    onChange(next === null || next === "" ? rest : { ...rest, [key]: next });
  };
  const properties = propertiesOf(schema);
  if (properties.length === 0) return <p data-slot="hint">This agent has nothing to set.</p>;
  return (
    <div data-slot="config-form">
      {properties.map(([key, property]) => {
        const options = optionsOf(property);
        const current = value[key] ?? (defaults ? property.default : undefined) ?? null;
        const chosen = options?.find((o) => o.value === current)?.description;
        return (
          <Field key={key} name={key}>
            <FieldLabel>{property.title ?? key}</FieldLabel>
            {options !== undefined ? (
              <Select
                items={options.map((o) => ({ value: o.value, label: o.label }))}
                value={current}
                placeholder={t("config.notSet")}
                onValueChange={(next) => set(key, next as string | null)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      <span data-slot="option">
                        <span data-slot="option-name">
                          {o.label}
                          {o.recommended ? (
                            <span data-slot="option-tag">{t("config.recommended")}</span>
                          ) : null}
                        </span>
                        {o.description ? (
                          <span data-slot="option-description">{o.description}</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={value[key] ?? ""}
                placeholder={property.default ?? ""}
                onChange={(event) => set(key, event.currentTarget.value)}
              />
            )}
            {property.description ? (
              <FieldDescription>{property.description}</FieldDescription>
            ) : null}
            {chosen ? <FieldDescription>{chosen}</FieldDescription> : null}
          </Field>
        );
      })}
    </div>
  );
}
