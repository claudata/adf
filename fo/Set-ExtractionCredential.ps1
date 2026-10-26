[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [guid] $SubscriptionId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $ResourceGroup,

    [Parameter(Mandatory)]
    [guid] $ApplicationObjectId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $VaultName
)

$ErrorActionPreference = 'Stop'

function Get-AzureToken([string] $Resource) {
    $token = az account get-access-token --subscription $subscriptionId --resource $Resource --query accessToken --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw "Unable to obtain an Azure token for $Resource."
    }
    return $token
}

$graphHeaders = @{ Authorization = "Bearer $(Get-AzureToken 'https://graph.microsoft.com/')" }
$armHeaders = @{ Authorization = "Bearer $(Get-AzureToken 'https://management.azure.com/')" }
$expires = [DateTimeOffset]::UtcNow.AddDays(90)
$credential = $null
$stored = $false

try {
    $request = @{
        passwordCredential = @{
            displayName = 'adf-key-vault-90days'
            endDateTime = $expires.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
    } | ConvertTo-Json -Depth 5
    $credential = Invoke-RestMethod -Method Post `
        -Uri "https://graph.microsoft.com/v1.0/applications/$applicationObjectId/addPassword" `
        -Headers $graphHeaders -ContentType 'application/json' -Body $request

    $deploymentName = "fo-extraction-credential-$([guid]::NewGuid().ToString('N'))"
    $deployment = @{
        properties = @{
            mode = 'Incremental'
            template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'credential-template.json') -Raw | ConvertFrom-Json -AsHashtable
            parameters = @{
                vaultName = @{ value = $VaultName }
                clientSecret = @{ value = $credential.secretText }
                expires = @{ value = $expires.ToUnixTimeSeconds() }
            }
        }
    } | ConvertTo-Json -Depth 30 -Compress

    $deploymentUri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2022-09-01"
    $null = Invoke-RestMethod -Method Put -Uri $deploymentUri -Headers $armHeaders `
        -ContentType 'application/json' -Body $deployment
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
    do {
        Start-Sleep -Seconds 5
        $result = Invoke-RestMethod -Method Get -Uri $deploymentUri -Headers $armHeaders
        $state = $result.properties.provisioningState
        if ($state -in @('Failed', 'Canceled')) {
            throw "Secure credential deployment ended in state $state."
        }
        if ([DateTimeOffset]::UtcNow -gt $deadline) {
            throw 'Secure credential deployment did not finish within five minutes.'
        }
    } until ($state -eq 'Succeeded')

    $stored = $true
    Write-Output "Credential stored in Key Vault; expires $($expires.ToString('yyyy-MM-dd')). No secret value was written to disk or console."
}
finally {
    if ($null -ne $credential -and -not $stored) {
        $removeRequest = @{ keyId = $credential.keyId } | ConvertTo-Json
        $null = Invoke-RestMethod -Method Post `
            -Uri "https://graph.microsoft.com/v1.0/applications/$applicationObjectId/removePassword" `
            -Headers $graphHeaders -ContentType 'application/json' -Body $removeRequest
        Write-Warning 'Revoked the new credential because secure storage was not confirmed.'
    }
    $credential = $null
    $deployment = $null
    $graphHeaders = $null
    $armHeaders = $null
}
