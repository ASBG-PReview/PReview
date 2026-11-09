# Requires a running single-node Minikube profile named preview-f1.
[CmdletBinding()]
param(
    [string]$Minikube = 'minikube',
    [string]$Helm = 'helm',
    # Optional earlier Git revision for testing an upgrade of PR A while B stays live.
    [string]$UpdateFromRevision,
    # Build on the host and load a tar archive when the node uses containerd.
    [switch]$UseHostDocker
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

function Test-PreviewService([string]$Number, [string]$ExpectedSha) {
    $namespace = "preview-pr-$Number"
    $proxy = "/api/v1/namespaces/$namespace/services/http:preview-demo-pr-${Number}:http/proxy"
    $health = Read-ServiceJson "$proxy/health"
    $identity = Read-ServiceJson "$proxy/environment"
    if ($health.status -cne 'ok' -or $identity.prNumber -cne $Number -or
        $identity.commitSha -cne $ExpectedSha -or $identity.namespace -cne $namespace) {
        throw "Service returned unexpected health or identity for $namespace."
    }
    Write-Host "PASS /health, /environment: PR=$Number SHA=$ExpectedSha namespace=$namespace"
}

Invoke-Checked $Minikube @('-p', $profileName, 'status') | Out-Host
Invoke-Checked $Helm @('version', '--short') | Out-Host
$sha = (Invoke-Checked 'git' @('-C', $repoRoot, 'rev-parse', 'HEAD')).Trim()
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "Expected a full Git SHA, got $sha." }
$staging = Join-Path ([IO.Path]::GetTempPath()) "preview-f1-$runId"
[void](New-Item -ItemType Directory -Path $staging)

function Get-ImageContext([string]$Revision) {
    $source = Join-Path $staging $Revision
    $context = Join-Path $source 'preview-api'
    if (-not (Test-Path -LiteralPath $context)) {
        [void](New-Item -ItemType Directory -Path $source)
        $archive = Join-Path $source 'source.tar'
        Invoke-Checked 'git' @('-C', $repoRoot, 'archive', '--format=tar', '-o', $archive, $Revision, 'preview-api')
        Invoke-Checked 'tar' @('-xf', $archive, '-C', $source)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $context 'Dockerfile'))) {
        throw "Missing preview-api/Dockerfile at $Revision."
    }
    return $context
}

function Set-PreviewRelease([string]$Number, [string]$Revision, [string]$Action) {
    $context = Get-ImageContext $Revision
    $namespace = "preview-pr-$Number"
    $tag = "pr-$Number-$Revision"
    $image = "preview-api:$tag"
    if ($UseHostDocker) {
        Invoke-Checked 'docker' @('build', '--label', "org.opencontainers.image.revision=$Revision", '-t', $image, $context) | Out-Host
        $archive = Join-Path $staging 'image.tar'
        Invoke-Checked 'docker' @('save', '-o', $archive, $image)
        Invoke-Checked $Minikube @('-p', $profileName, 'image', 'load', $archive) | Out-Host
    } else {
        Invoke-Checked $Minikube @('-p', $profileName, 'image', 'build', '-t', $image, $context) | Out-Host
    }
    Invoke-Checked $Helm @(
        $Action, "preview-$Number", $chart, '--kube-context', $profileName, '--namespace', $namespace,
        '-f', $localValues, '--set-string', "prNumber=$Number,commitSha=$Revision,image.tag=$tag",
        '--set-string', 'image.pullPolicy=Never', '--wait', '--timeout', '5m'
    ) | Out-Host
    Test-PreviewService $Number $Revision
}

try {
    $firstSha = $sha
    if ($UpdateFromRevision) {
        $firstSha = (Invoke-Checked 'git' @('-C', $repoRoot, 'rev-parse', '--verify', '--end-of-options', "${UpdateFromRevision}^{commit}")).Trim()
        if ($firstSha -eq $sha) { throw 'Choose an initial revision different from HEAD.' }
        Invoke-Checked 'git' @('-C', $repoRoot, 'merge-base', '--is-ancestor', $firstSha, $sha)
    }
    $a = New-PreviewNamespace
    $b = New-PreviewNamespace
    Set-PreviewRelease $a $firstSha install
    Set-PreviewRelease $b $firstSha install
    if ($UpdateFromRevision) {
        Set-PreviewRelease $a $sha upgrade
        Test-PreviewService $b $firstSha
        Write-Host "PASS PR $a updated to $sha; PR $b still serves $firstSha."
    }
    Remove-PreviewNamespace $a
    $left = Invoke-Kube @('get', 'namespace', "preview-pr-$a", '--ignore-not-found', '-o', 'name')
    if ($left) { throw "Namespace preview-pr-$a still exists after cleanup." }
    Test-PreviewService $b $firstSha
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
