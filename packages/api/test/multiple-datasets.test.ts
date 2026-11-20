/**
 * Multiple datasets per run (Apify `storages.datasets`), API side: every way a run starts gives it
 * a dataset per alias of the build it is stamped with, the run object and webhooks report them as
 * `storageIds`, and a push with an invalid `storages.datasets` is refused.
 */

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockGetKVRecord, mockWithLock } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetKVRecord: vi.fn(),
  mockWithLock: vi.fn(),
}));

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'user-1', email: 'test@example.com', role: 'user' };
  },
}));

// One SQL-routed mock for the pool helper and the rerun's transaction client.
const client = { query: (...args: unknown[]) => mockQuery(...args) as unknown, release: vi.fn() };
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
  getClient: () => Promise.resolve(client),
  withAdvisoryLock: mockWithLock,
  LOCK_IDS: { scheduler: 0xc0de0003 },
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn().mockResolvedValue(undefined),
  getKVRecord: mockGetKVRecord,
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: { publish: vi.fn(), set: vi.fn(), get: vi.fn().mockResolvedValue(null) },
}));

import { actorsRoutes } from '../src/routes/actors.js';
import { runsRoutes } from '../src/routes/runs.js';
import { buildWebhookPayload } from '../src/routes/webhooks.js';
import { runSchedulerTick } from '../src/scheduler.js';
import { ActorDefinitionSchema } from '../src/schemas/actors.js';

/** The actor's newest SUCCEEDED build declares a second dataset, `reviews`. */
const BUILD = {
  build_id: 'build-2',
  build_number: '0.1.2',
  datasets: { default: './places_schema.json', reviews: './reviews_schema.json' },
};

const RUN_ROW = {
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'user-1',
  status: 'SUCCEEDED',
  status_message: null,
  started_at: new Date('2026-11-20T10:00:00Z'),
  finished_at: new Date('2026-11-20T10:05:00Z'),
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'rq-1',
  dataset_aliases: { reviews: 'ds-reviews' },
  timeout_secs: 3600,
  memory_mbytes: 1024,
  container_url: null,
  build_id: 'build-1',
  build_number: '0.1.1',
  exit_code: 0,
  stats_json: null,
  retry_count: 0,
  origin_run_id: null,
  run_after: null,
  created_at: new Date('2026-11-20T10:00:00Z'),
  modified_at: new Date('2026-11-20T10:05:00Z'),
  default_dataset_item_count: 3,
};

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];

/** Routes each query by its SQL; `build` is what the build-stamp lookup finds. */
function routeQueries(build: typeof BUILD | null) {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM actors a/.test(sql) || /SELECT default_run_options FROM actors/.test(sql)) {
      return Promise.resolve({
        rows: [{ id: 'actor-1', name: 'places', user_id: 'user-1', default_run_options: null }],
      });
    }
    if (/storages'->'datasets'/.test(sql)) return Promise.resolve({ rows: build ? [build] : [] });
    if (/SELECT \* FROM runs\s+WHERE id = \$1 AND status IN/.test(sql)) {
      return Promise.resolve({ rows: [{ ...RUN_ROW, status: 'FAILED' }] });
    }
    if (/INSERT INTO runs/.test(sql)) {
      return Promise.resolve({ rows: [{ ...RUN_ROW, id: params[0], status: 'READY' }] });
    }
    if (/FROM runs r/.test(sql)) return Promise.resolve({ rows: [RUN_ROW] });
    return Promise.resolve({ rows: [] });
  });
}

/** Ids of the datasets created through createAliasedDatasets (the batched INSERT). */
function aliasedDatasetIds(): string[] {
  return calls
    .filter((c) => /INSERT INTO datasets .*unnest/.test(c.sql))
    .flatMap((c) => c.params[0] as string[]);
}

/** `dataset_aliases` as the run INSERT stored it. */
function storedAliases(): Record<string, string> | null {
  const insert = calls.find((c) => /INSERT INTO runs/.test(c.sql));
  if (!insert) throw new Error('no run INSERT');
  const json = insert.params.find((p) => typeof p === 'string' && p.startsWith('{"'));
  return json ? (JSON.parse(json as string) as Record<string, string>) : null;
}

describe('multiple datasets per run', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(actorsRoutes, { prefix: '/v2' });
    await app.register(runsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    calls = [];
    mockQuery.mockReset();
    mockGetKVRecord.mockReset();
    mockWithLock.mockReset();
  });

  describe('POST /v2/acts/:actorId/runs', () => {
    it('creates a dataset for each alias of the stamped build and reports it in storageIds', async () => {
      routeQueries(BUILD);

      const res = await app.inject({ method: 'POST', url: '/v2/acts/actor-1/runs', payload: {} });

      expect(res.statusCode).toBe(201);
      const [reviewsId] = aliasedDatasetIds();
      expect(reviewsId).toBeTruthy();
      expect(storedAliases()).toEqual({ reviews: reviewsId });
      const { data } = res.json<{ data: { defaultDatasetId: string; storageIds: unknown } }>();
      expect(data.storageIds).toEqual({
        datasets: { default: data.defaultDatasetId, reviews: reviewsId },
        keyValueStores: { default: expect.any(String) },
        requestQueues: { default: expect.any(String) },
      });
    });

    it('creates no extra dataset when the build declares only the default one', async () => {
      routeQueries({ ...BUILD, datasets: null as never });

      const res = await app.inject({ method: 'POST', url: '/v2/acts/actor-1/runs', payload: {} });

      expect(res.statusCode).toBe(201);
      expect(aliasedDatasetIds()).toEqual([]);
      expect(storedAliases()).toBeNull();
      const { data } = res.json<{ data: { storageIds: { datasets: object } } }>();
      expect(Object.keys(data.storageIds.datasets)).toEqual(['default']);
    });
  });

  describe('GET /v2/actor-runs/:runId', () => {
    it('reports every dataset of the run in storageIds', async () => {
      routeQueries(null);

      const res = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1' });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { storageIds: unknown } }>().data.storageIds).toEqual({
        datasets: { default: 'ds-1', reviews: 'ds-reviews' },
        keyValueStores: { default: 'kv-1' },
        requestQueues: { default: 'rq-1' },
      });
    });
  });

  describe('POST /v2/actor-runs/:runId/rerun', () => {
    it("gives the rerun fresh datasets for the current build's aliases", async () => {
      routeQueries(BUILD);
      mockGetKVRecord.mockResolvedValue({
        value: Buffer.from('{}'),
        contentType: 'application/json',
      });

      const res = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(res.statusCode).toBe(201);
      const [reviewsId] = aliasedDatasetIds();
      expect(reviewsId).toBeTruthy();
      expect(reviewsId).not.toBe('ds-reviews');
      expect(storedAliases()).toEqual({ reviews: reviewsId });
    });
  });

  describe('scheduled run', () => {
    it('is stamped with the build and gets a dataset for each of its aliases', async () => {
      routeQueries(BUILD);
      const due = {
        id: 's1',
        user_id: 'user-1',
        actor_id: 'actor-1',
        cron_expression: '*/5 * * * *',
        timezone: 'UTC',
        input: {},
        last_run_at: null,
        next_run_at: new Date(Date.now() - 1000),
      };
      const lockClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [due] })
          .mockResolvedValue({ rows: [] }),
      };
      mockWithLock.mockImplementation(
        async (_id: number, work: (c: unknown) => Promise<unknown>) => ({
          acquired: true,
          result: await work(lockClient),
        })
      );

      await runSchedulerTick();

      const insert = calls.find((c) => /INSERT INTO runs/.test(c.sql));
      expect(insert?.params).toContain('build-2');
      const [reviewsId] = aliasedDatasetIds();
      expect(storedAliases()).toEqual({ reviews: reviewsId });
    });
  });

  describe('webhook payload', () => {
    it('carries storageIds in the resource', () => {
      const payload = buildWebhookPayload('ACTOR.RUN.SUCCEEDED', {
        id: 'run-1',
        actorId: 'actor-1',
        userId: 'user-1',
        status: 'SUCCEEDED',
        startedAt: null,
        finishedAt: null,
        defaultDatasetId: 'ds-1',
        defaultKeyValueStoreId: 'kv-1',
        defaultRequestQueueId: 'rq-1',
        datasetAliases: { reviews: 'ds-reviews' },
        timeoutSecs: 3600,
        memoryMbytes: 1024,
        buildId: null,
        buildNumber: null,
        exitCode: 0,
        stats: {
          inputBodyLen: 0,
          restartCount: 0,
          resurrectCount: 0,
          runTimeSecs: 0,
          computeUnits: 0,
        },
      });

      expect(payload.resource.storageIds.datasets).toEqual({
        default: 'ds-1',
        reviews: 'ds-reviews',
      });
    });
  });

  describe('push: storages.datasets', () => {
    const parse = (storages: unknown) => ActorDefinitionSchema.safeParse({ storages });

    it('accepts aliases next to default', () => {
      expect(parse({ datasets: { default: './a.json', reviews: { fields: {} } } }).success).toBe(
        true
      );
    });

    it('refuses datasets without the default alias', () => {
      expect(parse({ datasets: { reviews: './b.json' } }).success).toBe(false);
    });

    it('refuses an alias with a hyphen', () => {
      expect(parse({ datasets: { default: './a.json', 'my-reviews': './b.json' } }).success).toBe(
        false
      );
    });

    it('refuses dataset and datasets together', () => {
      expect(parse({ dataset: './a.json', datasets: { default: './a.json' } }).success).toBe(false);
    });
  });
});
