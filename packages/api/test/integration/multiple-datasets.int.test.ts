/**
 * Multiple datasets per run (Apify `storages.datasets`) on a real Postgres and S3, through the
 * official apify-client: a run of an actor declaring `reviews` reports it in `storageIds`, and the
 * dataset behind it exists and takes items.
 */

import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestUser, ensureS3Bucket, runMigrations } from './setup.js';

const definition = (datasets: unknown) => ({
  actorSpecification: 1,
  name: 'multi-ds',
  version: '0.1',
  storages: { datasets },
});

describe('multiple datasets per run (integration)', () => {
  let app: FastifyInstance;
  let client: ApifyClient;
  let token: string;

  async function createActor(name: string, actorDefinition: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name,
        defaultRunOptions: { image: `ghcr.io/acme/${name}:v1` },
        version: '0.1',
        actorDefinition,
      },
    });
  }

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    ({ token } = await createTestUser('multi-ds@test.local', 'pw-multi-ds-1'));
    client = new ApifyClient({ token, baseUrl: address.replace(/\/$/, '') });
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives a run a dataset per alias and reports it in storageIds', async () => {
    const created = await createActor(
      'multi-ds',
      definition({ default: { actorSpecification: 1 }, reviews: { actorSpecification: 1 } })
    );
    expect(created.statusCode).toBe(201);
    const actorId = created.json<{ data: { id: string } }>().data.id;

    const started = await client.actor(actorId).start();
    const reviewsId = started.storageIds?.datasets.reviews;
    expect(reviewsId).toBeTruthy();
    expect(started.storageIds?.datasets.default).toBe(started.defaultDatasetId);

    const run = await client.run(started.id).get();
    expect(run?.storageIds).toEqual(started.storageIds);

    await client.dataset(reviewsId!).pushItems([{ entity: 'review', text: 'ok' }]);
    const reviews = await client.dataset(reviewsId!).listItems();
    expect(reviews.items).toEqual([{ entity: 'review', text: 'ok' }]);
    const places = await client.run(started.id).dataset().listItems();
    expect(places.items).toEqual([]);

    const { pool } = await import('../../src/db/index.js');
    const row = await pool.query<{ dataset_aliases: unknown }>(
      'SELECT dataset_aliases FROM runs WHERE id = $1',
      [started.id]
    );
    expect(row.rows[0]?.dataset_aliases).toEqual({ reviews: reviewsId });
  });

  it('refuses an actor definition whose datasets lack the default alias', async () => {
    const res = await createActor(
      'multi-ds-bad',
      definition({ reviews: { actorSpecification: 1 } })
    );
    expect(res.statusCode).toBe(400);
  });
});
