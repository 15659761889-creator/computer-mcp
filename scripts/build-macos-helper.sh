#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-"$ROOT/.build/macos/Wanji Desktop Control.app"}
SWIFTC=$(xcrun --find swiftc 2>/dev/null || true)
if [ -z "$SWIFTC" ]; then
  echo "Swift compiler not found. Install Apple Command Line Tools: xcode-select --install" >&2
  exit 1
fi
CONTENTS="$OUT/Contents"
MACOS="$CONTENTS/MacOS"
mkdir -p "$MACOS"
TMP="$MACOS/wanji-desktop-control.new.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
"$SWIFTC" -O -mmacosx-version-min=12.3 \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Vision \
  -framework ScreenCaptureKit \
  -framework CoreGraphics \
  -framework ImageIO \
  -o "$TMP" \
  "$ROOT/desktop/macos/helper.swift"
cp "$ROOT/desktop/macos/Info.plist" "$CONTENTS/Info.plist"
mkdir -p "$CONTENTS/Resources"
BUILD_HASH=$({ cat "$ROOT/desktop/macos/helper.swift"; printf '\0'; cat "$ROOT/desktop/macos/Info.plist"; } | shasum -a 256 | awk '{print $1}')
printf '%s\n' "$BUILD_HASH" > "$CONTENTS/Resources/wanji-build.sha256"
chmod 755 "$TMP"
mv -f "$TMP" "$MACOS/wanji-desktop-control"
codesign --force --deep --sign - --identifier com.wanji.desktop-control "$OUT"
codesign --verify --deep --strict "$OUT"
trap - EXIT HUP INT TERM
printf 'Built %s\n' "$OUT"
