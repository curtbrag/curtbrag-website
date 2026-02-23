#!/bin/sh
# Build and install llama.cpp on a phone node (ARM64)
# Run on the phone directly, or deploy via deploy-workers.sh
# Shell: ash (BusyBox) — no bash syntax
#
# Usage:
#   sh setup-llama-node.sh                              # Build only
#   sh setup-llama-node.sh --model-url https://...gguf  # Build + download model

set -e

INSTALL_DIR="/home/user/llama.cpp"
MODEL_URL=""
MODEL_DIR="/home/user/llama.cpp/models"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --model-url) MODEL_URL="$2"; shift 2;;
    --dir) INSTALL_DIR="$2"; shift 2;;
    *) shift;;
  esac
done

echo "=== llama.cpp Setup ==="
echo "  Install dir: $INSTALL_DIR"
echo ""

# Step 1: Install build dependencies
echo "[1/3] Installing build dependencies..."
doas apk add build-base cmake git curl 2>/dev/null || true
echo "  Done"

# Step 2: Clone or update
echo "[2/3] Getting llama.cpp source..."
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || true
  echo "  Updated existing clone"
else
  rm -rf "$INSTALL_DIR"
  git clone https://github.com/ggerganov/llama.cpp.git "$INSTALL_DIR"
  echo "  Cloned fresh"
fi

# Step 3: Build
echo "[3/3] Building llama.cpp (this takes several minutes on ARM)..."
cd "$INSTALL_DIR"
mkdir -p build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -5
make -j$(nproc) 2>&1 | tail -5

# Find the CLI binary (name varies by version)
LLAMA_BIN=""
for bin_name in llama-cli main; do
  for bin_path in "$INSTALL_DIR/build/bin/$bin_name" "$INSTALL_DIR/build/$bin_name"; do
    if [ -f "$bin_path" ]; then
      LLAMA_BIN="$bin_path"
      break 2
    fi
  done
done

if [ -n "$LLAMA_BIN" ]; then
  ln -sf "$LLAMA_BIN" "$INSTALL_DIR/llama-cli"
  echo "  Build successful: $LLAMA_BIN"
else
  echo "  ERROR: Build failed — no binary found"
  echo "  Check: ls $INSTALL_DIR/build/bin/"
  exit 1
fi

# Optional: Download model
mkdir -p "$MODEL_DIR"
if [ -n "$MODEL_URL" ]; then
  MODEL_FILE="$MODEL_DIR/model.gguf"
  echo ""
  echo "Downloading model..."
  echo "  URL: $MODEL_URL"
  curl -L -o "$MODEL_FILE" "$MODEL_URL" 2>&1 | tail -3

  if [ -f "$MODEL_FILE" ]; then
    SIZE=$(du -h "$MODEL_FILE" | cut -f1)
    echo "  Model downloaded ($SIZE)"
  else
    echo "  WARNING: Download may have failed"
  fi
fi

# Verify
echo ""
echo "=== Verification ==="
echo "  Binary: $INSTALL_DIR/llama-cli"
"$INSTALL_DIR/llama-cli" --version 2>&1 | head -3 || echo "  (version check failed)"
echo ""

# List any models found
MODELS=$(find "$MODEL_DIR" -name "*.gguf" 2>/dev/null)
if [ -n "$MODELS" ]; then
  echo "  Models found:"
  echo "$MODELS" | while read -r m; do
    SIZE=$(du -h "$m" | cut -f1)
    echo "    $m ($SIZE)"
  done
else
  echo "  No models found in $MODEL_DIR"
  echo ""
  echo "  Download a model (example — Qwen 3B Q4):"
  echo "    curl -L -o $MODEL_DIR/model.gguf \\"
  echo "      https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
fi
echo ""
echo "Test inference:"
echo "  $INSTALL_DIR/llama-cli -m $MODEL_DIR/model.gguf -p 'Hello, world' -n 64"
echo ""
