#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "OnlineCompiler runtime dependency installer (Linux/macOS)"

if command -v python3 >/dev/null 2>&1; then
  VENV_DIR="$ROOT/.venv"
  echo "Targeting virtual environment: $VENV_DIR"
  VENV_PYTHON="$VENV_DIR/bin/python3"

  if [[ -d "$VENV_DIR" ]]; then
    if ! "$VENV_PYTHON" --version >/dev/null 2>&1; then
      echo "Venv python is broken or missing. Recreating .venv..."
      rm -rf "$VENV_DIR"
    else
      VENV_VER=$("$VENV_PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "mismatch")
      SYS_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
      if [[ "$VENV_VER" != "$SYS_VER" ]]; then
        echo "Python version mismatch (venv: $VENV_VER, system: $SYS_VER). Recreating .venv..."
        rm -rf "$VENV_DIR"
      fi
    fi
  fi

  if [[ ! -d "$VENV_DIR" ]]; then
    python3 -m venv "$VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  "$VENV_PYTHON" -m pip install --no-cache-dir --upgrade pip
  "$VENV_PYTHON" -m pip install --no-cache-dir -r "$ROOT/requirements.txt"
  echo "Python venv packages installed."
else
  echo "WARN: python3 not found" >&2
fi

# Install portable OpenJDK 17 if running on Render and javac/java are not installed
if [ "${RENDER:-false}" = "true" ] || [ "${FORCE_JDK_INSTALL:-false}" = "true" ]; then
  if ! command -v javac >/dev/null 2>&1; then
    echo "Installing JDK 17 on Render..."
    JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.8.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.8.1_1.tar.gz"
    JDK_DIR="$ROOT/jdk"
    mkdir -p "$JDK_DIR"
    curl -L "$JDK_URL" | tar -xz -C "$JDK_DIR" --strip-components=1
    echo "JDK 17 installed at $JDK_DIR"
  else
    echo "Java compiler (javac) already available, skipping JDK installation."
  fi
fi

if [ "${RENDER:-false}" = "true" ]; then
  echo "Running on Render: skipping global npm package installation."
elif command -v npm >/dev/null 2>&1; then
  echo "Attempting to install global Node packages..."
  npm install -g express react react-dom vue @angular/core axios lodash socket.io \
    mongoose bcrypt jsonwebtoken multer cors dotenv redux @reduxjs/toolkit \
    typescript ts-node @nestjs/core @nestjs/common typeorm prisma rxjs \
    bootstrap tailwindcss @mui/material || echo "WARN: Global npm install failed/skipped (read-only filesystem or insufficient permissions)." >&2
fi

if [[ -f "$ROOT/server/package.json" ]]; then
  (cd "$ROOT/server" && npm install)
fi

if [ "${RENDER:-false}" = "true" ]; then
  echo "Running on Render: skipping Docker installation (not supported on Render native runtimes)."
elif ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Attempting automated install..."
  if [ "$EUID" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    echo "WARN: Docker not found and cannot run sudo — skipping automated docker install" >&2
  elif command -v apt-get >/dev/null 2>&1; then
    (sudo apt-get update && sudo apt-get install -y docker.io) || echo "WARN: Docker install via apt failed (insufficient permissions)" >&2
  elif command -v brew >/dev/null 2>&1; then
    (brew install --cask docker || brew install docker) || echo "WARN: Docker install via brew failed" >&2
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman --noconfirm -Syu docker || echo "WARN: Docker install via pacman failed" >&2
  else
    echo "WARN: Docker not found and no supported installer detected — skipping image builds" >&2
  fi
fi

if [ "${RENDER:-false}" != "true" ] && command -v docker >/dev/null 2>&1; then
  (cd "$ROOT" && node scripts/build-runtime-images.js)
else
  echo "Skipping container image builds."
fi

echo "Done. Run: npm run runtimes:status"
