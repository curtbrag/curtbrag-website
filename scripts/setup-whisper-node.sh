#!/bin/sh
# Build and install whisper.cpp on a phone node (ARM64)
# Run on the phone directly, or deploy via deploy-workers.sh
# Shell: ash (BusyBox) — no bash syntax
#
# Usage:
#   sh setup-whisper-node.sh                    # Build + download base model
#   sh setup-whisper-node.sh --model tiny       # Use tiny model (fastest)
#   sh setup-whisper-node.sh --model small      # Use small model (better quality)

set -e

INSTALL_DIR="/home/user/whisper.cpp"
MODEL_NAME="${1:-base}"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL_NAME="$2"; shift 2;;
    --dir) INSTALL_DIR="$2"; shift 2;;
    *) shift;;
  esac
done

echo "=== whisper.cpp Setup ==="
echo "  Install dir: $INSTALL_DIR"
echo "  Model: $MODEL_NAME"
echo ""

# Step 1: Install build dependencies
echo "[1/4] Installing build dependencies..."
doas apk add build-base cmake git curl 2>/dev/null || true
echo "  Done"

# Step 2: Clone or update whisper.cpp
echo "[2/4] Getting whisper.cpp source..."
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || true
  echo "  Updated existing clone"
else
  rm -rf "$INSTALL_DIR"
  git clone https://github.com/ggerganov/whisper.cpp.git "$INSTALL_DIR"
  echo "  Cloned fresh"
fi

# Step 3: Build
echo "[3/4] Building whisper.cpp (this takes a few minutes on ARM)..."
cd "$INSTALL_DIR"
mkdir -p build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -5
make -j$(nproc) 2>&1 | tail -5

if [ -f "$INSTALL_DIR/build/bin/whisper-cli" ]; then
  ln -sf "$INSTALL_DIR/build/bin/whisper-cli" "$INSTALL_DIR/main"
  echo "  Build successful"
elif [ -f "$INSTALL_DIR/build/bin/main" ]; then
  ln -sf "$INSTALL_DIR/build/bin/main" "$INSTALL_DIR/main"
  echo "  Build successful"
else
  echo "  ERROR: Build failed — check output above"
  exit 1
fi

# Step 4: Download model
echo "[4/4] Downloading model (ggml-${MODEL_NAME})..."
cd "$INSTALL_DIR"
mkdir -p models

MODEL_FILE="models/ggml-${MODEL_NAME}.bin"
if [ -f "$MODEL_FILE" ]; then
  echo "  Model already exists"
else
  # Use the official download script if available
  if [ -f "models/download-ggml-model.sh" ]; then
    sh models/download-ggml-model.sh "$MODEL_NAME" 2>&1 | tail -3
  else
    MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"
    curl -L -o "$MODEL_FILE" "$MODEL_URL" 2>&1 | tail -3
  fi

  if [ -f "$MODEL_FILE" ]; then
    SIZE=$(du -h "$MODEL_FILE" | cut -f1)
    echo "  Model downloaded ($SIZE)"
  else
    echo "  WARNING: Model download may have failed"
  fi
fi

# Verify
echo ""
echo "=== Verification ==="
if [ -x "$INSTALL_DIR/main" ] || [ -f "$INSTALL_DIR/main" ]; then
  echo "  Binary: $INSTALL_DIR/main"
  "$INSTALL_DIR/main" --help 2>&1 | head -1 || echo "  (binary exists but --help failed)"
else
  echo "  ERROR: Binary not found"
fi
echo "  Model:  $INSTALL_DIR/$MODEL_FILE"
echo ""
echo "Test transcription:"
echo "  $INSTALL_DIR/main -m $INSTALL_DIR/$MODEL_FILE -f /path/to/audio.wav"
echo ""
