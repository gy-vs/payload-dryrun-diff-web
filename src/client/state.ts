import type {RunEvent, RunSnapshot, SnapshotEvent} from '../shared/types';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'expired';

export interface ClientState {
  run: RunSnapshot | null;
  connection: ConnectionState;
  /** Durable high-water mark: latest buffered event id already applied. */
  lastEventId: number;
  /** Set when the server could no longer replay from our lastEventId. */
  bufferLost: boolean;
  /** Set when the catalog generation changed after the run started. */
  staleGeneration: boolean;
  notice: string | null;
}

export const initialClientState: ClientState = {
  run: null,
  connection: 'idle',
  lastEventId: 0,
  bufferLost: false,
  staleGeneration: false,
  notice: null,
};

export type Action =
  | {type: 'run_created'; run: RunSnapshot}
  | {type: 'connection'; state: ConnectionState}
  | {type: 'event'; event: RunEvent; id?: number}
  | {type: 'snapshot'; event: SnapshotEvent}
  | {type: 'stale_generation'; actual: number}
  | {type: 'notice'; notice: string | null}
  | {type: 'clear'};

/**
 * Pure reducer for the dry-run review session.
 *
 * Durable events carry monotonically increasing ids; anything at or below
 * the applied high-water mark is ignored, which makes reconnect replay and
 * duplicate delivery harmless. `snapshot` replaces the run wholesale and
 * resets the water mark to its embedded value.
 */
export function clientReducer(state: ClientState, action: Action): ClientState {
  switch (action.type) {
    case 'run_created':
      return {...initialClientState, run: action.run, connection: 'connecting'};

    case 'connection':
      return {...state, connection: action.state};

    case 'snapshot':
      return {
        ...state,
        run: action.event.run,
        lastEventId: Math.max(state.lastEventId, action.event.lastEventId),
        bufferLost: state.lastEventId > 0 && state.lastEventId < action.event.lastEventId,
        connection: 'open',
      };

    case 'event': {
      const event = action.event;
      if (action.id !== undefined && action.id <= state.lastEventId) return state;
      if (state.run && 'runId' in event && event.runId !== state.run.runId) {
        return state; // late event from a previous/cancelled run
      }
      if (!state.run) return state;

      const water =
        action.id !== undefined ? Math.max(state.lastEventId, action.id) : state.lastEventId;

      switch (event.type) {
        case 'sample_started':
          return {
            ...state,
            lastEventId: water,
            run: {
              ...state.run,
              inFlight: state.run.inFlight.includes(event.sampleId)
                ? state.run.inFlight
                : [...state.run.inFlight, event.sampleId],
            },
          };
        case 'sample_result': {
          if (state.run.results[event.sample.sampleId]) return state; // dedupe
          return {
            ...state,
            lastEventId: water,
            run: {
              ...state.run,
              results: {...state.run.results, [event.sample.sampleId]: event.sample},
              inFlight: state.run.inFlight.filter(id => id !== event.sample.sampleId),
            },
          };
        }
        case 'run_completed':
          return {
            ...state,
            lastEventId: water,
            run: {...state.run, status: event.status, inFlight: [], finishedAt: event.at},
            connection: 'closed',
          };
        case 'run_expired':
          return {
            ...state,
            lastEventId: water,
            run: {...state.run, status: 'expired', inFlight: []},
            connection: 'expired',
          };
      }
      return state;
    }

    case 'stale_generation':
      return {
        ...state,
        staleGeneration: true,
        notice: `样例集合已更新（第 ${action.actual} 代）。当前结果仍可审阅，请新建运行获取最新集合。`,
      };

    case 'notice':
      return {...state, notice: action.notice};

    case 'clear':
      return initialClientState;
  }
}
