# Windows helper — wraps the most common dev/deploy commands so you don't
# need `make` installed.
#
#   .\scripts\dev.ps1 up       # build + start the full Docker stack
#   .\scripts\dev.ps1 down     # stop everything
#   .\scripts\dev.ps1 logs     # tail logs
#   .\scripts\dev.ps1 rebuild  # rebuild image without cache
#   .\scripts\dev.ps1 reset    # nuke volumes (drops your DB)
#   .\scripts\dev.ps1 spa      # run the SPA dev server
#   .\scripts\dev.ps1 api      # run the Go API natively (no Docker)

param(
    [Parameter(Position = 0)]
    [ValidateSet('up','down','logs','rebuild','reset','spa','api','worker','scheduler','psql','status','diag','help')]
    [string]$cmd = 'help'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

switch ($cmd) {
    'up' {
        docker compose up -d --build
        Write-Host ""
        Write-Host "Services starting…" -ForegroundColor Green
        Write-Host "  App:        http://localhost:8080/"
        Write-Host "  API docs:   http://localhost:8080/api/docs"
        Write-Host "  RabbitMQ:   http://localhost:15672  (guest / guest)"
        Write-Host "  Postgres:   localhost:5432  (mrbs_admin / SecurePass123!)"
        Write-Host ""
        Write-Host "Login:  admin / admin123   (System Admin)"
        Write-Host "        officer / pass     (General User)"
    }
    'down'    { docker compose down }
    'logs'    { docker compose logs -f --tail=100 }
    'rebuild' { docker compose build --no-cache; docker compose up -d }
    'reset'   {
        Write-Host "This will DELETE the database volume. Press Ctrl+C to cancel." -ForegroundColor Yellow
        Start-Sleep 3
        docker compose down -v
        docker compose up -d --build
    }
    'spa'       { Set-Location src\presentation\web\spa; if (-not (Test-Path node_modules)) { npm install }; npm run dev }
    'api'       { go run ./src/cmd/api/ }
    'worker'    { go run ./src/cmd/worker/ }
    'scheduler' { go run ./src/cmd/scheduler/ }
    'psql'      { docker compose exec postgres_db psql -U mrbs_admin -d fsd_mrbs }
    'status'    { docker compose ps }
    'diag' {
        Write-Host "=== Container status ===" -ForegroundColor Cyan
        docker compose ps
        Write-Host ""
        Write-Host "=== Last 50 lines of mrbs_api ===" -ForegroundColor Cyan
        docker compose logs --tail=50 mrbs_api
        Write-Host ""
        Write-Host "=== Last 20 lines of mrbs_worker ===" -ForegroundColor Cyan
        docker compose logs --tail=20 mrbs_worker
        Write-Host ""
        Write-Host "=== Last 20 lines of mrbs_scheduler ===" -ForegroundColor Cyan
        docker compose logs --tail=20 mrbs_scheduler
        Write-Host ""
        Write-Host "=== Port 8080 ===" -ForegroundColor Cyan
        try { Get-NetTCPConnection -LocalPort 8080 -ErrorAction Stop | Format-Table }
        catch { Write-Host "Nothing listening on :8080" -ForegroundColor Yellow }
    }
    default {
        Write-Host "Usage: .\scripts\dev.ps1 <command>" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  up          Build the Docker image and start everything"
        Write-Host "  down        Stop all services"
        Write-Host "  logs        Tail combined service logs"
        Write-Host "  rebuild     Rebuild image with no cache, then up"
        Write-Host "  reset       Wipe DB volume and start fresh (DESTRUCTIVE)"
        Write-Host "  spa         Run Vite SPA dev server (no Docker)"
        Write-Host "  api         Run the Go API natively"
        Write-Host "  worker      Run the notification worker natively"
        Write-Host "  scheduler   Run the scheduler natively"
        Write-Host "  psql        Open psql shell against the Dockerized DB"
        Write-Host "  status      Show container status (docker compose ps)"
        Write-Host "  diag        Print full diagnostic: status + logs + port check"
    }
}
