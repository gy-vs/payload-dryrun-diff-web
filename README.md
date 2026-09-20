# Migration Mapping Studio

Local workbench for transform runs. **Dry-run only — nothing is written back to external systems.**

## Payload migration dry-run

Pick two pipeline revisions and dry-run a fixed sample set; results stream in per sample and are
aggregated by path (added / removed / type-changed / value-changed / conversion-failed).

- `POST /api/dryrun/sessions` — start a run (`{fromRevision, toRevision, sampleSetId}`); revisions and
  the sample-set version are pinned for the whole session.
- `GET /api/dryrun/sessions/:id/events` — SSE stream (`started`/`sample`/`summary`/`done`/`cancelled`).
  Reconnect with `Last-Event-ID`; the server keeps a bounded event buffer and answers with a `snapshot`
  event if older events were evicted. `Accept: application/json` returns the same replay as JSON.
- `POST /api/dryrun/sessions/:id/cancel` — cancel; in-flight sample results are discarded and no late
  results are accepted afterwards.
- Sessions expire after a TTL; expired sessions answer `410 session_expired`.
- `PUT /api/sample-sets/:id` — replace samples (bumps `version`); already-running sessions keep their
  pinned snapshot.

Array elements are aligned by configured stable keys (see `ARRAY_KEYS` in `src/server/sessions.ts`);
elements without a key fall back to positional comparison, and duplicate keys match in order of
occurrence. Conversion failures on either side are reported at key-selector paths and suppress the
redundant structural entry for the same field.

## Develop

Run `npm install`, then `npm run dev` (server on 4174, vite on 4173). `npm test` for the suite,
`npm run build` for type-check + production build.
