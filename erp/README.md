# Business Central Online to ADLS Gen2 with Azure Data Factory

A first-stage extraction foundation for Business Central Online, using Entra
application authentication and private access to Azure Storage and Key Vault.

## Scope

Implemented:

- ADLS Gen2 with `raw` and `control` containers.
- ADF system-assigned identity, managed virtual network, and `PrivateAzureIR`.
- Managed private endpoints for storage `dfs`, storage `blob`, and Key Vault.
- Container-scoped ADF storage roles and Key Vault secret-read access.
- A dedicated Business Central application permission definition.
- A credential provisioning script that keeps secret values in memory and sends
  them to Key Vault through a secure ARM deployment.
- Company discovery, parameterized full extraction, and a metadata-driven batch
  pipeline with bounded concurrency.
- Server-provided `@odata.nextLink` pagination, fixed-interval activity retries,
  and run-specific JSON output paths.
- A small-file validation pipeline that reads output metadata and JSON through
  the private runtime without enabling public storage access.

Not implemented:

- Durable incremental watermarks or transactional checkpoint advancement.
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
| `adf-pipelines.json` | Linked services, datasets, discovery, full extraction, and batch pipelines |

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
principal ID. ADF gets access only to the two containers and the vault; the
operator gets storage-account data access and Key Vault Secrets Officer access.

Storage and Key Vault public network access remain disabled. Approve the three
private endpoint connections only after verifying they were requested by the
new factory for `storage-dfs`, `storage-blob`, and `key-vault`. List each target's
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
to the default of 1000. Retry intervals are fixed at 30 seconds; retries restart
the activity and are not page-level CDC recovery.

Output preserves complete REST response envelopes, including their `value`
arrays, in a JSON array:

```text
raw/business-central/<company-id>/<entity>/<yyyy>/<MM>/<dd>/<run-id>/response-pages.json
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

The batch pipeline starts at most two child extractions concurrently.
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

### Demonstration validation

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

## Next implementation phase

After a verified full-load baseline, design durable per-company/entity
checkpoints, bounded incremental windows with overlap, successful-run-only
watermark commits, downstream deduplication, and explicit delete handling.
The presence of a `control` container does not implement those mechanisms.

## References

- [Business Central trial signup](https://learn.microsoft.com/en-us/dynamics365/business-central/trial-signup)
- [Business Central environment administration](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/tenant-admin-center-environments)
- [Business Central service-to-service authentication](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication)
- [ADF REST connector](https://learn.microsoft.com/en-us/azure/data-factory/connector-rest)
- [Key Vault secret ARM resource](https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/vaults/secrets)
