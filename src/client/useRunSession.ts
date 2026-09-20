import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import type {Catalog, RunSnapshot, RunEvent, SnapshotEvent} from '../shared/types';
import {clientReducer, initialClientState, type ClientState} from './state';
import {buildBuckets, summarize} from '../shared/summary';

interface UseRunSession {
  catalog: Catalog | null;
  catalogError: string | null;
  state: ClientState;
  selectedPath: string | null;
  selectPath: (path: string | null) => void;
  startRun: (leftRevisionId: string, rightRevisionId: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  buckets: ReturnType<typeof buildBuckets>;
  totals: ReturnType<typeof summarize> | null;
}

export function useRunSession(): UseRunSession {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(clientReducer, initialClientState);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  // Generation pinned when the run was created; used to notice set rotations.
  const pinnedGenerationRef = useRef<number | null>(null);

  const refreshCatalog = useCallback(async () => {
    try {
      const response = await fetch('/api/catalog');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as Catalog;
      setCatalog(previous => {
        if (
          previous &&
          pinnedGenerationRef.current !== null &&
          next.sampleGeneration !== pinnedGenerationRef.current
        ) {
          dispatch({type: 'stale_generation', actual: next.sampleGeneration});
        }
        return next;
      });
      setCatalogError(null);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
    const timer = setInterval(() => void refreshCatalog(), 10_000);
    return () => clearInterval(timer);
  }, [refreshCatalog]);

  const closeSource = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (runId: string, reconnect: boolean) => {
      closeSource();
      dispatch({type: 'connection', state: reconnect ? 'reconnecting' : 'connecting'});
      const source = new EventSource(`/api/runs/${runId}/events`);
      esRef.current = source;

      const handleSnapshot = (raw: MessageEvent) => {
        const event = JSON.parse(raw.data) as SnapshotEvent;
        lastEventIdRef.current = Math.max(lastEventIdRef.current, event.lastEventId);
        dispatch({type: 'snapshot', event});
      };
      const handle = (name: RunEvent['type']) => (raw: MessageEvent) => {
        const event = JSON.parse(raw.data) as RunEvent;
        const id = raw.lastEventId ? Number(raw.lastEventId) : undefined;
        if (id !== undefined && Number.isInteger(id)) lastEventIdRef.current = id;
        dispatch({type: 'event', event, id});
      };

      source.addEventListener('snapshot', handleSnapshot as EventListener);
      source.addEventListener('sample_started', handle('sample_started'));
      source.addEventListener('sample_result', handle('sample_result'));
      source.addEventListener('run_completed', handle('run_completed'));
      source.addEventListener('run_expired', handle('run_expired'));

      source.onopen = () => {
        dispatch({type: 'connection', state: 'open'});
      };
      source.onerror = async () => {
        // EventSource auto-reconnects; only treat as hard failure when the
        // session is genuinely gone (404 on the run resource).
        if (source.readyState !== EventSource.CLOSED) {
          dispatch({type: 'connection', state: 'reconnecting'});
          return;
        }
        try {
          const response = await fetch(`/api/runs/${runId}`);
          if (response.status === 404) {
            dispatch({type: 'event', event: {type: 'run_expired', runId, at: new Date().toISOString()}});
          } else {
            dispatch({type: 'connection', state: 'reconnecting'});
          }
        } catch {
          dispatch({type: 'connection', state: 'reconnecting'});
        }
      };
    },
    [closeSource],
  );

  const startRun = useCallback(
    async (leftRevisionId: string, rightRevisionId: string) => {
      closeSource();
      runIdRef.current = null;
      lastEventIdRef.current = 0;
      const expectedGeneration = catalog?.sampleGeneration;
      pinnedGenerationRef.current = expectedGeneration ?? null;
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          leftRevisionId,
          rightRevisionId,
          expectedGeneration,
        }),
      });
      if (response.status === 409) {
        const body = (await response.json()) as {actual?: number; catalog?: Catalog};
        if (body.catalog) setCatalog(body.catalog);
        dispatch({type: 'stale_generation', actual: body.actual ?? 0});
        await refreshCatalog();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const run = (await response.json()) as RunSnapshot;
      setSelectedPath(null);
      dispatch({type: 'run_created', run});
      runIdRef.current = run.runId;
      connect(run.runId, false);
    },
    [catalog, closeSource, connect, refreshCatalog],
  );

  const cancelRun = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    await fetch(`/api/runs/${runId}/cancel`, {method: 'POST'});
    // Keep the stream open long enough to receive run_completed(cancelled),
    // then close; late results never arrive because the server drops them.
    setTimeout(() => closeSource(), 1000);
  }, [closeSource]);

  const selectPath = useCallback((path: string | null) => {
    setSelectedPath(path);
  }, []);

  useEffect(() => closeSource, [closeSource]);

  const buckets = useMemo(
    () => buildBuckets(state.run?.results ?? {}),
    [state.run],
  );
  const totals = useMemo(
    () =>
      state.run
        ? summarize(state.run.results, state.run.sampleIds.length)
        : null,
    [state.run],
  );

  return {
    catalog,
    catalogError,
    state,
    selectedPath,
    selectPath,
    startRun,
    cancelRun,
    refreshCatalog,
    buckets,
    totals,
  };
}
