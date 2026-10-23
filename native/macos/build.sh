#!/usr/bin/env bash
# Builds Ispyx.app (and optionally signs, notarises and packs it into a .dmg).
#
#   ./build.sh                       unsigned (ad-hoc signed) build for local testing -> build/Ispyx.app
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./build.sh
#                                    signed with the hardened runtime
#   SIGN_IDENTITY=... NOTARY_PROFILE=ispyx-notary ./build.sh
#                                    signed, notarised, stapled, and packed into build/Ispyx.dmg
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

# ---- 3. code signing ------------------------------------------------------------------------------
if [ -n "$SIGN_IDENTITY" ]; then
  echo "==> codesign (hardened runtime) as: $SIGN_IDENTITY"
  # >>> SIGNING STEP <<<
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  echo "==> ad-hoc signing (local testing only; macOS may ask for the permissions again after every rebuild)"
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP"
fi

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
