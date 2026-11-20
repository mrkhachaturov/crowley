/**
 * Shared read path for dataset items — `GET /v2/datasets/:id/items` and the
 * run-scoped `GET /v2/actor-runs/:runId/dataset/items` both delegate here so
 * the two routes can't drift apart on pagination, ordering or projection.
 *
 * Supported query parameters (Apify parity):
 *   offset, limit  pagination; omitting `limit` (or `limit=`) streams the
 *                  whole dataset
 *   desc=1|true    newest first; `offset` then counts from the end
 *   download=1     whole dataset as a JSON attachment
 *   unwind=a       expand array / object fields into rows (lib/dataset-transform.ts)
 *   flatten=a      `{a:{b:1}}` → `{"a.b":1}`
 *   fields=a,b     keep only these keys, in this order; `outputFields` renames them
 *   omit=a,b       drop these keys, nested names too
 *   view=id        the dataset schema view's transformation, limit and desc;
 *                  explicit parameters override it
 *
 * `unwind` runs per stored item after `offset` / `limit`, so a page can hold
 * more rows than `limit`.
 *
 * Empty list parameters are treated as absent: apify-client
 * serializes an unset array option as an empty string (`fields=&omit=`),
 * and the MCP server always sends them.
 *
 * Projection runs on items after they're read from S3 — storage reads are
 * the same with or without it.
 */

import type { FastifyReply } from 'fastify';
import { listDatasetItems, iterateDatasetItems, countDatasetItems } from '../storage/s3.js';
import { zBoolQuery } from '../schemas/common.js';
import { buildItemTransform, findView } from './dataset-transform.js';

export interface DatasetItemsQuery {
  offset?: string;
  limit?: string;
  desc?: string;
  download?: string;
  // Repeated params (`fields=a&fields=b`) arrive as an array.
  fields?: string | string[];
  omit?: string | string[];
  flatten?: string | string[];
  unwind?: string | string[];
  outputFields?: string | string[];
  view?: string;
}

/** Dataset identity plus its authoritative `datasets.item_count`. */
export interface DatasetRef {
  id: string;
  /** Null when the datasets row is missing (run-scoped LEFT JOIN). */
  itemCount: number | null;
  /** `datasets.schema`; needed only to resolve `view`. */
  schema?: unknown;
}

/**
 * Boolean query flag via the shared zBoolQuery (`1`/`0`/`true`/`false`;
 * anything else is a 400 validation_error). Absent or empty is false: like
 * `fields=`, apify-client may serialize an unset flag as an empty string.
 */
export function isTrueQuery(value: string | undefined): boolean {
  return zBoolQuery.parse(value === '' ? undefined : value) ?? false;
}

/** `a,b` / `['a', 'b,c']` → `['a', 'b', 'c']`; empty → undefined (absent). */
export function parseKeyList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const keys = (Array.isArray(value) ? value : [value])
    .flatMap((v) => v.split(','))
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Write `items` as one JSON array straight to the raw response.
 *
 * The first item is pulled BEFORE anything is written: a storage failure
 * there (S3 LIST or first GET) propagates to Fastify's error handler as a
 * clean error response. Once the first byte is out the status line is
 * committed, so a later failure can't become an error response — the
 * socket is destroyed instead (the client sees an aborted transfer, never a
 * truncated-but-valid-looking array) and the error is logged. Nothing is
 * thrown after that point: throwing out of the handler with headers sent
 * made Fastify's error path call writeHead again (ERR_HTTP_HEADERS_SENT),
 * an unhandled rejection that killed the API process.
 *
 * The reply is hijacked before writing, so Fastify never tries to send its
 * own response for this request.
 */
async function streamJsonArray(
  reply: FastifyReply,
  headers: Record<string, string>,
  items: AsyncIterable<unknown>,
  serialize: (item: unknown) => string
): Promise<FastifyReply> {
  const it = items[Symbol.asyncIterator]();
  let next = await it.next();

  reply.hijack();
  const stream = reply.raw;
  // setHeader on the raw response — reply.header() needs Fastify's
  // lifecycle to flush, but streaming via reply.raw bypasses that. First
  // propagate Fastify-prepared headers (CORS from @fastify/cors, etc.) so
  // the browser doesn't reject the response.
  for (const [k, v] of Object.entries(reply.getHeaders())) {
    if (v !== undefined) stream.setHeader(k, v);
  }
  for (const [k, v] of Object.entries(headers)) stream.setHeader(k, v);

  try {
    stream.write('[');
    let firstWritten = false;
    while (!next.done) {
      // Client went away: stop reading S3 for nobody.
      if (stream.destroyed) {
        await it.return?.();
        return reply;
      }
      stream.write((firstWritten ? ',' : '') + serialize(next.value));
      firstWritten = true;
      next = await it.next();
    }
    stream.write(']');
    stream.end();
  } catch (err) {
    reply.log.error({ err }, 'dataset items stream failed mid-transfer; aborting response');
    stream.destroy(err instanceof Error ? err : new Error(String(err)));
  }
  return reply;
}

/** Skip the first `n` items of an async iterable. */
async function* skipItems(items: AsyncIterable<unknown>, n: number): AsyncGenerator<unknown> {
  let skipped = 0;
  for await (const item of items) {
    if (skipped < n) {
      skipped++;
      continue;
    }
    yield item;
  }
}

/**
 * Serve dataset items for both items routes. Returns the item array for the
 * paginated branch; the two streaming branches hijack the reply, write to
 * `reply.raw` and return `reply`.
 */
export async function sendDatasetItems(
  reply: FastifyReply,
  dataset: DatasetRef,
  q: DatasetItemsQuery
): Promise<unknown> {
  const view = q.view ? findView(dataset.schema, q.view) : undefined;
  if (q.view && !view) {
    reply.status(400);
    return { error: { type: 'invalid-parameter', message: `Dataset has no view "${q.view}"` } };
  }
  const vt = view?.transformation ?? {};
  const fields = parseKeyList(q.fields) ?? vt.fields;
  const outputFields = parseKeyList(q.outputFields);
  if (outputFields && outputFields.length !== fields?.length) {
    reply.status(400);
    return {
      error: {
        type: 'invalid-parameter',
        message: '`outputFields` must name as many fields as `fields`',
      },
    };
  }
  const transform = buildItemTransform({
    unwind: parseKeyList(q.unwind) ?? vt.unwind,
    flatten: parseKeyList(q.flatten) ?? vt.flatten,
    fields,
    outputFields,
    omit: parseKeyList(q.omit) ?? vt.omit,
  });
  const desc = q.desc === undefined || q.desc === '' ? vt.desc === true : isTrueQuery(q.desc);
  if ((q.limit === undefined || q.limit === '') && typeof vt.limit === 'number') {
    q = { ...q, limit: String(vt.limit) };
  }
  const serialize = (item: unknown) =>
    transform
      ? transform(item)
          .map((row) => JSON.stringify(row))
          .join(',')
      : JSON.stringify(item);

  // ?download=1 — stream the FULL dataset as a single JSON array file.
  // Browser opens it as a download; no in-memory materialization on either
  // server (sequential streaming via iterateDatasetItems) or client. This
  // sidesteps the silent ~1000-item cap in the legacy listDatasetItems and
  // the browser-blob memory pressure on the dashboard side.
  //
  // iterateDatasetItems handles both legacy per-item keys and the newer
  // batched keys transparently; one yielded item == one comma-separated
  // entry in the output array.
  if (isTrueQuery(q.download)) {
    return streamJsonArray(
      reply,
      {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dataset-${dataset.id}.json"`,
      },
      iterateDatasetItems(dataset.id, { reverse: desc }),
      serialize
    );
  }

  // `datasets.item_count` is the authoritative total. It is only null when
  // the row is missing (run-scoped LEFT JOIN) or the column is NULL; then
  // count from storage rather than assume 0 — a 0 total made desc paging
  // return [] and ascending paging under-count the last batch.
  const knownTotal = async (): Promise<number> =>
    dataset.itemCount ?? (await countDatasetItems(dataset.id));

  // Apify parity: when `limit` is omitted, return the FULL dataset — real
  // Apify has no implicit page size, and clients built against it assume
  // that (a consumer paginating "like Apify" without an explicit limit got
  // silently capped at 100 items here). Streams via iterateDatasetItems
  // like the download branch — no in-memory materialization — but as a
  // plain JSON response: no attachment disposition, and Apify-style
  // pagination headers so clients can verify completeness.
  //
  // `limit=` (empty) counts as omitted, like empty fields/omit/flatten.
  //
  // With desc, iteration runs newest-first, so skipping `offset` items
  // skips from the end — Apify's desc+offset semantics.
  if (q.limit === undefined || q.limit === '') {
    const total = await knownTotal();
    const fullOffset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
    return streamJsonArray(
      reply,
      {
        'content-type': 'application/json; charset=utf-8',
        'x-apify-pagination-total': String(total),
        'x-apify-pagination-offset': String(fullOffset),
        'x-apify-pagination-limit': String(Math.max(0, total - fullOffset)),
      },
      skipItems(iterateDatasetItems(dataset.id, { reverse: desc }), fullOffset),
      serialize
    );
  }

  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 100));

  // Pass total = dataset.item_count so listDatasetItems can short-circuit
  // iteration once `limit` items have been collected and size the last
  // batch correctly. The DB row is the authoritative count (incremented
  // atomically on each push); deriving total from S3 listing is what gave
  // the legacy implementation its silent 1000-item cap.
  const totalHint = await knownTotal();
  let items: unknown[];
  let total: number;
  if (desc) {
    // Newest first: `offset` counts from the end, so the page is the
    // forward window [total - offset - limit, total - offset), reversed.
    const end = Math.max(0, totalHint - offset);
    const start = Math.max(0, end - limit);
    if (end === start) {
      items = [];
      total = totalHint;
    } else {
      ({ items, total } = await listDatasetItems(dataset.id, {
        offset: start,
        limit: end - start,
        total: totalHint,
      }));
      items.reverse();
    }
  } else {
    ({ items, total } = await listDatasetItems(dataset.id, { offset, limit, total: totalHint }));
  }

  // Set pagination headers (Apify style) — the requested offset/limit,
  // whatever the direction.
  reply.header('x-apify-pagination-total', total);
  reply.header('x-apify-pagination-offset', offset);
  reply.header('x-apify-pagination-limit', limit);

  return transform ? items.flatMap(transform) : items;
}
