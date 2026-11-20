/**
 * `crc push` sends the dataset and key-value store schemas themselves, not their paths: the API
 * attaches each schema to the storage a run creates, and its views drive the Output tab.
 */

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActorDefinitionError,
  resolveActorDefinitionWithSources,
} from '../src/utils/actor-definition.js';

const PLACES = { actorSpecification: 1, views: { places: { title: 'Places' } } };
const REVIEWS = { actorSpecification: 1, views: { reviews: { title: 'Reviews' } } };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crc-dataset-views-'));
  await fs.ensureDir(path.join(root, '.actor'));
  await fs.writeJson(path.join(root, '.actor/places_dataset_schema.json'), PLACES);
  await fs.writeJson(path.join(root, '.actor/reviews_dataset_schema.json'), REVIEWS);
});

afterEach(async () => {
  await fs.remove(root);
});

const resolve = (storages: unknown) =>
  resolveActorDefinitionWithSources(root, {
    actorSpecification: 1,
    name: 'places',
    version: '0.1',
    storages,
  } as Parameters<typeof resolveActorDefinitionWithSources>[1]);

describe('storage schemas in the actor definition', () => {
  it('reads every storages.datasets schema file in', async () => {
    const { definition } = await resolve({
      datasets: {
        default: './places_dataset_schema.json',
        reviews: './reviews_dataset_schema.json',
      },
    });

    expect(definition.storages).toEqual({ datasets: { default: PLACES, reviews: REVIEWS } });
  });

  it('reads storages.dataset in and keeps an inline schema as is', async () => {
    const inline = { actorSpecification: 1, views: {} };
    const { definition } = await resolve({
      dataset: './places_dataset_schema.json',
      keyValueStore: inline,
    });

    expect(definition.storages).toEqual({ dataset: PLACES, keyValueStore: inline });
  });

  it('fails the push when a schema file is missing', async () => {
    await expect(resolve({ datasets: { default: './missing.json' } })).rejects.toBeInstanceOf(
      ActorDefinitionError
    );
  });
});
