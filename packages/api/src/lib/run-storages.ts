/**
 * Storages of a run by alias, as Apify's multiple datasets define them: `.actor/actor.json`
 * `storages.datasets` maps aliases to schemas, every alias gets its own dataset at run start, and
 * the run reports them as `storageIds` (the actor reads the same map from `ACTOR_STORAGES_JSON`).
 * `default` stays in `runs.default_dataset_id`; the other aliases live in `runs.dataset_aliases`.
 */

import { nanoid } from 'nanoid';
import type { Queryable } from './resolve-actor.js';

/** Apify's rule for a `storages.datasets` key; hyphens are not allowed, unlike dataset names. */
export const DATASET_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,100}$/;

/** Alias → dataset id, `default` excluded. */
export type DatasetAliases = Record<string, string>;

/** Apify's `storageIds` run field (`ActorRunStorageIds` in apify-client). */
export interface RunStorageIds {
  datasets: Record<string, string>;
  keyValueStores: Record<string, string>;
  requestQueues: Record<string, string>;
}

/** Aliases other than `default` that a build's `storages.datasets` declares. */
export function extraDatasetAliases(datasets: unknown): string[] {
  if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) return [];
  // Validated on push (ActorDefinitionSchema); the filter guards builds stored before that.
  return Object.keys(datasets).filter(
    (alias) => alias !== 'default' && DATASET_ALIAS_PATTERN.test(alias)
  );
}

/**
 * Creates one unnamed dataset per alias, owned by `userId`. Unnamed, so retention reaps them with
 * the run's default storages. Null when there is nothing to create.
 */
export async function createAliasedDatasets(
  db: Queryable,
  userId: string,
  aliases: readonly string[]
): Promise<DatasetAliases | null> {
  if (aliases.length === 0) return null;
  const ids: DatasetAliases = Object.fromEntries(aliases.map((alias) => [alias, nanoid()]));
  await db.query('INSERT INTO datasets (id, user_id) SELECT unnest($1::varchar[]), $2', [
    Object.values(ids),
    userId,
  ]);
  return ids;
}

/**
 * Alias → schema object from a build's `storages`: `default` from `storages.dataset` or
 * `storages.datasets.default`, the rest from `storages.datasets`. A schema still given as a path
 * (pushed before `crc push` inlined them) is skipped.
 */
export function datasetSchemas(storages: unknown): Record<string, Record<string, unknown>> {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(storages)) return {};
  const schemas: Record<string, Record<string, unknown>> = {};
  if (isObject(storages.dataset)) schemas.default = storages.dataset;
  if (isObject(storages.datasets)) {
    for (const [alias, schema] of Object.entries(storages.datasets)) {
      if (isObject(schema)) schemas[alias] = schema;
    }
  }
  return schemas;
}

/** Stores each dataset's schema from the build's `storages`; `datasetIds` is alias → id. */
export async function attachDatasetSchemas(
  db: Queryable,
  storages: unknown,
  datasetIds: Record<string, string>
): Promise<void> {
  const schemas = datasetSchemas(storages);
  const pairs = Object.entries(datasetIds).filter(([alias]) => schemas[alias]);
  if (pairs.length === 0) return;
  await db.query(
    `UPDATE datasets d SET schema = s.schema
       FROM unnest($1::varchar[], $2::jsonb[]) AS s(id, schema)
      WHERE d.id = s.id`,
    [pairs.map(([, id]) => id), pairs.map(([alias]) => JSON.stringify(schemas[alias]))]
  );
}

/** `storageIds` of a run row; a storage whose id is null (reaped default) is left out. */
export function runStorageIds(run: {
  default_dataset_id: string | null;
  default_key_value_store_id: string | null;
  default_request_queue_id: string | null;
  dataset_aliases?: DatasetAliases | null;
}): RunStorageIds {
  const byDefault = (id: string | null): Record<string, string> => (id ? { default: id } : {});
  return {
    datasets: { ...byDefault(run.default_dataset_id), ...run.dataset_aliases },
    keyValueStores: byDefault(run.default_key_value_store_id),
    requestQueues: byDefault(run.default_request_queue_id),
  };
}
