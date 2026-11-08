# Requires a running single-node Minikube profile named preview-f1.
[CmdletBinding()]
param(
    [string]$Minikube = 'minikube',
    [string]$Helm = 'helm'
)

$ErrorActionPreference = 'Stop'
$profileName = 'preview-f1'
$repoRoot = Split-Path $PSScriptRoot -Parent
$chart = Join-Path $repoRoot 'helm/preview-demo'
$localValues = Join-Path $chart 'examples/minikube.yaml'
$runId = [guid]::NewGuid().ToString('N')
$ownerLabel = 'preview.demo/smoke-run'
$created = [System.Collections.Generic.List[string]]::new()

function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Tool $($Arguments -join ' ') exited with code $LASTEXITCODE."
    }
}

function Invoke-Kube([string[]]$Arguments) {
    Invoke-Checked $Minikube (@('-p', $profileName, 'kubectl', '--', '--context', $profileName) + $Arguments)
}

function New-PreviewNamespace {
    # Reserve in one API create. A concurrent run or an existing namespace cannot be adopted.
    $number = (Get-Random -Minimum 100000000 -Maximum 2000000000).ToString()
    $name = "preview-pr-$number"
    $manifest = @{
        apiVersion = 'v1'
        kind = 'Namespace'
        metadata = @{ name = $name; labels = @{ $ownerLabel = $runId; 'preview.demo/smoke-pr' = $number } }
    } | ConvertTo-Json -Depth 5 -Compress
    $file = Join-Path $staging "$name.json"
    Set-Content -LiteralPath $file -Value $manifest -Encoding ascii
    Invoke-Kube @('create', '-f', $file, '-o', 'name') | Out-Host
    $created.Add($number)
    return $number
}

function Remove-PreviewNamespace([string]$Number) {
    if (-not $created.Contains($Number)) { return }
    $selector = "$ownerLabel=$runId,preview.demo/smoke-pr=$Number"
    Invoke-Kube @('delete', 'namespace', '-l', $selector, '--wait=true', '--timeout=3m', '--ignore-not-found=true') | Out-Host
    [void]$created.Remove($Number)
}

function Read-ServiceJson([string]$Url) {
    # EndpointSlice propagation may lag behind a successful Helm readiness check.
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try { return (Invoke-Kube @('get', '--request-timeout=5s', '--raw', $Url) | ConvertFrom-Json) }
        catch {
            if ($attempt -eq 8) { throw }
            Start-Sleep -Seconds 1
        }
    }
}

function Test-PreviewService([string]$Number) {
    $namespace = "preview-pr-$Number"
    $proxy = "/api/v1/namespaces/$namespace/services/http:preview-demo-pr-${Number}:http/proxy"
    $health = Read-ServiceJson "$proxy/health"
    $identity = Read-ServiceJson "$proxy/environment"
    if ($health.status -cne 'ok' -or $identity.prNumber -cne $Number -or
        $identity.commitSha -cne $sha -or $identity.namespace -cne $namespace) {
        throw "Service returned unexpected health or identity for $namespace."
    }
    Write-Host "PASS /health, /environment: PR=$Number SHA=$sha namespace=$namespace"
}

Invoke-Checked $Minikube @('-p', $profileName, 'status') | Out-Host
Invoke-Checked $Helm @('version', '--short') | Out-Host
$sha = (Invoke-Checked 'git' @('-C', $repoRoot, 'rev-parse', 'HEAD')).Trim()
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "Expected a full Git SHA, got $sha." }
$staging = Join-Path ([IO.Path]::GetTempPath()) "preview-f1-$runId"
[void](New-Item -ItemType Directory -Path $staging)

try {
    # Only committed Docker inputs enter the image. Local Gradle output cannot affect its identity.
    $archive = Join-Path $staging 'source.tar'
    Invoke-Checked 'git' @('-C', $repoRoot, 'archive', '--format=tar', '-o', $archive, $sha, 'preview-api')
    Invoke-Checked 'tar' @('-xf', $archive, '-C', $staging)
    $context = Join-Path $staging 'preview-api'
    if (-not (Test-Path -LiteralPath (Join-Path $context 'Dockerfile'))) {
        throw 'The selected Git commit must include the preview-api Dockerfile from PR #7.'
    }

    $a = New-PreviewNamespace
    $b = New-PreviewNamespace
    foreach ($number in @($a, $b)) {
        $namespace = "preview-pr-$number"
        $tag = "pr-$number-$sha"
        Invoke-Checked $Minikube @('-p', $profileName, 'image', 'build', '-t', "preview-api:$tag", $context) | Out-Host
        Invoke-Checked $Helm @(
            'install', "preview-$number", $chart, '--kube-context', $profileName, '--namespace', $namespace,
            '-f', $localValues, '--set-string', "prNumber=$number,commitSha=$sha,image.tag=$tag",
            '--set-string', 'image.pullPolicy=Never', '--wait', '--timeout', '5m'
        ) | Out-Host
        Test-PreviewService $number
    }
    Remove-PreviewNamespace $a
    $left = Invoke-Kube @('get', 'namespace', "preview-pr-$a", '--ignore-not-found', '-o', 'name')
    if ($left) { throw "Namespace preview-pr-$a still exists after cleanup." }
    Test-PreviewService $b
    Write-Host "PASS PR $a is gone; PR $b still serves its own identity."
}
finally {
    $failures = @()
    foreach ($number in $created.ToArray()) {
        try { Remove-PreviewNamespace $number }
        catch { $failures += $_.Exception.Message }
    }
    $resolved = (Resolve-Path -LiteralPath $staging).Path
    if ($resolved -eq [IO.Path]::GetFullPath($staging) -and (Split-Path $resolved -Leaf) -eq "preview-f1-$runId") {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    if ($failures) { throw "Check remaining resources with selector $ownerLabel=$runId. $($failures -join ' ')" }
}
