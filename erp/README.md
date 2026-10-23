# Business Central Online to ADLS Gen2 with Azure Data Factory

A full/incremental extraction foundation for Business Central Online, using
Entra application authentication and private access to Azure Storage and Key
Vault. The root template uses REST; [odata/](odata/README.md) contains a separately
deployable native OData implementation.

## Scope

Implemented:

- ADLS Gen2 with `raw` and `control` containers.
- ADF system-assigned identity, managed virtual network, and `PrivateAzureIR`.
- Managed private endpoints for storage `dfs`, `blob`, `table`, and Key Vault.
- Container-scoped blob roles, table-scoped checkpoint permissions, and vault access.
- A dedicated Business Central application permission definition.
- A credential provisioning script that keeps secret values in memory and sends
  them to Key Vault through a secure ARM deployment.
- Company discovery, parameterized full/incremental extraction, and sequential
  metadata-driven batches entering one serialized entity pipeline per connector.
- Durable atomic checkpoints in `BcExtractionCheckpoint` Azure Table storage,
  with tenant/environment/connector isolation and bounded timestamp windows.
- Server-provided `@odata.nextLink` pagination, fixed-interval activity retries,
  and run-specific JSON output paths.
- A small-file validation pipeline that reads output metadata and JSON through
  the private runtime without enabling public storage access.

Not implemented:

- Distributed leases or conditional ETag updates across multiple factories.
- Delete capture, key reconciliation, or downstream deduplication.
- Exponential retry/backoff or explicit `Retry-After` processing.
- Custom AL extensions, custom API pages, or custom API queries.
- Scheduled triggers.

Deployment success is not proof of successful extraction. Business Central
provisioning, sandbox-side authorization, and an end-to-end copy must be completed
and checked separately.

## Files

| File | Purpose |
| --- | --- |
| `infrastructure.json` | Storage, ADF, private runtime/endpoints, Key Vault, and RBAC |
| `application-permissions.json` | Business Central `API.ReadWrite.All` application permission |
| `credential-template.json` | Key Vault secret resource with a `securestring` parameter |
| `Set-ExtractionCredential.ps1` | Creates and stores a 90-day application credential |
| `adf-pipelines.json` | REST discovery, full/incremental extraction, checkpoints, and batches |
| `odata/adf-pipelines.json` | Independently deployed native OData variant |
| `Build-Pipelines.js` | Rebuild both templates from shared authoring logic |
| `Test-Pipelines.ps1` | Parameterized live sandbox verification with private readback |
| `tests/pipeline-definitions.test.js` | Static connector, dependency, and commit-order checks |

Live deployment state and environment-specific identifiers are intentionally
excluded. Do not commit secrets or local deployment parameter files.

## Prerequisites

- PowerShell 7 and an authenticated Azure CLI session.
- An Azure subscription with `Microsoft.Storage`, `Microsoft.KeyVault`, and
  `Microsoft.DataFactory` registered.
- Rights to create resources and role assignments in the target resource group.
- Microsoft Entra rights to register an application, create its service principal,
  grant application consent, and manage its credentials.
- A Business Central Online sandbox that is Active and contains sample data.
- Business Central administrative access for application and permission setup.

Azure usage is billed independently of the Business Central trial. The managed
runtime and private networking can add charges.

## 1. Deploy the foundation

Run from this directory. Replace the placeholders; select a globally unique
lowercase alphanumeric suffix of 3-12 characters.

```powershell
$subscriptionId = '<subscription-id>'
$resourceGroup = '<resource-group>'
$location = 'eastus2'
$suffix = '<unique-suffix>'
$operatorObjectId = '<signed-in-user-object-id>'

az group create --subscription $subscriptionId --name $resourceGroup --location $location
az deployment group validate --subscription $subscriptionId --resource-group $resourceGroup `
    --template-file .\infrastructure.json `
    --parameters location=$location suffix=$suffix operatorObjectId=$operatorObjectId
az deployment group create --subscription $subscriptionId --resource-group $resourceGroup `
    --name bc-adf-foundation --template-file .\infrastructure.json `
    --parameters location=$location suffix=$suffix operatorObjectId=$operatorObjectId
```

Read the deployment outputs for `factoryName`, `storageName`, and `vaultName`.
The template's operator role assignments expect a user object ID, not a service
principal ID. ADF gets access to the two containers, the specific checkpoint
table, and the vault; the operator gets storage-account blob data access and
Key Vault Secrets Officer access.

Storage and Key Vault public network access remain disabled. Approve the four
private endpoint connections only after verifying they were requested by the
new factory for `storage-dfs`, `storage-blob`, `storage-table`, and `key-vault`. List each target's
connections with `az network private-endpoint-connection list --id <resource-id>`,
then approve each verified connection:

```powershell
az network private-endpoint-connection approve --id '<verified-connection-resource-id>' `
    --description 'Approved ADF extraction managed private endpoint'
```

These managed private endpoints give ADF private connectivity; they do not give
the local machine direct storage or vault data-plane access. Use an approved
private-network client for local data inspection. The credential script uses the
documented ARM secret-resource deployment path without enabling public access.

## 2. Register the extraction application

Register a single-tenant Entra application with
`application-permissions.json`, create its service principal, and grant
administrator consent. Use the Business Central tenant for registration.

```powershell
az ad app create --display-name '<extraction-app-name>' --sign-in-audience AzureADMyOrg `
    --required-resource-accesses .\application-permissions.json

$clientId = '<application-client-id>'
$applicationObjectId = '<application-object-id>'
az ad sp create --id $clientId
az ad app permission admin-consent --id $clientId
```

`API.ReadWrite.All` is the Entra application permission for ordinary Business
Central APIs. Restrict effective access to read-only operations using permission
sets inside Business Central. `Automation.ReadWrite.All` is not requested.

Store a credential without printing it or saving its value to a local file:

```powershell
$vaultName = '<deployed-vault-name>'
.\Set-ExtractionCredential.ps1 -SubscriptionId $subscriptionId `
    -ResourceGroup $resourceGroup -ApplicationObjectId $applicationObjectId `
    -VaultName $vaultName
```

The script uses the application's object ID, not its client ID. It creates a
90-day secret named `bc-extraction-client-secret` in the vault and revokes the
new application credential if secure storage is not confirmed. Rotate before
expiration; after verifying a replacement, retire its superseded app credential.
Do not run concurrent rotations.

Inside the sandbox, open **Microsoft Entra applications** and add the client ID.
Keep State **Disabled** while editing User Permission Sets, assign the minimum
read permissions required by the chosen APIs, and set Company explicitly to the
intended demonstration company. `D365 READ` scoped to `CRONUS USA, Inc.` was used
for the customer extraction test. Save, then set State to **Enabled**. Do not
assign SUPER or leave Company blank unintentionally. The admin center's similarly
named app page does not replace sandbox-side data authorization.

## 3. Deploy the pipelines

```powershell
$factoryName = '<deployed-factory-name>'
$storageName = '<deployed-storage-name>'
$tenantId = '<business-central-tenant-id>'
$environment = '<exact-sandbox-environment-name>'

az deployment group create --subscription $subscriptionId --resource-group $resourceGroup `
    --name bc-adf-pipelines --template-file .\adf-pipelines.json `
    --parameters factoryName=$factoryName storageName=$storageName vaultName=$vaultName `
        tenantId=$tenantId clientId=$clientId environment=$environment
```

All linked services use `PrivateAzureIR`. The REST linked service requests the
resource `https://api.businesscentral.dynamics.com` and reads its credential from
Key Vault. Its fixed base URL targets the specified tenant and environment.

Deploy the OData version using the same command and parameters but with
`--template-file .\odata\adf-pipelines.json` and a distinct deployment name.
Both variants can coexist in the same factory; checkpoint partitions and raw
paths are separate. Shared linked services/datasets have identical definitions.

Optional deployment parameters are `copyRetries` (default 3),
`retryIntervalSeconds` (default 60; minimum 30), and `restRequestInterval`
(default `00.00:00:01`; allowed values also include 2, 5, and 10 seconds).
`restRequestInterval` does not add pacing to native OData.

## 4. Run the first extraction

In ADF Studio, run `pl-discover-companies`. Its `ReadCompanies` activity returns
raw response envelopes after copying them into:

```text
raw/business-central/company-discovery/<run-id>/companies.json
```

The Lookup output's `value` array contains response envelopes; each envelope has
its own `value` array containing company IDs and names. Flatten those inner
arrays and confirm that the intended company is present. Discovery fails with
`EmptyCompanyDiscovery` if every response envelope has an empty company list.
Check the enabled application's company-scoped BC permissions before assuming
that the sandbox lacks data; Entra API consent alone is insufficient.

Select the demonstration company, then run `pl-extract-entity-full` with:

```json
{
  "companyId": "<selected-company-guid>",
  "entity": "customers",
  "apiPath": "api/v2.0",
  "pageSize": 2
}
```

Use a sample company containing more than two customers to exercise pagination.
Verify every page and the complete customer ID set before increasing page size
to the default of 1000. Retry intervals default to a fixed 60 seconds; retries restart
the activity and are not page-level CDC recovery.

Output preserves complete REST response envelopes, including their `value`
arrays, in a JSON array:

```text
raw/business-central/<company-id>/<entity>/<yyyy>/<MM>/<dd>/<extraction-run-id>/response-pages.json
```

Run IDs isolate successful runs, but no storage immutability policy is configured.
Consumers must use only successful runs and must not combine failed partial
output with a later successful attempt. Activity retry behavior and complete
output should be checked before treating a load as authoritative.

For multiple explicitly selected entities, run `pl-extract-batch-full` with:

```json
{
  "entities": [
    {
      "companyId": "<selected-company-guid>",
      "entity": "customers",
      "apiPath": "api/v2.0",
      "pageSize": 1000
    }
  ]
}
```

The batch is sequential, and all extraction calls enter
`pl-extract-entity` with concurrency 1. The Full wrapper waits for a child
extraction: use that child's RunId, not the wrapper or batch parent's RunId,
when finding the output folder.
`apiPath` may target an already installed custom API, but this repository does
not create or publish an AL extension.

Run `pl-validate-raw-json` with `folderPath` pointing to a successful extraction's
directory relative to `raw`, and `fileName` set to `response-pages.json`. Its
`InspectFile` activity returns existence, size, and modification time.
`ReadRawFile` reads the actual stored JSON through `PrivateAzureIR`. Lookup is
limited to 5,000 rows and 4 MB, so this is intended only for small demonstration
files, not production-scale validation.

To test pagination, compare the complete unique customer ID sets from a
page-size-2 extraction and a page-size-1000 baseline, verify there are no
duplicates, and inspect page continuations and the final response. A pipeline
success status or copied-byte count alone does not establish completeness.

Dataset and linked-service identifiers use underscores. A hyphenated dataset
identifier produced an invalid generated runtime expression during live testing,
even though ARM deployment validation succeeded.

## 5. Incremental extraction and durable checkpoints

Run `pl-extract-entity` directly with:

```json
{
  "companyId": "<selected-company-guid>",
  "entity": "customers",
  "apiPath": "api/v2.0",
  "loadMode": "Incremental",
  "pageSize": 1000,
  "initialWatermark": "1970-01-01T00:00:00Z",
  "safetyLagSeconds": 120,
  "overlapSeconds": 120,
  "cooldownSeconds": 2
}
```

The OData counterpart is `pl-odata-extract-entity`; omit `pageSize`.
Supply `initialWatermark` and any explicit `windowEnd` as ISO 8601 UTC timestamps
ending in `Z` to avoid locale-dependent or ambiguous input.
For `pl-extract-batch` / `pl-odata-extract-batch`, supply an `entities` array.
Each item explicitly specifies `companyId`, `entity`, `apiPath`, `loadMode`, and
REST-only `pageSize`. Optional single-entity window settings use their defaults
in these batch pipelines.

Activity sequence:

1. Validate mode/settings and derive the stable checkpoint key.
2. Capture one upper bound: current UTC time minus safety lag, or explicit
   historical `windowEnd`.
3. Read the durable Table row. Only a genuinely absent row bootstraps from
   `initialWatermark`; storage, authentication, and parsing errors fail the run.
4. Reject nonadvancing/future incremental windows. Calculate the lower bound as
   the committed watermark minus overlap.
5. Wait for the configured cooldown, then copy all source pages satisfying
   `lastModifiedDateTime ge <lower> and lastModifiedDateTime lt <upper>`.
6. Check raw-file metadata. Nonzero copied rows require a nonempty file. Native
   OData zero-row deltas may have no data file or an empty file.
7. Only in Incremental mode, invoke the internal commit helper. It atomically
   replaces one Azure Table entity using the authorized standard `api/v2.0`
   company record as a single-row carrier for mapped checkpoint metadata, even
   when extracting a compatible custom API route. Read access to that standard
   company endpoint is required. No BC business record is written or changed.
8. Read the committed row and confirm exactly one write, the expected watermark,
   and the originating extraction RunId.

The Table entity records `Watermark`, `RunId`, `OutputFolder`, and `LowerBound`.
Its partition includes tenant, environment, and connector. Its row key is the
URL-safe Base64 encoding of a JSON array of company ID, API path, and entity.
`pl-read-checkpoint` / `pl-odata-read-checkpoint` provide private read-only
inspection using the same company/entity/API identity.

Full mode does not seed or change a watermark. A first Incremental run with an
old `initialWatermark` is the bounded initial load for incremental state.
Checkpoint state is deliberately isolated between REST and OData, so switching
connectors does not silently reuse the other variant's progress.

The commit helper is internal: never call it directly or schedule it. Only the
serialized entity entrypoint may write this variant's state. An atomic entity
replacement is not a distributed lease/compare-and-swap across factories. If a
write succeeds but its acknowledgement/readback fails, inspect `RunId` and
`OutputFolder`; do not reset state blindly. Data copy/output checks precede the
write, but no distributed transaction spans raw storage and the checkpoint.

Overlap deliberately replays records; downstream consumers must upsert/deduplicate
using company and stable record ID. Hard deletes are not captured. Custom APIs
must expose a filterable and sortable `lastModifiedDateTime`; unsupported schemas
fail instead of advancing the checkpoint.

## 6. Operational limits and remaining limitations

Documentation reviewed October 22, 2026:

| Business Central Online OData limit | Documented value |
|---|---|
| Concurrent processed requests per user/application | 5 |
| Connections including queued requests per user/application | 100 |
| Queued requests per user/application | 95 |
| Requests per five-minute sliding window per user/application | 6,000 |
| Maximum page size | 20,000 entities |
| Service operation timeout | 8 minutes |

Application users/service principals are subject to these limits. Review the
current per-user table and rollout notes, not only older per-environment
300/600-per-minute figures. These are service ceilings, not guaranteed throughput.

Each variant serializes entity extraction and uses a default 2-second entity
cooldown. REST also spaces page requests by one second. Native OData follows
continuations internally without an exposed per-page pacing control here. Both
variants share the application's overall service budget; other pipelines and
applications using that principal also consume it.

Fixed retries are configurable, but neither version implements exponential
backoff, jitter, explicit `Retry-After` processing, or a global request-rate
limiter. No 429/503 fault injection or production-volume benchmark is certified.
Small-file Lookup readback is limited to 5,000 rows/4 MB; large-scale business-ID
reconciliation needs a different engine.

Native OData returns flat business records and does not preserve REST page
envelopes. Complex OData types are unsupported. Its supported source options do
not provide this implementation's REST `pageSize`/header control; `$top` must
not be used to fake pagination because it can truncate the full result.

Timestamp windows do not guarantee snapshot isolation, detect deletes, or
eliminate all replica-lag/concurrent-update edge cases. Tune overlap/safety lag
and reconcile periodically. BC Online is not directly queried through SQL.
Sandbox environments cannot use read scale-out; production eligibility and
replica routing/performance require separate verification. Custom AL APIs,
scheduling, alerts, retention policies, and downstream merges remain separate.

## 7. Validation

```powershell
node .\Build-Pipelines.js
node .\tests\pipeline-definitions.test.js
```

`Test-Pipelines.ps1` runs both connector variants against a controlled demo
company. It checks Full, initial incremental bootstrap, an empty later window,
rejection of a nonadvancing window without checkpoint mutation, and a Full
metadata batch without checkpoint mutation. It compares actual customer IDs
through private readback. Use a company with the expected number of old demo
customers and choose a bootstrap boundary after their modification timestamps
but before now minus safety lag.

```powershell
.\Test-Pipelines.ps1 -SubscriptionId '<subscription>' -ResourceGroup '<group>' `
    -FactoryName '<factory>' -CompanyId '<demo-company-guid>' `
    -BootstrapWindowEnd '<historical-UTC-boundary>' `
    -EvidenceDirectory '<private-local-evidence-folder>' -ExpectedCustomers 5
```

Do not publish live evidence. Bootstrap is intended for a fresh checkpoint;
do not erase a real checkpoint to repeat the test. Use `-Stages` and `-Variants`
to resume independent completed stages deliberately.

### Original full-load demonstration baseline

Live customer tests against a CRONUS demonstration company returned five unique
customer IDs. A page-size-1000 baseline produced one response envelope; both
page-size-2 direct and metadata-driven batch runs produced three. Private-runtime
readback confirmed nonempty JSON files and identical complete customer ID sets,
without duplicates. Authorized discovery passed, while replaying an actual empty
company response failed with `EmptyCompanyDiscovery` as intended.

These are small-sample full-load results, not a production-scale or
incremental-processing certification. Other entities and injected throttling
failures were not tested. Live environment identifiers and raw evidence are not
published in this repository.

### Verified full/incremental demonstration

Both deployed variants passed the five-scenario sandbox matrix: Full (five
customers), bounded incremental bootstrap (five), subsequent empty delta (zero),
expected rejection of a nonadvancing window, and a Full metadata batch (five).
Private readback confirmed the same five unique customer IDs across Full,
Bootstrap, and Batch for both connectors. REST page-size-2 outputs contained
2/2/1 records with a terminal page lacking `nextLink`; native output was flat.
Bootstrap and empty delta durably committed their originating RunIds and window
boundaries. The rejected window and Full batch preserved checkpoint state.
Invalid REST page sizes 0 and 20001 failed before Copy.
Additional Full runs after the final redeployment returned the same five IDs and
preserved the already-advanced checkpoints.

This is small-sample filter/checkpoint validation, not certification of modified
business records, deletions, replica-lag behavior, competing writers, throttling
fault recovery, or native OData multi-page production throughput.

## References

- [Business Central trial signup](https://learn.microsoft.com/en-us/dynamics365/business-central/trial-signup)
- [Business Central environment administration](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/tenant-admin-center-environments)
- [Business Central service-to-service authentication](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication)
- [ADF REST connector](https://learn.microsoft.com/en-us/azure/data-factory/connector-rest)
- [ADF OData connector](https://learn.microsoft.com/en-us/azure/data-factory/connector-odata)
- [ADF Azure Table connector](https://learn.microsoft.com/en-us/azure/data-factory/connector-azure-table-storage)
- [Business Central extraction guidance](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-extract-data)
- [Business Central operational limits](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/operational-limits-online)
- [Read scale-out and sandbox restrictions](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/database-read-scale-out-overview)
- [Key Vault secret ARM resource](https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/vaults/secrets)
