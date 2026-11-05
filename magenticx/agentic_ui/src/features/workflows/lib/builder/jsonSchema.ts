import type { WorkflowSchemaField, WorkflowSchemaFieldType } from "@/shared/lib/types";
import { SCHEMA_FIELD_NAME_PATTERN, SCHEMA_FIELD_TYPES } from "./consts";

/**
 * The structured-output builder's model: an llm step's `json_schema` as a
 * flat list of fields (name, type, description, required) and back. Only a
 * flat object schema reads as fields; anything richer (nested properties,
 * `$ref`, enums, array items, titles…) returns null, and the builder leaves
 * it to the JSON editor rather than silently dropping what it can't show.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const TYPES = new Set<string>(SCHEMA_FIELD_TYPES);
const ROOT_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_KEYS = new Set(["type", "description"]);

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
    if (!isRecord(property) || Object.keys(property).some((key) => !PROPERTY_KEYS.has(key))) return null;
    if (typeof property.type !== "string" || !TYPES.has(property.type)) return null;
    if (property.description !== undefined && typeof property.description !== "string") return null;
    fields.push({
      name,
      type: property.type as WorkflowSchemaFieldType,
      description: property.description ?? "",
      required: required.includes(name),
    });
  }
  return fields;
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
    properties[name] = field.description.trim() ? { type: field.type, description: field.description.trim() } : { type: field.type };
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
