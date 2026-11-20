// @vitest-environment jsdom
/**
 * The dataset table as Apify's Output tab shows it: a tab per schema view plus "All fields",
 * every column (no cap at 8 or 10), nested values opened as JSON, long text behind "•••", and
 * items per page with paging over the dataset's total.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = '';
});

import { DatasetView } from '@/components/dataset-view';
import type { DatasetSchema } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCHEMA: DatasetSchema = {
  views: {
    overview: {
      title: 'Overview',
      transformation: { fields: ['title', 'url'] },
      display: {
        component: 'table',
        properties: { title: { label: 'Place' }, url: { format: 'link' } },
      },
    },
    contacts: { title: 'Contacts', transformation: { fields: ['phones'] } },
  },
};

/** Twelve fields; `extra` only on the second item. */
const ITEMS = [
  Object.fromEntries([
    ...Array.from({ length: 11 }, (_, i) => [`field${String(i).padStart(2, '0')}`, i]),
    ['phones', ['+7 499 715-88-59', '+7 499 499-07-10']],
  ]),
  { field00: 1, extra: 'only here', phones: [] },
];

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

function respond(items: unknown[], total: number) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(items),
    headers: new Headers({ 'x-apify-pagination-total': String(total) }),
  });
}

const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://x');

async function render(schema?: DatasetSchema) {
  await act(async () => {
    root.render(<DatasetView datasetId="ds-1" schema={schema} />);
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('DatasetView', () => {
  it('shows a tab per schema view plus All fields, and asks the API for the first view', async () => {
    respond([{ title: 'Astra', url: 'https://yandex.ru/maps/org/1/' }], 1);
    await render(SCHEMA);

    expect(button('Overview')).toBeDefined();
    expect(button('Contacts')).toBeDefined();
    expect(button('All fields')).toBeDefined();
    expect(lastUrl().searchParams.get('view')).toBe('overview');
  });

  it("labels a view's columns from display.properties and keeps the field name under it", async () => {
    respond([{ title: 'Astra', url: 'https://yandex.ru/maps/org/1/' }], 1);
    await render(SCHEMA);

    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['#', 'Placetitle', 'URLurl']);
    expect(container.querySelector('a[href="https://yandex.ru/maps/org/1/"]')).not.toBeNull();
  });

  it('All fields shows every field of every item, past 10 columns', async () => {
    respond(ITEMS, 2);
    await render(undefined);

    const fields = [...container.querySelectorAll('thead th div.font-mono')].map(
      (d) => d.textContent
    );
    expect(fields).toHaveLength(13);
    expect(fields).toContain('extra');
    expect(lastUrl().searchParams.get('view')).toBeNull();
  });

  it('a nested value is "N items" and opens as JSON', async () => {
    respond(ITEMS, 2);
    await render(undefined);

    await click(button('2 items'));
    expect(container.querySelector('[role="dialog"] pre')?.textContent).toContain(
      '+7 499 715-88-59'
    );
  });

  it('long text is cut with •••, which opens the rest', async () => {
    respond([{ text: 'x'.repeat(400) }], 1);
    await render(undefined);
    const text = () => container.querySelector('tbody td:nth-child(2) div div')!;

    expect(text().className).toContain('line-clamp-3');
    await click(button('•••'));
    expect(text().className).not.toContain('line-clamp-3');
  });

  it('pages over the dataset total and changes the page size', async () => {
    respond(ITEMS, 120);
    await render(undefined);

    expect(container.textContent).toContain('1–50 of 120');
    expect(lastUrl().searchParams.get('limit')).toBe('50');

    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = '100';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lastUrl().searchParams.get('limit')).toBe('100');
    expect(lastUrl().searchParams.get('offset')).toBe('0');
  });
});
