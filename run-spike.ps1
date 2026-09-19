param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$mapsHost = Join-Path $repoRoot "maps"

if (-not $SkipBuild) {
    Write-Host "Building sc2-observer-spike image..."
    docker build -t sc2-observer-spike -f (Join-Path $repoRoot "docker\Dockerfile") (Join-Path $repoRoot "docker")
}

Write-Host "Removing any previous spike container..."
docker rm -f sc2-observer-spike 2>$null | Out-Null

Write-Host "Starting container (SC2 port 5001, maps mounted from $mapsHost)..."
# Host-path form for -v on Windows Docker Desktop is one of Phase 0's open
# unknowns (plan §7.1) -- this is the form being tested, not assumed.
docker run -d --name sc2-observer-spike `
    -p 127.0.0.1:5001:5001 `
    -v "${mapsHost}:/root/StarCraftII/Maps" `
    sc2-observer-spike

Write-Host "Container started. Tailing logs (Ctrl+C to stop watching, container keeps running)..."
docker logs -f sc2-observer-spike
