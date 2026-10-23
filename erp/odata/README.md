# Business Central extraction using the native ADF OData connector

This folder contains a separately deployable native OData implementation. It
reuses the parent Azure foundation, credential, managed private runtime, raw
container, and private Azure Table checkpoint store. It is not a REST connector
renamed to OData.

Deploy `..\infrastructure.json` first, approve the `storage-table` managed private
endpoint in addition to dfs/blob/vault, and then deploy this folder's
`adf-pipelines.json` with the same factory/tenant/environment/client/storage/vault
parameters as the parent template. No public storage access or account key is
required.

## Pipelines

| Pipeline | Purpose |
|---|---|
| `pl-odata-discover-companies` | Discover authorized companies as flat records and reject empty discovery |
| `pl-odata-extract-entity` | Serialized Full or Incremental extraction |
| `pl-odata-extract-entity-full` | Compatibility Full wrapper; does not seed or advance a checkpoint |
| `pl-odata-extract-batch` | Sequential metadata array with explicit `loadMode` per item |
| `pl-odata-extract-batch-full` | Sequential Full-only metadata wrapper |
| `pl-odata-read-checkpoint` | Read-only inspection of the derived checkpoint key |
| `pl-odata-validate-raw-json` | Small-file output inspection |
| `pl-odata-commit-checkpoint` | Internal atomic checkpoint writer; never schedule or call directly |

Example entity parameters:

```json
{
  "companyId": "<company-guid>",
  "entity": "customers",
  "apiPath": "api/v2.0",
  "loadMode": "Incremental",
  "initialWatermark": "1970-01-01T00:00:00Z",
  "safetyLagSeconds": 120,
  "overlapSeconds": 120,
  "cooldownSeconds": 2
}
```

The first Incremental run starts from `initialWatermark` when no row exists.
Subsequent runs read the durable watermark. A run captures one upper bound,
filters `lastModifiedDateTime ge <watermark-minus-overlap> and
lastModifiedDateTime lt <upper-bound>`, and atomically replaces the checkpoint
only after Copy succeeds and raw-output checks pass. An explicit historical
`windowEnd` may be supplied; it must advance the checkpoint and must not exceed
the current time minus safety lag.
Use ISO 8601 UTC timestamp values ending in `Z`. The checkpoint
carrier always reads the standard `api/v2.0/companies` endpoint, including when
the extracted entity uses a compatible custom API route; grant its read access.

The Table row stores the watermark, originating extraction RunId, output folder,
and lower bound. The partition includes tenant, environment, and `odata`; it is
independent of REST state. The row key is the URL-safe Base64 encoding of a JSON
array containing company ID, API path, and entity. Do not reset or modify a
checkpoint without a deliberate reconciliation plan.

Output is flat JSON business records, not REST response envelopes:

```text
raw/business-central/odata/<company-id>/<entity>/<UTC-date>/<extraction-run-id>/response-pages.json
```

## Connector-specific limitations

- Native OData follows service continuation links internally. This implementation
  does not add unsupported REST `paginationRules`, `requestInterval`, or
  per-request `Prefer` options to `ODataSource`.
- There is no `pageSize` parameter. `$top` is not used as a fake page-size control:
  it could limit the total result and lose records.
- Complex OData types are unsupported by the connector. Select/project compatible
  scalar fields in the API contract before using an affected custom entity.
- Native pagination does not preserve page envelopes or expose page-level
  checkpoints. Small demo results cannot certify multi-page production scale.
- Empty incremental results can have zero copied rows and no nonempty data file;
  the completed Copy can still safely advance the bounded-window checkpoint.
- Full runs deliberately do not update checkpoints. Start with Incremental from
  an appropriate initial boundary to bootstrap incremental state.
- Timestamp-based loads require filterable/sortable `lastModifiedDateTime`.
  Hard deletes, multi-page snapshot isolation, and downstream deduplication are
  not implemented.
- The serialized entrypoint protects writes in this one factory/variant. There
  is no distributed lease/ETag compare-and-swap across other factories, direct
  helper invocations, or independently implemented writers.
- A commit acknowledgement/readback can fail after a successful atomic write.
  Inspect checkpoint `RunId` and `OutputFolder` before diagnosing or replaying an
  ambiguous commit. The corresponding data copy/output checks precede the write.
- Retries use configurable fixed intervals, not exponential or Retry-After-aware
  backoff. Concurrency/cooldown are conservative controls, not a global rate
  limiter. Other requests under the application consume the same service budget.
- Sandbox read scale-out is unavailable; no replica performance claim is made.

See the parent README for shared security, current operational limits, and
deployment instructions. Rebuild both templates with `node ..\Build-Pipelines.js`
from this directory and run `node ..\tests\pipeline-definitions.test.js`.

The native variant passed the controlled five-customer Full/bootstrap/empty-delta/
nonadvancing-window/Full-batch matrix. Private readback matched the REST ID sets,
and Full runs preserved existing checkpoints. This does not certify production
volume, deliberately changed business records, or injected throttling recovery.
