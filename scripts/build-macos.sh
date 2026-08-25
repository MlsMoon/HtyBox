#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE="aarch64-apple-darwin"
PRODUCT_NAME="HtyBox"
BUILD_ROOT="$ROOT_DIR/src-tauri/target/$TARGET_TRIPLE/release/bundle"
APP_PATH="$BUILD_ROOT/macos/$PRODUCT_NAME.app"
DMG_PATH="$BUILD_ROOT/dmg/${PRODUCT_NAME}_$(node -p "require('$ROOT_DIR/package.json').version")_aarch64.dmg"

cd "$ROOT_DIR"
pnpm exec tauri build \
  --target "$TARGET_TRIPLE" \
  --config src-tauri/tauri.mac-dev.conf.json

if [[ ! -d "$APP_PATH" ]]; then
  echo "macOS application bundle was not generated: $APP_PATH" >&2
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo "macOS disk image was not generated: $DMG_PATH" >&2
  exit 1
fi

echo "macOS application: $APP_PATH"
echo "macOS disk image:  $DMG_PATH"
