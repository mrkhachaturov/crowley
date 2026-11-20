'use client';

/**
 * Dataset items as Apify's Output tab shows them: one tab per view of the actor's dataset schema
 * (`views`, docs.apify.com/storage/dataset-schema) plus "All fields", every column, nested values
 * opened in a popover, and items per page with paging. A view's transformation runs server-side
 * (`GET …/items?view=`); its `display.properties` set labels and formats here.
 * Mount it with `key={datasetId}`: switching datasets starts from the first tab.
 */

import { Check, Database, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Pagination } from '@/components/pagination';
import { type DatasetFieldFormat, type DatasetSchema, getDatasetItemsPage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The items API serves at most 1000 per request. */
const PAGE_SIZES = [10, 20, 50, 100, 500, 1000];
const ALL_FIELDS = '';

type Item = Record<string, unknown>;

const isItem = (value: unknown): value is Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface DatasetPage {
  items: Item[];
  offset: number;
  limit: number;
}

export function DatasetView({
  datasetId,
  schema,
  emptyHint,
  onPage,
}: {
  datasetId: string;
  schema?: DatasetSchema | null;
  /** Shown under "[ NO RECORDS ]". */
  emptyHint?: string;
  /** Each loaded page, for callers that export it. */
  onPage?: (page: DatasetPage) => void;
}) {
  const views = Object.entries(schema?.views ?? {});
  const [tab, setTab] = useState(views[0]?.[0] ?? ALL_FIELDS);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    items: Item[];
    total: number;
    error?: string;
  } | null>(null);
  const key = `${tab}:${offset}:${limit}`;
  const loading = result?.key !== key;
  // A notification, not an input: a new callback identity must not refetch.
  const onPageRef = useRef(onPage);
  useEffect(() => {
    onPageRef.current = onPage;
  });

  useEffect(() => {
    let alive = true;
    getDatasetItemsPage(datasetId, { offset, limit, view: tab || undefined })
      .then(({ items, total }) => {
        if (!alive) return;
        const rows = items.filter(isItem);
        setResult({ key: `${tab}:${offset}:${limit}`, items: rows, total });
        onPageRef.current?.({ items: rows, offset, limit });
      })
      .catch((err: Error) => {
        if (alive)
          setResult({ key: `${tab}:${offset}:${limit}`, items: [], total: 0, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [datasetId, tab, offset, limit]);

  const view = tab ? schema?.views?.[tab] : undefined;
  const items = result?.items ?? [];
  const columns = view?.transformation?.fields ?? allFields(items);
  const properties = view?.display?.properties ?? {};

  return (
    <div className="flex flex-col h-full min-h-0">
      {views.length > 0 && (
        <div className="flex gap-1 px-4 py-2 border-b border-border overflow-x-auto shrink-0">
          {[
            ...views.map(([id, v]) => [id, v.title ?? id] as const),
            [ALL_FIELDS, 'All fields'] as const,
          ].map(([id, title]) => (
            <button
              key={id || 'all-fields'}
              type="button"
              title={id ? schema?.views?.[id]?.description : undefined}
              onClick={() => {
                setTab(id);
                setOffset(0);
              }}
              className={cn(
                'px-2.5 h-7 rounded-sm text-[12px] whitespace-nowrap',
                id === tab
                  ? 'bg-secondary text-signal'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {title}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="h-full min-h-[200px] grid place-items-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="h-full min-h-[200px] grid place-items-center text-center">
            <div>
              <Database className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
              <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
                [ NO RECORDS ]
              </p>
              {(result?.error ?? emptyHint) && (
                <p className="text-[12px] text-muted-foreground mt-1">
                  {result?.error ?? emptyHint}
                </p>
              )}
            </div>
          </div>
        ) : (
          <table className="text-[12px] border-separate border-spacing-0">
            <thead className="bg-secondary/60 sticky top-0 z-10">
              <tr className="text-left">
                <th className="px-4 py-2 font-normal border-b border-border font-mono text-[10px] text-muted-foreground tnum align-top">
                  #
                </th>
                {columns.map((field) => (
                  <th
                    key={field}
                    className="px-4 py-2 font-normal border-b border-border align-top whitespace-nowrap"
                  >
                    <div className="text-foreground font-medium">
                      {properties[field]?.label ?? humanize(field)}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">{field}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={offset + i} className="hover:bg-secondary/40">
                  <td className="px-4 py-2 border-b border-border/60 align-top font-mono text-[10px] text-muted-foreground tnum">
                    {offset + i + 1}
                  </td>
                  {columns.map((field) => (
                    <td
                      key={field}
                      className="px-4 py-2 border-b border-border/60 align-top min-w-[6rem] max-w-[28rem]"
                    >
                      <Cell value={item[field]} format={properties[field]?.format} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="shrink-0 px-4 py-2 border-t border-border bg-secondary/40 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          Items per page
          <select
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
            className="h-7 px-1.5 bg-background border border-border rounded-sm text-foreground"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {result && result.total > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground tnum">
            {offset + 1}–{Math.min(offset + limit, result.total)} of {result.total.toLocaleString()}
          </span>
        )}
        <Pagination
          total={result?.total ?? 0}
          offset={offset}
          limit={limit}
          onChange={setOffset}
          className="mt-0 pt-0 border-t-0"
        />
      </div>
    </div>
  );
}

/** Every key of the page's items, alphabetically, as Apify's "All fields" lists them. */
function allFields(items: Item[]): string[] {
  const keys = new Set<string>();
  for (const item of items) for (const key of Object.keys(item)) keys.add(key);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** `addressComponents` → "Address Components", `geoId` → "Geo ID", `rating.value` → "Rating Value". */
function humanize(field: string): string {
  return field
    .split(/[._\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) =>
      /^(id|url|urls|api)$/i.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)
    )
    .join(' ');
}

function Cell({ value, format }: { value: unknown; format?: DatasetFieldFormat }) {
  if (value === undefined) return <span className="text-muted-foreground/60">undefined</span>;
  if (value === null) return <span className="text-muted-foreground/60">null</span>;
  if (Array.isArray(value) || isItem(value)) return <NestedValue value={value} />;
  switch (
    format ??
    (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text')
  ) {
    case 'boolean':
      return value ? (
        <Check className="h-4 w-4 text-ok" aria-label="Yes" />
      ) : (
        <X className="h-4 w-4 text-fail" aria-label="No" />
      );
    case 'number':
      return (
        <span className="tnum">
          {typeof value === 'number' ? value.toLocaleString() : String(value)}
        </span>
      );
    case 'date': {
      const date = new Date(value as string | number);
      return Number.isNaN(date.getTime()) ? (
        <LongText text={String(value)} />
      ) : (
        <span>{date.toLocaleString()}</span>
      );
    }
    case 'link':
      return isHttpUrl(value) ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-signal hover:underline break-all"
        >
          {value}
        </a>
      ) : (
        <LongText text={String(value)} />
      );
    case 'image':
      return isHttpUrl(value) ? (
        <img
          src={value}
          alt=""
          loading="lazy"
          className="h-10 w-10 object-contain rounded-sm bg-background"
        />
      ) : (
        <LongText text={String(value)} />
      );
    default:
      return <LongText text={String(value)} />;
  }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** Three lines, then "•••" opens the rest. */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.split('\n').length > 3;
  return (
    <div>
      <div className={cn('whitespace-pre-wrap break-words', !open && long && 'line-clamp-3')}>
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Show less' : 'Show all'}
          className="mt-1 px-1.5 rounded-sm bg-secondary text-muted-foreground hover:text-foreground text-[11px] leading-4"
        >
          {open ? '−' : '•••'}
        </button>
      )}
    </div>
  );
}

/** "N items" / "N fields"; a click opens the value as JSON, outside click or Esc closes it. */
function NestedValue({ value }: { value: unknown[] | Item }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  const noun = Array.isArray(value) ? 'item' : 'field';

  useEffect(() => {
    if (!anchor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (
        e instanceof MouseEvent &&
        (panel.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))
      ) {
        return;
      }
      setAnchor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [anchor]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        className="underline decoration-dotted underline-offset-4 hover:text-signal whitespace-nowrap"
      >
        {count} {noun}
        {count === 1 ? '' : 's'}
      </button>
      {anchor && (
        <div
          ref={panel}
          role="dialog"
          style={{
            top: Math.min(anchor.bottom + 6, window.innerHeight - 80),
            left: Math.max(8, Math.min(anchor.left, window.innerWidth - 528)),
          }}
          className="fixed z-50 w-[520px] max-w-[calc(100vw-16px)] max-h-[60vh] overflow-auto p-4 rounded-md border border-border bg-background shadow-lg"
        >
          <pre className="font-mono text-[12px] text-foreground whitespace-pre-wrap break-all">
            {JSON.stringify(value, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}
