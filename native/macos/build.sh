#!/usr/bin/env bash
# Builds Ispyx.app (and optionally signs, notarises and packs it into a .dmg).
#
#   ./build.sh                       unsigned (ad-hoc signed) build for local testing -> build/Ispyx.app
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./build.sh
#                                    signed with the hardened runtime
#   SIGN_IDENTITY=... NOTARY_PROFILE=ispyx-notary ./build.sh
#                                    signed, notarised, stapled, and packed into build/Ispyx.dmg
#
# The app also carries the Node core (Contents/Resources/{node,core,ispyx}), so this script must run on an
# Apple Silicon Mac with Node 22+ (official arm64 build; override with NODE_BIN=/path/to/node) and network
# access (npm ci fetches koffi's darwin-arm64 prebuilt).
#
# NOTARY_PROFILE is a keychain profile created once with:
#   xcrun notarytool store-credentials ispyx-notary --apple-id <id> --team-id <TEAMID> --password <app-specific-password>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/Ispyx"
OUT="$HERE/build"
APP="$OUT/Ispyx.app"
DMG="$OUT/Ispyx.dmg"
ENTITLEMENTS="$PKG/Resources/Ispyx.entitlements"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

# ---- 1. compile (Apple Silicon, release) ------------------------------------------------------
echo "==> swift build"
( cd "$PKG" && swift build -c release --arch arm64 )
BIN_DIR="$(cd "$PKG" && swift build -c release --arch arm64 --show-bin-path)"

# ---- 2. assemble the bundle ---------------------------------------------------------------------
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Ispyx" "$APP/Contents/MacOS/Ispyx"
cp "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [ -f "$PKG/Resources/Ispyx.icns" ]; then
  cp "$PKG/Resources/Ispyx.icns" "$APP/Contents/Resources/Ispyx.icns"
else
  echo "    (no Resources/Ispyx.icns yet: the app gets the generic icon. Drop an .icns file there.)"
fi

# ---- 2b. bundle the Node core: Node binary, src/, production node_modules, launcher ----------------
# Must run on an Apple Silicon Mac: koffi downloads its darwin-arm64 prebuilt during `npm ci`.
echo "==> bundling Node and the core"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: no node binary found. Install Node 22+ (arm64) or set NODE_BIN=/path/to/node" >&2
  exit 1
fi
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
case "$(file -b "$NODE_BIN")" in
  *"Mach-O 64-bit executable arm64"*) ;;
  *) echo "error: $NODE_BIN is not an arm64 Mach-O executable: $(file -b "$NODE_BIN")" >&2; exit 1 ;;
esac
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "error: $NODE_BIN is Node $NODE_MAJOR; Node 22 or newer is required" >&2
  exit 1
fi
# The binary must be self-contained (the official nodejs.org build is; Homebrew's links to other dylibs).
if otool -L "$NODE_BIN" | tail -n +2 | awk '{print $1}' | grep -v -e '^/usr/lib/' -e '^/System/' >/dev/null; then
  echo "error: $NODE_BIN depends on libraries outside the system (Homebrew build?). Use the official arm64 build from nodejs.org, or set NODE_BIN." >&2
  otool -L "$NODE_BIN" >&2
  exit 1
fi

RES="$APP/Contents/Resources"
CORE="$RES/core"
mkdir -p "$RES/node/bin" "$CORE"
cp -L "$NODE_BIN" "$RES/node/bin/node"
chmod 755 "$RES/node/bin/node"

REPO="$(cd "$HERE/../.." && pwd)"
cp -R "$REPO/src" "$CORE/src"
cp "$REPO/package.json" "$REPO/package-lock.json" "$CORE/"
( cd "$CORE" && PATH="$RES/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund )

# keep only Mach-O libraries that run here (drop prebuilts of other systems and non-arm64 slices)
while IFS= read -r f; do
  desc="$(file -b "$f")"
  case "$desc" in
    *"Mach-O"*"arm64"*) ;;
    *) rm -f "$f" ;;
  esac
done < <(find "$CORE/node_modules" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \))

cp "$HERE/launcher/ispyx" "$RES/ispyx"
chmod 755 "$RES/ispyx"

# ---- 3. code signing ------------------------------------------------------------------------------
# Every Mach-O is signed on its own, innermost first, then the app. With SIGN_IDENTITY the hardened runtime and a
# secure timestamp are on (required for notarisation); without it everything is ad-hoc signed for local testing.
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
