import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";

type Property = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: string;
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
};

export function ConfigForm({ schema, value, onChange }: ConfigFormProps) {
  const set = (key: string, next: string | null) => {
    const { [key]: _old, ...rest } = value;
    onChange(next === null || next === "" ? rest : { ...rest, [key]: next });
  };
  const properties = propertiesOf(schema);
  if (properties.length === 0) return <p data-slot="hint">This agent has nothing to set.</p>;
  return (
    <div data-slot="config-form">
      {properties.map(([key, property]) => (
        <Field key={key} name={key}>
          <FieldLabel>{property.title ?? key}</FieldLabel>
          {property.enum !== undefined ? (
            <Select
              items={property.enum.map((v) => ({ value: v, label: v }))}
              value={value[key] ?? property.default ?? null}
              onValueChange={(next) => set(key, next as string | null)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {property.enum.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
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
        </Field>
      ))}
    </div>
  );
}
