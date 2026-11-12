import type { WorkflowSchemaField, WorkflowSchemaFieldType, WorkflowSchemaItemType } from "@/shared/lib/types";
import { SCHEMA_FIELD_NAME_PATTERN, SCHEMA_FIELD_TYPES, SCHEMA_ITEM_TYPES } from "./consts";

/**
 * The structured-output builder's model: an llm step's `json_schema` as a
 * flat list of fields (name, type, description, required) and back. A text
 * field may list the values it allows (`enum`), and a list field may say what
 * its items are (`items: {type}`) — the two things replies ask for most.
 * Anything richer (nested properties, `$ref`, item objects, titles…) returns
 * null, and the builder leaves it to the JSON editor rather than silently
 * dropping what it can't show.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const TYPES = new Set<string>(SCHEMA_FIELD_TYPES);
const ITEM_TYPES = new Set<string>(SCHEMA_ITEM_TYPES);
const ROOT_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_KEYS = new Set(["type", "description", "enum", "items"]);

/** One property as a builder field, or null when it says more than the builder can show. */
function propertyToField(name: string, property: unknown, required: boolean): WorkflowSchemaField | null {
  if (!isRecord(property) || Object.keys(property).some((key) => !PROPERTY_KEYS.has(key))) return null;
  if (typeof property.type !== "string" || !TYPES.has(property.type)) return null;
  if (property.description !== undefined && typeof property.description !== "string") return null;
  const field: WorkflowSchemaField = {
    name,
    type: property.type as WorkflowSchemaFieldType,
    description: property.description ?? "",
    required,
  };
  if (property.enum !== undefined) {
    const values = property.enum;
    if (property.type !== "string" || !Array.isArray(values) || !values.length) return null;
    if (values.some((value) => typeof value !== "string")) return null;
    field.options = values as string[];
  }
  if (property.items !== undefined) {
    const items = property.items;
    if (property.type !== "array" || !isRecord(items)) return null;
    if (Object.keys(items).some((key) => key !== "type")) return null;
    if (typeof items.type !== "string" || !ITEM_TYPES.has(items.type)) return null;
    field.itemType = items.type as WorkflowSchemaItemType;
  }
  return field;
}

/** The schema as builder fields, or null when it says more than the builder can (empty: no fields yet). */
export function schemaToFields(schema: unknown): WorkflowSchemaField[] | null {
  if (schema === undefined || schema === null) return [];
  if (!isRecord(schema)) return null;
  if (Object.keys(schema).some((key) => !ROOT_KEYS.has(key))) return null;
  if (schema.type !== undefined && schema.type !== "object") return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;
  const properties = schema.properties ?? {};
  if (!isRecord(properties)) return null;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !(name in properties))) return null;
  const fields: WorkflowSchemaField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = propertyToField(name, property, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

/** One field as its JSON Schema property: the type, then its allowed values or item type, then its description. */
function fieldToProperty(field: WorkflowSchemaField): Record<string, unknown> {
  const property: Record<string, unknown> = { type: field.type };
  const options = (field.options ?? []).map((value) => value.trim()).filter(Boolean);
  if (field.type === "string" && options.length) property.enum = [...new Set(options)];
  if (field.type === "array" && field.itemType) property.items = { type: field.itemType };
  if (field.description.trim()) property.description = field.description.trim();
  return property;
}

/**
 * The fields as the schema the engine asks the model for: an object of
 * exactly these properties. A row with no name yet is left out; a repeated
 * name keeps its first row (the builder flags the rest).
 */
export function fieldsToSchema(fields: readonly WorkflowSchemaField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    const name = field.name.trim();
    if (!name || name in properties) continue;
    properties[name] = fieldToProperty(field);
    if (field.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** Why a builder row's name can't be used (or null): empty, not an identifier, or a repeat. */
export function schemaFieldNameProblem(fields: readonly WorkflowSchemaField[], index: number): string | null {
  const name = fields[index]?.name.trim() ?? "";
  if (!name) return "Name this field.";
  if (!SCHEMA_FIELD_NAME_PATTERN.test(name)) return "Letters, digits and _ only, not starting with a digit.";
  if (fields.findIndex((field) => field.name.trim() === name) !== index) return `'${name}' is used twice.`;
  return null;
}
