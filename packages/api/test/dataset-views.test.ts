/**
 * Dataset views (Apify dataset schema `views`), API side: the items transformation Apify defines
 * (`unwind`, `flatten`, `fields` + `outputFields`, `omit`), `GET …/items?view=`, the schema on the
 * dataset object, the schema attached to each dataset when a run starts, and the paging headers a
 * browser on another origin can read.
 */

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockList } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockList: vi.fn() }));

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'user-1', email: 'test@example.com', role: 'user' };
  },
}));

vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
  getClient: vi.fn(),
}));

vi.mock('../src/storage/s3.js', () => ({
  listDatasetItems: (...args: unknown[]) => mockList(...args) as unknown,
  iterateDatasetItems: vi.fn(),
  countDatasetItems: vi.fn(),
  putDatasetBatch: vi.fn(),
  deleteDatasetS3Prefix: vi.fn(),
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: { publish: vi.fn(), set: vi.fn(), get: vi.fn().mockResolvedValue(null) },
}));

import { config } from '../src/config.js';
import { configureHttp } from '../src/http-setup.js';
import { buildItemTransform } from '../src/lib/dataset-transform.js';
import { actorsRoutes } from '../src/routes/actors.js';
import { datasetsRoutes } from '../src/routes/datasets.js';

/** The actor's places schema, shaped like `.actor/places_dataset_schema.json`. */
const PLACES_SCHEMA = {
  actorSpecification: 1,
  views: {
    places: {
      title: 'Places',
      transformation: {
        fields: ['title', 'ratingData.ratingValue', 'url'],
        flatten: ['ratingData'],
      },
      display: { component: 'table', properties: { url: { format: 'link', label: 'Card' } } },
    },
  },
};

const PLACE = {
  title: 'Astra Motors',
  ratingData: { ratingValue: 4.7, ratingCount: 120 },
  url: 'https://yandex.ru/maps/org/1/',
  phones: ['+7 499 715-88-59'],
};

const DATASET_ROW = {
  id: 'ds-1',
  name: null,
  user_id: 'user-1',
  created_at: new Date(),
  modified_at: new Date(),
  accessed_at: new Date(),
  item_count: 1,
  schema: PLACES_SCHEMA,
};

describe('item transformation (Apify ViewTransformation)', () => {
  const run = (t: Parameters<typeof buildItemTransform>[0], item: unknown) =>
    buildItemTransform(t)!(item);

  it('unwind turns an array field into one row per element merged into the parent', () => {
    expect(
      run({ unwind: ['reviews'] }, { name: 'p', reviews: [{ text: 'a' }, { text: 'b' }] })
    ).toEqual([
      { name: 'p', text: 'a' },
      { name: 'p', text: 'b' },
    ]);
  });

  it('unwind merges an object field into the parent, as the spec example shows', () => {
    expect(run({ unwind: ['foo'] }, { foo: { bar: 'hello' } })).toEqual([{ bar: 'hello' }]);
  });

  it('flatten turns nested objects into dotted keys, as the spec example shows', () => {
    expect(run({ flatten: ['foo'] }, { foo: { bar: 'hello' } })).toEqual([{ 'foo.bar': 'hello' }]);
  });

  it('fields keeps only the listed keys in their order; outputFields renames them', () => {
    expect(run({ fields: ['b', 'a'], outputFields: ['B', 'A'] }, { a: 1, b: 2, c: 3 })).toEqual([
      { B: 2, A: 1 },
    ]);
  });

  it('omit drops nested names too', () => {
    expect(run({ omit: ['meta.secret'] }, { meta: { secret: 1, ok: 2 } })).toEqual([
      { meta: { ok: 2 } },
    ]);
  });
});

describe('datasets API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(datasetsRoutes, { prefix: '/v2' });
    await app.register(actorsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockList.mockReset();
    mockQuery.mockResolvedValue({ rows: [DATASET_ROW] });
    mockList.mockResolvedValue({ items: [PLACE], total: 1 });
  });

  it("GET …/items?view= applies the view's transformation", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/datasets/ds-1/items?view=places&limit=10',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        title: 'Astra Motors',
        'ratingData.ratingValue': 4.7,
        url: 'https://yandex.ru/maps/org/1/',
      },
    ]);
  });

  it('an explicit parameter overrides the view', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/datasets/ds-1/items?view=places&fields=title&limit=10',
    });

    expect(res.json()).toEqual([{ title: 'Astra Motors' }]);
  });

  it('an unknown view is a 400, not the raw items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/datasets/ds-1/items?view=nope&limit=10',
    });

    expect(res.statusCode).toBe(400);
  });

  it('outputFields must match fields in length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/datasets/ds-1/items?fields=a,b&outputFields=x&limit=10',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /v2/datasets/:id carries the schema, as Apify DatasetResource does', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/datasets/ds-1' });

    expect(res.json<{ data: { schema: unknown } }>().data.schema).toEqual(PLACES_SCHEMA);
  });

  it("a run start attaches each dataset's schema from the build's storages", async () => {
    const reviews = { actorSpecification: 1, views: { reviews: { title: 'Reviews' } } };
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM actors a/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 'actor-1', name: 'places', default_run_options: null }],
        });
      }
      if (/storages'->'datasets'/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              build_id: 'b-1',
              build_number: '0.1.1',
              datasets: { default: PLACES_SCHEMA, reviews },
              storages: { datasets: { default: PLACES_SCHEMA, reviews } },
            },
          ],
        });
      }
      if (/INSERT INTO runs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: params[0], actor_id: 'actor-1', status: 'READY' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await app.inject({ method: 'POST', url: '/v2/acts/actor-1/runs', payload: {} });

    expect(res.statusCode).toBe(201);
    const { storageIds } = res.json<{
      data: { storageIds: { datasets: Record<string, string> } };
    }>().data;
    const update = calls.find((c) => /UPDATE datasets d SET schema/.test(c.sql));
    expect(update, 'schemas attached').toBeDefined();
    const [ids, schemas] = update!.params as [string[], string[]];
    const byId = Object.fromEntries(ids.map((id, i) => [id, JSON.parse(schemas[i]!)]));
    expect(byId[storageIds.datasets.default!]).toEqual(PLACES_SCHEMA);
    expect(byId[storageIds.datasets.reviews!]).toEqual(reviews);
  });
});

describe('CORS', () => {
  it('exposes the paging headers to a browser on another origin', async () => {
    const app = Fastify();
    await configureHttp(app);
    app.get('/probe', async () => ({ ok: true }));
    const origin = config.corsOrigins.split(',')[0]!.trim();

    const res = await app.inject({ method: 'GET', url: '/probe', headers: { origin } });

    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain(
      'x-apify-pagination-total'
    );
    await app.close();
  });
});
