/**
 * Apify's dataset item transformation, shared by the `GET …/items` query parameters and a dataset
 * schema view's `transformation`: `unwind`, then `flatten`, then `fields` (renamed by
 * `outputFields`), then `omit`. Spec: docs.apify.com/storage/dataset-schema, "ViewTransformation".
 */

type Item = Record<string, unknown>;

export interface ItemTransformation {
  unwind?: string[];
  flatten?: string[];
  fields?: string[];
  /** Positional new names for `fields`; same length. */
  outputFields?: string[];
  omit?: string[];
}

/** A dataset schema's view (`DatasetView`); only what the API and dashboard read. */
export interface DatasetView {
  title?: string;
  description?: string;
  transformation?: ItemTransformation & { limit?: number; desc?: boolean };
  display?: {
    component?: string;
    properties?: Record<string, { label?: string; format?: string }>;
  };
}

const isObject = (value: unknown): value is Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** View `id` of a dataset schema (`schema.views[id]`), or undefined. */
export function findView(schema: unknown, id: string): DatasetView | undefined {
  if (!isObject(schema) || !isObject(schema.views)) return undefined;
  const view = schema.views[id];
  return isObject(view) ? (view as DatasetView) : undefined;
}

/**
 * One stored item → the rows it yields (more than one only through `unwind`), or null when the
 * transformation is empty. A non-object item passes through untouched.
 */
export function buildItemTransform(t: ItemTransformation): ((item: unknown) => unknown[]) | null {
  if (!t.unwind?.length && !t.flatten?.length && !t.fields?.length && !t.omit?.length) {
    return null;
  }
  const rename =
    t.fields && t.outputFields
      ? new Map(t.fields.map((f, i) => [f, t.outputFields![i]!]))
      : undefined;
  const flatten = new Set(t.flatten ?? []);
  return (item) => {
    if (!isObject(item)) return [item];
    let rows: Item[] = [item];
    for (const key of t.unwind ?? []) rows = rows.flatMap((row) => unwindField(row, key));
    return rows.map((row) => project(flattenFields(row, flatten), t.fields, rename, t.omit));
  };
}

/**
 * An array field gives one row per element merged into the parent; an object field is merged into
 * the parent; a missing or scalar field, or an empty array, keeps the row as it is.
 */
function unwindField(row: Item, key: string): Item[] {
  const value = row[key];
  const parent = { ...row };
  delete parent[key];
  if (Array.isArray(value) && value.length > 0) {
    return value.map((el) => (isObject(el) ? { ...parent, ...el } : { ...parent, [key]: el }));
  }
  if (isObject(value)) return [{ ...parent, ...value }];
  return [row];
}

/** `{ foo: { bar: 1 } }` → `{ "foo.bar": 1 }` for the listed keys, in place, nested objects too. */
function flattenFields(row: Item, keys: Set<string>): Item {
  if (keys.size === 0) return row;
  const out: Item = {};
  for (const [key, value] of Object.entries(row)) {
    if (keys.has(key) && isObject(value)) flattenInto(out, value, key);
    else out[key] = value;
  }
  return out;
}

function flattenInto(out: Item, value: Item, prefix: string): void {
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (isObject(child)) flattenInto(out, child, path);
    else out[path] = child;
  }
}

function project(
  row: Item,
  fields: string[] | undefined,
  rename: Map<string, string> | undefined,
  omit: string[] | undefined
): Item {
  let out: Item;
  if (fields?.length) {
    out = {};
    for (const field of fields) {
      if (Object.hasOwn(row, field)) out[rename?.get(field) ?? field] = row[field];
    }
  } else {
    out = { ...row };
  }
  for (const path of omit ?? []) omitPath(out, path);
  return out;
}

/** Drop `a.b`: the flattened key if present, else `b` inside the object `a`. */
function omitPath(item: Item, path: string): void {
  if (Object.hasOwn(item, path)) {
    delete item[path];
    return;
  }
  const dot = path.indexOf('.');
  if (dot < 0) return;
  const head = item[path.slice(0, dot)];
  if (isObject(head)) {
    const copy = { ...head };
    omitPath(copy, path.slice(dot + 1));
    item[path.slice(0, dot)] = copy;
  }
}
