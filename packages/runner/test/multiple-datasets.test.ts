/**
 * Multiple datasets per run (Apify `storages.datasets`), runner side: the actor resolves
 * `Actor.openDataset({ alias })` from ACTOR_STORAGES_JSON, a retry keeps the failed run's
 * datasets, and webhooks report them as `resource.storageIds`.
 */

import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildActorEnv } from '../src/docker.js';
import { attemptWebhookDelivery, maybeRetryRun, type RunJob } from '../src/queue.js';

const RUN: RunJob = {
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'user-1',
  status: 'FAILED',
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'rq-1',
  dataset_aliases: { reviews: 'ds-reviews' },
  timeout_secs: 300,
  memory_mbytes: 1024,
  retry_count: 0,
  origin_run_id: null,
  run_after: null,
};

function envFor(datasetAliases: Record<string, string> | null) {
  return buildActorEnv({
    runId: 'run-1',
    actorId: 'actor-1',
    apiBaseUrl: 'http://api:3000',
    token: 'token',
    defaultDatasetId: 'ds-1',
    defaultKeyValueStoreId: 'kv-1',
    defaultRequestQueueId: 'rq-1',
    datasetAliases,
  });
}

/** What apify 3.8 `resolveStorageIdentifier` does for `{ alias }` when APIFY_IS_AT_HOME is set. */
function resolveDatasetAlias(env: Record<string, string>, alias: string): string {
  const json = env.ACTOR_STORAGES_JSON;
  if (env.APIFY_IS_AT_HOME && !json) {
    throw new Error(
      `Storage alias "${alias}" cannot be resolved because ACTOR_STORAGES_JSON is not set.`
    );
  }
  const id = (JSON.parse(json!) as { datasets?: Record<string, string> }).datasets?.[alias];
  if (!id) throw new Error(`Storage alias "${alias}" not found in ACTOR_STORAGES_JSON`);
  return id;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('actor environment', () => {
  it('lets the SDK open an aliased dataset', () => {
    const env = envFor({ reviews: 'ds-reviews' });
    expect(resolveDatasetAlias(env, 'reviews')).toBe('ds-reviews');
    expect(resolveDatasetAlias(env, 'default')).toBe('ds-1');
  });

  it('carries every default storage in the Apify shape when the actor declares no aliases', () => {
    expect(JSON.parse(envFor(null).ACTOR_STORAGES_JSON!)).toEqual({
      datasets: { default: 'ds-1' },
      keyValueStores: { default: 'kv-1' },
      requestQueues: { default: 'rq-1' },
    });
  });
});

describe('automatic retry', () => {
  it("reuses the failed run's aliased datasets", async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ max_retries: 1, retry_delay_secs: 0 }] }),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    } as unknown as pg.Pool;
    const redis = { publish: vi.fn() } as unknown as Redis;

    await maybeRetryRun(RUN, RUN.id, db, redis);

    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO runs'));
    expect(insert, 'retry run inserted').toBeDefined();
    const params = insert![1] as unknown[];
    expect(params).toContain('ds-1');
    expect(params).toContain(JSON.stringify({ reviews: 'ds-reviews' }));
  });
});

describe('webhook payload', () => {
  it('reports every dataset of the run in resource.storageIds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.Pool;
    const webhook = {
      id: 'wh-1',
      request_url: 'https://hooks.example.com/receive',
      payload_template: null,
      headers: null,
    };

    await attemptWebhookDelivery(
      'dlv-1',
      webhook,
      { ...RUN, status: 'SUCCEEDED' },
      'ACTOR.RUN.SUCCEEDED',
      db
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { resource: { storageIds: unknown } };
    expect(payload.resource.storageIds).toEqual({
      datasets: { default: 'ds-1', reviews: 'ds-reviews' },
      keyValueStores: { default: 'kv-1' },
      requestQueues: { default: 'rq-1' },
    });
  });
});
