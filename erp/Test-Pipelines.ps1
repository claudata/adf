[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $SubscriptionId,
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $FactoryName,
    [Parameter(Mandatory)][guid] $CompanyId,
    [Parameter(Mandatory)][string] $BootstrapWindowEnd,
    [Parameter(Mandatory)][string] $EvidenceDirectory,
    [ValidateSet('Full', 'Bootstrap', 'Delta', 'Failure', 'Batch')]
    [string[]] $Stages = @('Full', 'Bootstrap', 'Delta', 'Failure', 'Batch'),
    [ValidateSet('rest', 'odata')][string[]] $Variants = @('rest', 'odata'),
    [int] $ExpectedCustomers = 5
)

$ErrorActionPreference = 'Stop'
$token = az account get-access-token --subscription $SubscriptionId --resource https://management.azure.com/ --query accessToken -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Azure authentication failed.' }
$headers = @{ Authorization = "Bearer $token" }
$base = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.DataFactory/factories/$FactoryName"
$null = New-Item -ItemType Directory -Path $EvidenceDirectory -Force

function Request-Adf {
    param([string] $Path, [string] $Method = 'Get', $Body)
    $arguments = @{ Uri = "$base/${Path}?api-version=2018-06-01"; Method = $Method; Headers = $headers }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $arguments.ContentType = 'application/json'
        $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 40 -Compress
    }
    Invoke-RestMethod @arguments
}
function Start-Adf {
    param([string] $Pipeline, $Parameters)
    (Request-Adf "pipelines/$Pipeline/createRun" Post $Parameters).runId
}
function Save-Json {
    param([string] $Name, $Value)
    ConvertTo-Json -InputObject $Value -Depth 80 |
        Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$Name.json") -Encoding utf8
}
function Wait-Runs {
    param([hashtable] $Runs, [string] $Stage, [string] $ExpectedStatus = 'Succeeded')
    $pending = @{} + $Runs
    $results = @{}
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(25)
    while ($pending.Count) {
        foreach ($variant in @($pending.Keys)) {
            $id = $pending[$variant]
            $run = Request-Adf "pipelineruns/$id"
            if ($run.status -notin @('Succeeded', 'Failed', 'Cancelled')) { continue }
            $query = @{
                lastUpdatedAfter = [DateTimeOffset]::UtcNow.AddDays(-1).ToString('o')
                lastUpdatedBefore = [DateTimeOffset]::UtcNow.AddHours(1).ToString('o')
            }
            $activities = (Request-Adf "pipelineruns/$id/queryActivityruns" Post $query).value
            $results[$variant] = @{ run = $run; activities = $activities }
            Save-Json "$Stage-$variant" $results[$variant]
            Write-Host "$Stage/$variant : $($run.status) ($id)"
            $pending.Remove($variant)
        }
        if (-not $pending.Count) { break }
        if ([DateTimeOffset]::UtcNow -gt $deadline) { throw "Runs remain active after the monitoring timeout: $($pending.Values -join ', ')" }
        Start-Sleep -Seconds 15
    }
    foreach ($variant in $results.Keys) {
        if ($results[$variant].run.status -ne $ExpectedStatus) {
            $results[$variant].activities | Where-Object status -eq Failed |
                Select-Object activityName, error | ConvertTo-Json -Depth 10 | Write-Host
            throw "$Stage/$variant expected $ExpectedStatus; inspect saved evidence."
        }
    }
    return $results
}
function Parameters {
    param([string] $Variant, [string] $Mode = 'Full')
    $p = @{ companyId = "$CompanyId"; entity = 'customers'; apiPath = 'api/v2.0'; loadMode = $Mode }
    if ($Variant -eq 'rest') { $p.pageSize = 2 }
    return $p
}
function Prefix {
    param([string] $Variant)
    if ($Variant -eq 'odata') { 'pl-odata-' } else { 'pl-' }
}
function Read-Outputs {
    param([hashtable] $Results, [string] $Stage, [int] $ExpectedRecords)
    $runs = @{}
    $observations = @{}
    foreach ($variant in $Results.Keys) {
        $evidence = $Results[$variant]
        $copy = @($evidence.activities | Where-Object { $_.activityName -eq 'CopyEntity' -and $_.status -eq 'Succeeded' })[-1]
        if ($variant -eq 'odata' -and $copy.output.rowsCopied -eq 0) {
            if ($ExpectedRecords -ne 0) { throw 'OData copied no expected customers.' }
            $observations[$variant] = @{ records = 0; ids = @(); emptyCopy = $true; extractionRunId = $evidence.run.runId }
            continue
        }
        $date = ([DateTimeOffset]$evidence.run.runStart).UtcDateTime.ToString('yyyy/MM/dd')
        $connectorPath = if ($variant -eq 'odata') { 'odata/' } else { '' }
        $folder = "business-central/$connectorPath$CompanyId/customers/$date/$($evidence.run.runId)"
        $runs[$variant] = Start-Adf "$(Prefix $variant)validate-raw-json" @{ folderPath = $folder; fileName = 'response-pages.json' }
    }
    if ($runs.Count) {
        $readbacks = Wait-Runs $runs "$Stage-readback"
        foreach ($variant in $readbacks.Keys) {
            $lookup = @($readbacks[$variant].activities | Where-Object { $_.activityName -eq 'ReadRawFile' -and $_.status -eq 'Succeeded' })[-1]
            $rows = @($lookup.output.value)
            $records = if ($variant -eq 'rest') { @($rows | ForEach-Object { $_.value }) } else { $rows }
            $ids = @($records | ForEach-Object { $_.id } | Sort-Object)
            if ($records.Count -ne $ExpectedRecords) { throw "$Stage/$variant expected $ExpectedRecords customers, got $($records.Count)." }
            if (@($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count) { throw 'Missing customer ID.' }
            if (@($ids | Sort-Object -Unique).Count -ne $ids.Count) { throw 'Duplicate customer IDs.' }
            $observations[$variant] = @{
                records = $records.Count; ids = $ids; extractionRunId = $Results[$variant].run.runId
                readbackRunId = $readbacks[$variant].run.runId
                folderPath = $readbacks[$variant].run.parameters.folderPath
            }
        }
    }
    if ($observations.Count -eq 2 -and $ExpectedRecords -gt 0) {
        if (@(Compare-Object $observations.rest.ids $observations.odata.ids).Count) { throw 'REST and OData customer ID sets differ.' }
    }
    Save-Json "$Stage-comparison" $observations
    return $observations
}
function Read-Checkpoints {
    param([string] $Stage)
    $runs = @{}
    foreach ($variant in $Variants) {
        $p = Parameters $variant
        $p.Remove('loadMode')
        $runs[$variant] = Start-Adf "$(Prefix $variant)read-checkpoint" $p
    }
    Wait-Runs $runs "$Stage-checkpoint"
}

foreach ($stage in $Stages) {
    $runs = @{}
    $before = if ($stage -in @('Full', 'Failure', 'Batch')) { Read-Checkpoints "$stage-before" }
    foreach ($variant in $Variants) {
        $p = Parameters $variant
        $pipeline = "$(Prefix $variant)extract-entity"
        switch ($stage) {
            Bootstrap { $p.loadMode = 'Incremental'; $p.windowEnd = $BootstrapWindowEnd }
            Delta { $p.loadMode = 'Incremental' }
            Failure { $p.loadMode = 'Incremental'; $p.windowEnd = '1970-01-01T00:00:00Z' }
            Batch {
                $pipeline = "$(Prefix $variant)extract-batch"
                $p = @{ entities = @($p) }
            }
        }
        $runs[$variant] = Start-Adf $pipeline $p
    }
    Save-Json "$stage-run-ids" $runs
    $expected = if ($stage -eq 'Failure') { 'Failed' } else { 'Succeeded' }
    $results = Wait-Runs $runs $stage $expected
    if ($stage -eq 'Failure') {
        foreach ($variant in $Variants) {
            $errors = @($results[$variant].activities | Where-Object { $_.error.errorCode -eq 'InvalidIncrementalWindow' })
            if (-not $errors.Count) { throw "$variant did not reject the invalid incremental window." }
        }
    } elseif ($stage -eq 'Batch') {
        $children = @{}
        foreach ($variant in $Variants) {
            $child = @($results[$variant].activities | Where-Object activityName -eq ExtractEntity)[-1].output.pipelineRunId
            if (-not $child) { throw 'Batch child run ID is missing.' }
            $children[$variant] = $child
        }
        $childResults = Wait-Runs $children 'Batch-child'
        $null = Read-Outputs $childResults $stage $ExpectedCustomers
    } else {
        $count = if ($stage -eq 'Delta') { 0 } else { $ExpectedCustomers }
        $null = Read-Outputs $results $stage $count
    }
    $after = Read-Checkpoints "$stage-after"
    foreach ($variant in $Variants) {
        $lookup = @($after[$variant].activities | Where-Object activityName -eq ReadCheckpoint)[-1].output
        if ($stage -in @('Bootstrap', 'Delta')) {
            if ($lookup.count -ne 1 -or $lookup.value[0].RunId -ne $results[$variant].run.runId) { throw 'Checkpoint was not durably committed by this extraction.' }
        }
        if ($stage -in @('Full', 'Failure', 'Batch')) {
            $prior = @($before[$variant].activities | Where-Object activityName -eq ReadCheckpoint)[-1].output
            if ($lookup.count -ne $prior.count -or $lookup.value[0].Watermark -ne $prior.value[0].Watermark -or $lookup.value[0].RunId -ne $prior.value[0].RunId) {
                throw "$stage unexpectedly modified a checkpoint."
            }
        }
    }
    Save-Json "$stage-passed" @{ status = 'Passed'; recordedAt = [DateTimeOffset]::UtcNow.ToString('o'); variants = $Variants }
    Write-Host "PASS $stage"
}
