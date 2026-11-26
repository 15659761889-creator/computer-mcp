#!/usr/bin/env bash
set -euo pipefail

# Build Wanji macOS installer (.pkg and .dmg) with bundled Node.js, cloudflared,
# minified app/, native Swift desktop control helper (Wanji Desktop Control.app),
# and menu-bar/control app (Wanji.app).
# Run on macOS (Apple Silicon or Intel):
#   ARCH=arm64 ./installer/build-mac.sh
#   ARCH=x64   ./installer/build-mac.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('${ROOT}/package.json','utf8')).version")"
ARCH="${ARCH:-$(uname -m)}"
case "${ARCH}" in
  arm64|aarch64) ARCH="arm64"; CF_ARCH="arm64"; SWIFT_ARCH="arm64" ;;
  x86_64|x64|amd64) ARCH="x64"; CF_ARCH="amd64"; SWIFT_ARCH="x86_64" ;;
  *) echo "Unsupported ARCH: ${ARCH}" >&2; exit 1 ;;
esac

NODE_VERSION="24.21.0"
CLOUDFLARED_VERSION="2026.10.7"
STAGE="${ROOT}/build/mac-${ARCH}"
APP_BUNDLE="${STAGE}/payload/Applications/Wanji.app"
PKG_SCRIPTS="${STAGE}/scripts"
DIST="${ROOT}/dist"

echo "==> Building Wanji ${VERSION} for macOS (${ARCH})"
rm -rf "${STAGE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS" "${APP_BUNDLE}/Contents/Resources/app" "${APP_BUNDLE}/Contents/Resources/runtime" "${APP_BUNDLE}/Contents/Resources/bin" "${PKG_SCRIPTS}" "${DIST}"

# 1. Stage and minify app/
for entry in bin src desktop web package.json LICENSE; do
  cp -R "${ROOT}/${entry}" "${APP_BUNDLE}/Contents/Resources/app/${entry}"
done
if [ -d "${ROOT}/build/tools/node_modules/esbuild" ]; then
  node "${ROOT}/installer/protect.mjs" "${APP_BUNDLE}/Contents/Resources/app"
else
  echo "Note: esbuild not found in build/tools; skipping minification."
fi

# 2. Download pinned Node.js for macOS
NODE_TAR="${STAGE}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
echo "==> Downloading Node.js ${NODE_VERSION} (${ARCH})..."
curl -fL --retry 3 -o "${NODE_TAR}" "${NODE_URL}"
tar -xzf "${NODE_TAR}" -C "${STAGE}"
cp "${STAGE}/node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" "${APP_BUNDLE}/Contents/Resources/runtime/node"
chmod 755 "${APP_BUNDLE}/Contents/Resources/runtime/node"

# 3. Download pinned cloudflared for macOS
CF_TGZ="${STAGE}/cloudflared-darwin-${CF_ARCH}.tgz"
CF_URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-${CF_ARCH}.tgz"
echo "==> Downloading cloudflared ${CLOUDFLARED_VERSION} (${CF_ARCH})..."
curl -fL --retry 3 -o "${CF_TGZ}" "${CF_URL}"
tar -xzf "${CF_TGZ}" -C "${APP_BUNDLE}/Contents/Resources/bin"
chmod 755 "${APP_BUNDLE}/Contents/Resources/bin/cloudflared"

# 4. Build native Swift desktop control helper app (zero Python dependency)
echo "==> Building Wanji Desktop Control.app..."
"${ROOT}/scripts/build-macos-helper.sh" "${APP_BUNDLE}/Contents/Resources/desktop/Wanji Desktop Control.app"

# 5. Compile native Swift menu-bar / status app
echo "==> Compiling Wanji.app..."
swiftc -O -target "${SWIFT_ARCH}-apple-macosx12.3" \
  -framework Cocoa -framework ApplicationServices \
  "${ROOT}/installer/WanjiMac.swift" \
  -o "${APP_BUNDLE}/Contents/MacOS/Wanji"
chmod 755 "${APP_BUNDLE}/Contents/MacOS/Wanji"

cat > "${APP_BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Wanji</string>
  <key>CFBundleIdentifier</key>
  <string>com.wanji.app</string>
  <key>CFBundleName</key>
  <string>万机 Wanji</string>
  <key>CFBundleDisplayName</key>
  <string>万机 Wanji</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.3</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# 6. CLI wrapper (/usr/local/bin/wanji) installed by .pkg postinstall
cat > "${PKG_SCRIPTS}/postinstall" <<'POST'
#!/bin/bash
set -e
mkdir -p /usr/local/bin
cat > /usr/local/bin/wanji <<'WRAPPER'
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Wanji.app/Contents/Resources/bin:$PATH"
exec "/Applications/Wanji.app/Contents/Resources/runtime/node" "/Applications/Wanji.app/Contents/Resources/app/bin/wanji.mjs" "$@"
WRAPPER
chmod 755 /usr/local/bin/wanji
exit 0
POST
chmod 755 "${PKG_SCRIPTS}/postinstall"

# 7. Build .pkg and .dmg
PKG_OUT="${DIST}/Wanji-${VERSION}-macOS-${ARCH}.pkg"
DMG_OUT="${DIST}/Wanji-${VERSION}-macOS-${ARCH}.dmg"
echo "==> Building ${PKG_OUT}..."
pkgbuild \
  --root "${STAGE}/payload" \
  --scripts "${PKG_SCRIPTS}" \
  --identifier "com.wanji.pkg" \
  --version "${VERSION}" \
  --install-location "/" \
  "${PKG_OUT}"

echo "==> Building ${DMG_OUT}..."
DMG_SRC="${STAGE}/dmg"
mkdir -p "${DMG_SRC}"
cp -R "${APP_BUNDLE}" "${DMG_SRC}/Wanji.app"
cp "${PKG_OUT}" "${DMG_SRC}/"
hdiutil create -volname "Wanji ${VERSION}" -srcfolder "${DMG_SRC}" -ov -format UDZO "${DMG_OUT}"

echo "DONE:"
echo "  PKG: ${PKG_OUT}"
echo "  DMG: ${DMG_OUT}"
