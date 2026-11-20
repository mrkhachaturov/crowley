'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Download, FileJson, Loader2, Trash2 } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { DatasetView, type DatasetPage } from '@/components/dataset-view';
import { CopyButton } from '@/components/ui/copy-button';
import { prefixPath } from '@/lib/path-prefix';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import {
  deleteDataset,
  downloadAsBlob,
  findProducingRun,
  getActor,
  getDataset,
  type Actor,
  type Dataset,
  type Run,
} from '@/lib/api';

function DatasetDetailContent() {
  const params = useParams();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const id = params.id as string;

  const [dataset, setDataset] = useState<Dataset | null>(null);
  // The page DatasetView shows, for "export page".
  const [shown, setShown] = useState<DatasetPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [producingRun, setProducingRun] = useState<Run | null>(null);
  const [producingActor, setProducingActor] = useState<Actor | null>(null);

  useEffect(() => {
    let alive = true;
    getDataset(id)
      .then((d) => alive && setDataset(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!dataset) return;
    let alive = true;
    findProducingRun('dataset', dataset.id)
      .then(async (r) => {
        if (!alive || !r) return;
        setProducingRun(r);
        const a = await getActor(r.actId).catch(() => null);
        if (alive) setProducingActor(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dataset]);

  async function handleDelete() {
    const ok = await confirm({
      tone: 'danger',
      title: 'Delete dataset?',
      description: 'Items and metadata are deleted permanently. Cannot be undone.',
      confirmLabel: 'delete dataset',
    });
    if (!ok) return;
    try {
      await deleteDataset(id);
      toast.success('Dataset deleted');
      router.push(prefixPath('/datasets'));
    } catch (err) {
      toast.error('Failed to delete dataset', { description: (err as Error).message });
    }
  }

  /**
   * Export the currently visible page as a JSON file via a browser blob.
   * Convenient for spot-checks; bounded by `limit` so it can't blow up the
   * browser even on huge datasets. For full-dataset export, "download all"
   * opens the streaming endpoint in a new tab — server-side concatenation
   * with bounded-concurrency S3 reads, never materialised in browser memory.
   */
  function handleDownloadPage() {
    if (!shown) return;
    const { items, offset, limit } = shown;
    const page = Math.floor(offset / limit) + 1;
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dataset-${id.slice(0, 8)}-page-${page}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Page exported', { description: `${items.length} items` });
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[40vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!dataset) {
    return (
      <div className="grid place-items-center min-h-[40vh] text-center">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground mb-2">
            [ DATASET NOT FOUND ]
          </p>
          <AppLink href="/datasets" className="text-[13px] hover:text-signal">
            ← back to datasets
          </AppLink>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <AppLink
        href="/datasets"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> datasets
      </AppLink>

      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-5 border-b border-border">
        <div className="space-y-2 min-w-0">
          <p className="eyebrow">DATASET · {dataset.id.slice(0, 12)}</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight truncate">
            {dataset.name || 'Untitled dataset'}
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
            {dataset.id}
            <CopyButton value={dataset.id} label="Dataset ID" />
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleDownloadPage}
            disabled={!shown || shown.items.length === 0}
            title="Download just this page as JSON"
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> export page
          </button>
          <button
            type="button"
            onClick={() => {
              void downloadAsBlob(
                `/v2/datasets/${id}/items?download=1`,
                `dataset-${id}.json`
              ).catch((err) =>
                toast.error('Download failed', { description: (err as Error).message })
              );
            }}
            title="Download the full dataset as JSON"
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm"
          >
            <Download className="h-3.5 w-3.5" /> download all
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:border-fail/40 hover:text-fail rounded-sm"
          >
            <Trash2 className="h-3.5 w-3.5" /> delete
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Total items">{dataset.itemCount.toLocaleString()}</Tile>
        <Tile label="Created">{new Date(dataset.createdAt).toLocaleString()}</Tile>
        <Tile label="Modified">{new Date(dataset.modifiedAt).toLocaleString()}</Tile>
      </div>

      {/* Producer backlink */}
      {producingRun && (
        <section className="panel p-5 space-y-3">
          <p className="eyebrow">PRODUCED · BY</p>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <AppLink
              href={`/runs/${producingRun.id}`}
              className="font-mono text-foreground hover:text-signal"
            >
              run · {producingRun.id.slice(0, 12)}
            </AppLink>
            <span className="text-muted-foreground">/</span>
            {producingActor ? (
              <AppLink
                href={`/actors/${producingActor.name}`}
                className="text-foreground hover:text-signal"
              >
                {producingActor.title || producingActor.name}
              </AppLink>
            ) : (
              <span className="font-mono text-muted-foreground text-[12px]">
                actor · {producingRun.actId.slice(0, 12)}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Data viewer */}
      <section className="panel flex flex-col h-[720px] overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2 text-[13px] shrink-0">
          <FileJson className="h-3.5 w-3.5 text-signal" />
          <span className="text-foreground">Records</span>
        </header>
        <DatasetView
          key={dataset.id}
          datasetId={dataset.id}
          schema={dataset.schema}
          onPage={setShown}
        />
      </section>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow mb-2">{label}</p>
      <div className="text-foreground text-[15px] leading-tight tnum truncate">{children}</div>
    </div>
  );
}

export default function DatasetDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center min-h-[40vh]">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <DatasetDetailContent />
    </Suspense>
  );
}
