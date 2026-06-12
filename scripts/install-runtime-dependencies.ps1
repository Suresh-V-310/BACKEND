# Install host toolchain dependencies for OnlineCompiler (Windows)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "OnlineCompiler runtime dependency installer (Windows)" -ForegroundColor Cyan

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Python venv + scientific stack
if (Test-Command python) {
  $venv = Join-Path $Root ".venv"
  if (-not (Test-Path $venv)) {
    python -m venv $venv
  }
  $pip = Join-Path $venv "Scripts\pip.exe"
  & $pip install --upgrade pip
  & $pip install -r (Join-Path $Root "requirements.txt")
  Write-Host "Python venv packages installed." -ForegroundColor Green
} else {
  Write-Warning "python not found - install Python 3.12+ from https://www.python.org/"
}

# Node global packages for JS/TS
if (Test-Command npm) {
  $packages = @(
    "express", "react", "react-dom", "vue", "@angular/core", "axios", "lodash",
    "socket.io", "mongoose", "bcrypt", "jsonwebtoken", "multer", "cors", "dotenv",
    "redux", "@reduxjs/toolkit", "typescript", "ts-node", "@nestjs/core", "@nestjs/common",
    "typeorm", "prisma", "rxjs", "bootstrap", "tailwindcss", "@mui/material"
  )
  npm install -g $packages
  Write-Host "Node global packages installed." -ForegroundColor Green
} else {
  Write-Warning "npm not found - install Node.js 22+ from https://nodejs.org/"
}

# Server workspace packages
if (Test-Path (Join-Path $Root "server\package.json")) {
  Push-Location (Join-Path $Root "server")
  npm install
  Pop-Location
}

if (-not (Test-Command docker)) {
  Write-Warning "Docker not found. Attempting automated install..."
  if (Test-Command winget) {
    winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements
  } elseif (Test-Command choco) {
    choco install docker-desktop -y
  } else {
    Write-Warning "Docker not found and no supported Windows package manager detected. Install Docker Desktop manually."
  }
}

if (Test-Command docker) {
  Push-Location $Root
  node scripts/build-runtime-images.js
  Pop-Location
} else {
  Write-Warning "Docker not found - container images were not built. Install Docker Desktop for full language isolation."
}

if (-not (Test-Command gcc)) {
  Write-Host "gcc not found. Downloading MinGW-w64..." -ForegroundColor Cyan
  $mingwZip = Join-Path $Root "mingw.7z"
  if (-not (Test-Path $mingwZip)) {
    Invoke-WebRequest -Uri "https://github.com/niXman/mingw-builds-binaries/releases/download/13.2.0-rt_v11-rev1/x86_64-13.2.0-release-win32-seh-ucrt-rt_v11-rev1.7z" -OutFile $mingwZip
  }
  if (Test-Command tar) {
    tar -xf $mingwZip -C $Root
    Remove-Item $mingwZip -Force
    Write-Host "MinGW-w64 extracted successfully." -ForegroundColor Green
  } else {
    Write-Warning "tar command not available to extract mingw.7z"
  }
} else {
  Write-Host "gcc found on PATH." -ForegroundColor Green
}

Write-Host "Done. Run: npm run runtimes:status" -ForegroundColor Cyan
