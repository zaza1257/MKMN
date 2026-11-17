/**
 * A tiny runtime schema for step outputs, with no dependency (zod is not in the
 * lockfile, and the harness must not add one). Every step declares the schema its
 * output must satisfy; the run validates each attempt against it before the
 * validators see the value, and a schema fault is the first retry reason.
 *
 * Faults carry the path they were found at ("plan.files[2].title: expected a
 * string"), so the retry feedback can name the exact fault back to the model.
 */

export type CheckOk<T> = { ok: true; value: T };
export type CheckFail = { ok: false; errors: string[] };
export type Check<T> = CheckOk<T> | CheckFail;

export interface Schema<T> {
  /** What this schema accepts, for journal lines and retry feedback. */
  readonly describe: string;
  check(value: unknown, at?: string): Check<T>;
  /** The JSON-schema form, for the gateway's response_format rung. Absent only when no shape can be said. */
  readonly jsonSchema?: JsonShape;
}

/** The JSON-schema form of one schema. `optional` marks a field the object form leaves out of `required`. */
export interface JsonShape {
  shape: Record<string, unknown>;
  optional?: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fail = <T>(at: string, message: string): Check<T> => ({ ok: false, errors: [`${at}: ${message}`] });

export function sString(opts: { minLength?: number; maxLength?: number } = {}): Schema<string> {
  const { minLength, maxLength } = opts;
  const describe = `a string${minLength !== undefined ? ` of at least ${minLength} characters` : ""}${maxLength !== undefined ? ` of at most ${maxLength} characters` : ""}`;
  const shape: Record<string, unknown> = { type: "string" };
  if (minLength !== undefined) shape.minLength = minLength;
  if (maxLength !== undefined) shape.maxLength = maxLength;
  return {
    describe,
    jsonSchema: { shape },
    check(value, at = "value") {
      if (typeof value !== "string") return fail(at, `expected ${describe}, got ${typeof value}`);
      if (minLength !== undefined && value.length < minLength) return fail(at, `expected ${describe}, got ${value.length}`);
      if (maxLength !== undefined && value.length > maxLength) return fail(at, `expected ${describe}, got ${value.length}`);
      return { ok: true, value };
    },
  };
}

export function sNumber(opts: { min?: number; max?: number; int?: boolean } = {}): Schema<number> {
  const parts = ["a number"];
  if (opts.int) parts.push("a whole number");
  if (opts.min !== undefined) parts.push(`at least ${opts.min}`);
  if (opts.max !== undefined) parts.push(`at most ${opts.max}`);
  const describe = parts.join(", ");
  return {
    describe,
    jsonSchema: {
      shape: {
        type: opts.int ? "integer" : "number",
        ...(opts.min !== undefined ? { minimum: opts.min } : {}),
        ...(opts.max !== undefined ? { maximum: opts.max } : {}),
      },
    },
    check(value, at = "value") {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(at, `expected ${describe}, got ${JSON.stringify(value)}`);
      if (opts.int && !Number.isInteger(value)) return fail(at, `expected ${describe}, got ${value}`);
      if (opts.min !== undefined && value < opts.min) return fail(at, `expected ${describe}, got ${value}`);
      if (opts.max !== undefined && value > opts.max) return fail(at, `expected ${describe}, got ${value}`);
      return { ok: true, value };
    },
  };
}

export function sBoolean(): Schema<boolean> {
  return {
    describe: "true or false",
    jsonSchema: { shape: { type: "boolean" } },
    check(value, at = "value") {
      if (typeof value !== "boolean") return fail(at, `expected true or false, got ${JSON.stringify(value)}`);
      return { ok: true, value };
    },
  };
}

export function sEnum<E extends string>(name: string, values: readonly E[]): Schema<E> {
  const describe = `one of ${name} (${values.map((v) => JSON.stringify(v)).join(", ")})`;
  return {
    describe,
    jsonSchema: { shape: { type: "string", enum: [...values] } },
    check(value, at = "value") {
      if (typeof value !== "string" || !values.includes(value as E)) return fail(at, `expected ${describe}, got ${JSON.stringify(value)}`);
      return { ok: true, value: value as E };
    },
  };
}

export function sArray<T>(item: Schema<T>, opts: { minLength?: number; maxLength?: number } = {}): Schema<T[]> {
  const parts = ["an array"];
  if (opts.minLength !== undefined) parts.push(`of at least ${opts.minLength}`);
  if (opts.maxLength !== undefined) parts.push(`of at most ${opts.maxLength}`);
  const describe = `${parts.join(" ")} of ${item.describe}`;
  return {
    describe,
    jsonSchema: {
      shape: {
        type: "array",
        ...(item.jsonSchema ? { items: item.jsonSchema.shape } : {}),
        ...(opts.minLength !== undefined ? { minItems: opts.minLength } : {}),
        ...(opts.maxLength !== undefined ? { maxItems: opts.maxLength } : {}),
      },
    },
    check(value, at = "value") {
      if (!Array.isArray(value)) return fail(at, `expected ${describe}, got ${typeof value}`);
      if (opts.minLength !== undefined && value.length < opts.minLength) return fail(at, `expected ${describe}, got ${value.length} items`);
      if (opts.maxLength !== undefined && value.length > opts.maxLength) return fail(at, `expected ${describe}, got ${value.length} items`);
      const out: T[] = [];
      const errors: string[] = [];
      value.forEach((v, i) => {
        const r = item.check(v, `${at}[${i}]`);
        if (r.ok) out.push(r.value);
        else errors.push(...r.errors);
      });
      return errors.length ? { ok: false, errors } : { ok: true, value: out };
    },
  };
}

export interface sObjectOptions {
  /** Unknown keys are refused with their names by default, so a model's slip is named, not dropped. */
  refuseExtraKeys?: boolean;
}

export function sObject<T extends Record<string, unknown>>(
  name: string,
  fields: { [K in keyof T]: Schema<T[K]> },
  opts: sObjectOptions = {},
): Schema<T> {
  const { refuseExtraKeys = true } = opts;
  const describe = `an object ${name} with ${Object.keys(fields).join(", ")}`;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(fields)) {
    const js = (schema as Schema<unknown>).jsonSchema;
    if (js) properties[key] = js.shape;
    if (js && !js.optional) required.push(key);
  }
  return {
    describe,
    jsonSchema: {
      shape: {
        type: "object",
        properties,
        required,
        ...(refuseExtraKeys ? { additionalProperties: false } : {}),
      },
    },
    check(value, at = "value") {
      if (!isPlainObject(value)) return fail(at, `expected ${describe}, got ${Array.isArray(value) ? "an array" : typeof value}`);
      const out: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const [key, schema] of Object.entries(fields)) {
        const r = (schema as Schema<unknown>).check(value[key], `${at}.${key}`);
        if (r.ok) out[key] = r.value;
        else errors.push(...r.errors);
      }
      if (refuseExtraKeys) {
        const known = new Set(Object.keys(fields));
        const extra = Object.keys(value).filter((k) => !known.has(k));
        if (extra.length) errors.push(`${at}: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: out as T };
    },
  };
}

export function sOptional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    describe: `either nothing or ${inner.describe}`,
    jsonSchema: inner.jsonSchema ? { shape: inner.jsonSchema.shape, optional: true } : undefined,
    check(value, at = "value") {
      if (value === undefined || value === null) return { ok: true, value: undefined };
      return inner.check(value, at);
    },
  };
}

export function sUnknown(): Schema<unknown> {
  return { describe: "any value", jsonSchema: undefined, check: (value) => ({ ok: true, value }) };
}
