#!/usr/bin/env bash
# Builds Ispyx.app (and optionally signs, notarises and packs it into a .dmg).
#
#   ./build.sh                       unsigned (ad-hoc signed) build for local testing -> build/Ispyx.app
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./build.sh
#                                    signed with the hardened runtime
#   SIGN_IDENTITY=... NOTARY_PROFILE=ispyx-notary ./build.sh
#                                    signed, notarised, stapled, and packed into build/Ispyx.dmg
#
# The app is universal (Apple Silicon and Intel) and also carries the Node core (Contents/Resources/{node,core,ispyx}).
# Needs Xcode (for the universal Swift build) and network access: the official Node builds (NODE_VERSION, default
# 22.18.0) and koffi's darwin prebuilts are downloaded. Any Mac, any local Node/npm on PATH for npm's own script.
#
# NOTARY_PROFILE is a keychain profile created once with:
#   xcrun notarytool store-credentials ispyx-notary --apple-id <id> --team-id <TEAMID> --password <app-specific-password>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/Ispyx"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/build"
APP="$OUT/Ispyx.app"
DMG="$OUT/Ispyx.dmg"
ENTITLEMENTS="$PKG/Resources/Ispyx.entitlements"
# signing.local (not in git) can set SIGN_IDENTITY / NOTARY_PROFILE for this Mac, e.g. an "Apple Development"
# identity so the permissions survive rebuilds (ad-hoc builds get a new identity each time). The environment wins.
ENV_SIGN_IDENTITY="${SIGN_IDENTITY:-}"
ENV_NOTARY_PROFILE="${NOTARY_PROFILE:-}"
if [ -f "$HERE/signing.local" ]; then . "$HERE/signing.local"; fi
SIGN_IDENTITY="${ENV_SIGN_IDENTITY:-${SIGN_IDENTITY:-}}"
NOTARY_PROFILE="${ENV_NOTARY_PROFILE:-${NOTARY_PROFILE:-}}"

# ---- 1. compile (universal: Apple Silicon and Intel, release) -------------------------------------
echo "==> swift build (arm64 + x86_64)"
( cd "$PKG" && swift build -c release --arch arm64 --arch x86_64 )
BIN_DIR="$(cd "$PKG" && swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

# ---- 2. assemble the bundle ---------------------------------------------------------------------
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Ispyx" "$APP/Contents/MacOS/Ispyx"
cp "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist"
# the app carries the version of the npm package it bundles (APP_VERSION / BUILD_NUMBER override, e.g. in CI)
APP_VERSION="${APP_VERSION:-$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)}"
BUILD_NUMBER="${BUILD_NUMBER:-$APP_VERSION}"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
# Only the released app (Developer ID) is com.ispyx.app. Every other build is "Ispyx Dev", com.ispyx.app.dev: macOS
# keeps one permission record per bundle id, so a dev build sharing the id would take over the installed app's
# permissions (they would read "not allowed" there after each restart). BUNDLE_ID overrides.
case "$SIGN_IDENTITY" in
  "Developer ID Application:"*) BUNDLE_ID="${BUNDLE_ID:-com.ispyx.app}" ;;
  *) BUNDLE_ID="${BUNDLE_ID:-com.ispyx.app.dev}" ;;
esac
if [ "$BUNDLE_ID" != "com.ispyx.app" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" -c "Set :CFBundleName Ispyx Dev" -c "Set :CFBundleDisplayName Ispyx Dev" "$APP/Contents/Info.plist"
fi
echo "    bundle id $BUNDLE_ID"
echo "    version $APP_VERSION ($BUILD_NUMBER)"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [ -f "$PKG/Resources/Ispyx.icns" ]; then
  cp "$PKG/Resources/Ispyx.icns" "$APP/Contents/Resources/Ispyx.icns"
else
  echo "    (no Resources/Ispyx.icns yet: the app gets the generic icon. Drop an .icns file there.)"
fi

# ---- 2b. bundle the Node core: universal Node binary, src/, production node_modules, launcher ------
# The official nodejs.org builds for arm64 and x64 are downloaded (checksum verified, cached in build/cache) and
# merged with lipo, so the app runs natively on both Apple Silicon and Intel Macs.
NODE_VERSION="${NODE_VERSION:-22.18.0}"
CACHE="$OUT/cache"
echo "==> bundling Node $NODE_VERSION (arm64 + x64) and the core"
mkdir -p "$CACHE"
SUMS="$CACHE/node-v$NODE_VERSION-SHASUMS256.txt"
[ -f "$SUMS" ] || curl -fsSL -o "$SUMS" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
NODE_SLICES=()
for arch in arm64 x64; do
  name="node-v$NODE_VERSION-darwin-$arch"
  if [ ! -x "$CACHE/$name/bin/node" ]; then
    curl -fsSL -o "$CACHE/$name.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
    ( cd "$CACHE" && grep " $name.tar.gz\$" "$SUMS" | shasum -a 256 -c - )
    tar -xzf "$CACHE/$name.tar.gz" -C "$CACHE"
    rm -f "$CACHE/$name.tar.gz"
  fi
  NODE_SLICES+=("$CACHE/$name/bin/node")
done

RES="$APP/Contents/Resources"
CORE="$RES/core"
mkdir -p "$RES/node/bin" "$CORE"
lipo -create "${NODE_SLICES[@]}" -output "$RES/node/bin/node"
chmod 755 "$RES/node/bin/node"

cp -R "$REPO/src" "$CORE/src"
cp "$REPO/package.json" "$REPO/package-lock.json" "$CORE/"
# npm runs on the bundled node (the slice native to this Mac)
( cd "$CORE" && PATH="$RES/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund )

# npm ci only installs koffi's prebuilt for the arch it runs on; add both darwin prebuilts
KOFFI_VERSION="$("$RES/node/bin/node" -p 'require(process.argv[1]).version' "$CORE/node_modules/koffi/package.json")"
for arch in arm64 x64; do
  pkg="koffi-darwin-$arch"
  dest="$CORE/node_modules/@koromix/$pkg"
  if [ ! -d "$dest" ]; then
    tgz="$( cd "$CACHE" && PATH="$RES/node/bin:$PATH" npm pack --silent "@koromix/$pkg@$KOFFI_VERSION" )"
    mkdir -p "$dest"
    tar -xzf "$CACHE/$tgz" -C "$dest" --strip-components=1
    rm -f "$CACHE/$tgz"
  fi
done

# keep only macOS Mach-O libraries (drop prebuilts of other systems)
while IFS= read -r f; do
  case "$(file -b "$f")" in
    *"Mach-O"*) ;;
    *) rm -f "$f" ;;
  esac
done < <(find "$CORE/node_modules" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \))

cp "$HERE/launcher/ispyx" "$RES/ispyx"
chmod 755 "$RES/ispyx"

# ---- 2c. the window's page: the shared panel page plus its icon (loaded from the bundle by a WKWebView) ----
echo "==> bundling the panel page"
mkdir -p "$RES/panel"
cp "$REPO/src/core/panel/page.html" "$RES/panel/page.html"
"$RES/node/bin/node" "$HERE/make-panel-icon.mjs" "$RES/panel/icon.png"

# ---- 3. code signing ------------------------------------------------------------------------------
# Every Mach-O is signed on its own, innermost first, then the app. With SIGN_IDENTITY the hardened runtime and a
# secure timestamp are on (required for notarisation); without it everything is ad-hoc signed for local testing.
# node.entitlements: V8 needs JIT and writable+executable memory; koffi's .node files are loaded with library
# validation off because they carry a different (or ad-hoc) signature than the node binary.
# Ispyx.entitlements: no App Sandbox (the app posts input events and captures other apps' windows); the same
# code-signing exceptions are kept on the app. Entitlement files must not contain XML comments (AMFI rejects them).
NODE_ENTITLEMENTS="$HERE/node.entitlements"
if [ -n "$SIGN_IDENTITY" ]; then
  SIGN_ARGS=(--force --options runtime --timestamp --sign "$SIGN_IDENTITY")
  echo "==> codesign (hardened runtime) as: $SIGN_IDENTITY"
else
  SIGN_ARGS=(--force --sign -)
  echo "==> ad-hoc signing (local testing only; macOS may ask for the permissions again after every rebuild)"
fi

# >>> SIGNING STEP <<<
# 1. libraries inside the bundled core (koffi .node files, any dylib)
while IFS= read -r f; do
  case "$(file -b "$f")" in
    *Mach-O*) codesign "${SIGN_ARGS[@]}" "$f" ;;
  esac
done < <(find "$CORE" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \))
# 2. the Node executable, with its own entitlements (JIT etc.)
codesign "${SIGN_ARGS[@]}" --entitlements "$NODE_ENTITLEMENTS" "$RES/node/bin/node"
# 3. the app's main executable
codesign "${SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$APP/Contents/MacOS/Ispyx"
# 4. the app bundle itself
codesign "${SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ---- 4. notarisation (needs SIGN_IDENTITY and NOTARY_PROFILE) -----------------------------------
NOTARISE=0
if [ -n "$SIGN_IDENTITY" ] && [ -n "$NOTARY_PROFILE" ]; then NOTARISE=1; fi

if [ "$NOTARISE" = "1" ]; then
  echo "==> notarising the app"
  # >>> NOTARISATION STEP <<<
  ZIP="$OUT/Ispyx-notarize.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  rm -f "$ZIP"
  xcrun stapler staple "$APP"
else
  echo "==> skipping notarisation (set SIGN_IDENTITY and NOTARY_PROFILE to enable)"
fi

# ---- 5. disk image ----------------------------------------------------------------------------------
echo "==> creating $DMG"
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Ispyx.app"
ln -s /Applications "$STAGE/Applications"
# >>> DMG STEP <<<
hdiutil create -volname "Ispyx" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi
if [ "$NOTARISE" = "1" ]; then
  echo "==> notarising the disk image"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo
echo "Done:"
echo "  app: $APP"
echo "  dmg: $DMG"
