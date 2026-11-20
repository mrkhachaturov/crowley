/**
 * Dataset views on a real Postgres and S3: a run of an actor whose definition carries its dataset
 * schemas gets them on its datasets, and `GET …/items?view=` returns the view's transformation.
 */

import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestUser, ensureS3Bucket, runMigrations } from './setup.js';

const PLACES = {
  actorSpecification: 1,
  views: {
    places: {
      title: 'Places',
      transformation: { fields: ['title', 'ratingData.ratingValue'], flatten: ['ratingData'] },
      display: { component: 'table' },
    },
  },
};
const REVIEWS = { actorSpecification: 1, views: { reviews: { title: 'Reviews' } } };

describe('dataset views (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let client: ApifyClient;
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    baseUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
    ({ token } = await createTestUser('dataset-views@test.local', 'pw-dataset-views-1'));
    client = new ApifyClient({ token, baseUrl });
  });

  afterAll(async () => {
    await app.close();
  });

  it("puts each dataset's schema on it and serves its view", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'dataset-views',
        defaultRunOptions: { image: 'ghcr.io/acme/dataset-views:v1' },
        version: '0.1',
        actorDefinition: {
          actorSpecification: 1,
          name: 'dataset-views',
          version: '0.1',
          storages: { datasets: { default: PLACES, reviews: REVIEWS } },
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const run = await client.actor(created.json<{ data: { id: string } }>().data.id).start();
    const { default: placesId, reviews: reviewsId } = run.storageIds!.datasets;

    expect((await client.dataset(placesId!).get())?.schema).toEqual(PLACES);
    expect((await client.dataset(reviewsId!).get())?.schema).toEqual(REVIEWS);

    await client.dataset(placesId!).pushItems([
      {
        title: 'Astra Motors',
        ratingData: { ratingValue: 4.7, ratingCount: 120 },
        phones: ['1'],
      },
    ]);
    const res = await fetch(`${baseUrl}/v2/datasets/${placesId}/items?view=places`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await res.json()).toEqual([{ title: 'Astra Motors', 'ratingData.ratingValue': 4.7 }]);
  });
});
