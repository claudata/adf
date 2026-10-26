# Dynamics 365 Finance & Operations → ADF → ADLS Gen2 (RAW)

Separate from `..\erp` (Business Central). Reuses the same private ADF factory, managed VNet runtime (`PrivateAzureIR`), storage account and Key Vault, but with isolated names:

| Concern | Business Central (`erp`) | Finance & Operations (`fo`) |
| --- | --- | --- |
| Pipelines | `pl-*`, `pl-odata-*` | `pl-fo-*`, `pl-fo-odata-*` |
| Linked services / datasets | `ls_business_central*`, `ds_bc_*` | `ls_fo_*`, `ds_fo_*` |
| Raw path (container `raw`) | `business-central/...` | `dynamics-fo/rest/...`, `dynamics-fo/odata/...` |
| Checkpoint table | `BcExtractionCheckpoint` | `FoExtractionCheckpoint` |
| Key Vault secret | `bc-extraction-client-secret` | `fo-extraction-client-secret` |

```
fo\
  Build-Pipelines.js            generates rest\ and odata\ templates
  rest\adf-pipelines.json       ADF REST connector variant
  odata\adf-pipelines.json      ADF native OData connector variant
  infrastructure-fo-table.json  checkpoint table + table-scoped RBAC for the factory identity
  Set-ExtractionCredential.ps1  creates an app secret and stores it only in Key Vault
  tests\pipeline-definitions.test.js
```

## 1. Prerequisites: an F&O environment

F&O cannot be created like a Business Central sandbox. You need one of:

* A **Dynamics 365 Finance trial** (signup page; typically a demo-data environment provisioned in Power Platform admin center / Dynamics 365 trial experience; allow hours).
* A tier-2+ sandbox deployed from Lifecycle Services / Power Platform admin center in a licensed customer tenant.
* A cloud-hosted development (tier-1) VM. Note: service protection limits and some online-only features do not apply to dev environments.

Demo environments normally ship with the **USMF** legal entity and demo data.

## 2. Entra app and F&O authorization

1. Register an Entra app (single tenant). Add a client secret **only through** `Set-ExtractionCredential.ps1` (stored in Key Vault, never on disk). No API permission is needed on the app for F&O; authorization is done in F&O.
2. In F&O: **System administration → Setup → Microsoft Entra ID applications**, add the app client ID, give it a name and map it to a **dedicated service user**.
3. Assign that user a least-privilege read role covering the entities you extract (for example a custom role with view access to the data entities, or *Accounts receivable clerk* for customers). Restrict the user to the required legal entities via organization/data security.
4. Optional but recommended: **System administration → Setup → Throttling priority mapping**, give this application a priority (Low/Medium/High).

## 3. Deploy

```powershell
node Build-Pipelines.js; node tests\pipeline-definitions.test.js
az deployment group create -g <rg> -n fo-table --template-file infrastructure-fo-table.json -p storageName=<storage> factoryName=<factory>
.\Set-ExtractionCredential.ps1 -SubscriptionId <sub> -ResourceGroup <rg> -ApplicationObjectId <appObjectId> -VaultName <vault>
foreach ($v in 'rest','odata') {
  az deployment group create -g <rg> -n fo-$v --template-file $v\adf-pipelines.json -p factoryName=<factory> tenantId=<tenant> clientId=<appClientId> environmentUrl=https://<env>.operations.dynamics.com storageName=<storage> vaultName=<vault>
}
```

The factory's managed identity already has Blob Data Contributor on `raw` and Key Vault Secrets User from the BC infrastructure. The F&O host must be reachable from the managed VNet runtime (public endpoint over the managed network is used; it is not a private-link source).

## 4. Pipeline design

Each variant has the same set of pipelines (REST names shown; OData adds `odata-`):

* `pl-fo-discover-legal-entities`: `GET /data/LegalEntities?cross-company=true`; fails if no legal entity is visible (verifies auth and role mapping).
* `pl-fo-extract-entity` (concurrency 1): parameters `entity`, `legalEntity` (`ALL` or a `dataAreaId` such as `usmf`), `loadMode` (`Full`/`Incremental`), `watermarkField` (default `ModifiedDateTime`), `initialWatermark`, `windowEnd`, `safetyLagSeconds`, `overlapSeconds`, `cooldownSeconds`.
  1. Validate parameters → derive checkpoint key (URL-safe Base64 of `[legalEntity, entity]`) → capture window upper bound (now − safety lag) → read checkpoint → validate window → lower bound = checkpoint − overlap.
  2. Query: `cross-company=true` plus `$filter=dataAreaId eq '<le>'` (when not `ALL`) and, for incremental, `<watermarkField> ge lower and <watermarkField> lt upper` with `$orderby`.
  3. Copy to `raw/dynamics-fo/<rest|odata>/<legalEntity>/<entity>/yyyy/MM/dd/<runId>/response-pages.json`. Paging follows `@odata.nextLink` (REST `AbsoluteUrl` rule, or the native OData connector).
  4. Verify the raw file, then (Incremental only) commit the checkpoint to Azure Table through a single-row carrier copy and read it back. Full runs never touch checkpoints.
* `pl-fo-extract-entity-full`, `pl-fo-extract-batch`, `pl-fo-extract-batch-full`: wrappers; batch items look like `{"entity":"CustomersV3","legalEntity":"usmf","loadMode":"Incremental","watermarkField":"ModifiedDateTime"}` and run sequentially.
* `pl-fo-validate-raw-json`, `pl-fo-read-checkpoint`: private-network readbacks (storage has public access disabled).

Partition key `tenant|environmentName|rest` vs `...|odata` keeps checkpoints per connector.

## 5. Limitations and rate limits (verify in current docs)

* **Server paging is capped at 10,000 records per page** (OData service); `$top` above that is not honored. Follow `@odata.nextLink`.
* **Resource-based throttling** returns HTTP 429 with `Retry-After`; thresholds depend on the Throttling Priority Mapping (Low < Medium < High). ADF copy retries use a fixed interval (default 3 × 60 s) and do not read `Retry-After`; use `cooldownSeconds`, `restRequestInterval`, and sequential batches to stay under limits.
* **User-based service protection limits** (default 6,000 requests / 5 min, 20 min combined execution time, 52 concurrent per user, app, and web server) were made optional in 10.0.35 and removed in 10.0.36; they apply only if enabled in older versions.
* **Incremental needs a modified-timestamp field.** Many standard entities do not expose `ModifiedDateTime`; use an entity or custom entity that does (table "Created/Modified date and time" system fields), otherwise use Full loads or Change Tracking / Export to Data Lake.
* **Deletes are not captured** by timestamp windows; overlap replays produce duplicates, so downstream layers must deduplicate on entity key + `dataAreaId`.
* **Cross-company**: without `cross-company=true` only the user's default company is returned; this solution always sets it.
* Only public (`IsPublic`) data entities are available; `$expand` supports first level only; `has` and `in` filter operators are unsupported.
* Large volumes: OData is not designed for bulk export. For high volume use **Export to Azure Data Lake / Synapse Link for Dataverse**, or DMF package export.
* Lookup-based validation is limited to 5,000 rows / 4 MB; the checkpoint carrier needs at least one legal entity readable by the app.

## 6. Status

Templates validated with `az deployment group validate`, deployed to the factory, and covered by static tests. **Live extraction is pending an F&O environment URL and the Entra app mapping in section 2.** After provisioning, run `pl-fo-discover-legal-entities`, then `pl-fo-extract-entity-full` for `CustomersV3`, then Incremental twice (bootstrap, delta) and read back with `pl-fo-read-checkpoint`.

## References

* [OData in F&O](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/data-entities/odata)
* [Service protection API limits](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/data-entities/service-protection-api-limits)
* [Throttling prioritization](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/data-entities/priority-based-throttling)
* [Authenticate F&O services](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/data-entities/services-home-page)
* [ADF OData connector](https://learn.microsoft.com/azure/data-factory/connector-odata)
