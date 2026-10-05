#!/usr/bin/env bash
# Wrap the PyInstaller output (dist/NetSeer) into an AppImage and a portable tarball.
#   bash packaging/linux/build-appimage.sh 0.3.0
set -euo pipefail

VERSION="${1:?usage: build-appimage.sh <version>}"
ARCH="${ARCH:-x86_64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
DIST="$ROOT/dist"
APPDIR="$ROOT/build/NetSeer.AppDir"
TOOL_VERSION="1.9.1"
TOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
TOOL="$ROOT/build/appimagetool-$TOOL_VERSION-x86_64.AppImage"

test -x "$DIST/NetSeer/NetSeer" || { echo "Run PyInstaller first (packaging/linux/netseer.spec)." >&2; exit 1; }

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/applications" \
  "$APPDIR/usr/share/icons/hicolor/256x256/apps" "$APPDIR/usr/share/icons/hicolor/scalable/apps"
cp -a "$DIST/NetSeer" "$APPDIR/usr/lib/netseer"
install -m 755 "$HERE/AppRun" "$APPDIR/AppRun"
install -m 644 "$HERE/netseer.desktop" "$APPDIR/netseer.desktop"
install -m 644 "$HERE/netseer.desktop" "$APPDIR/usr/share/applications/netseer.desktop"
install -m 644 "$HERE/netseer.png" "$APPDIR/netseer.png"
install -m 644 "$HERE/netseer.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/netseer.png"
install -m 644 "$HERE/netseer.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/netseer.svg"
ln -sf netseer.png "$APPDIR/.DirIcon"

if [ ! -x "$TOOL" ]; then
  mkdir -p "$(dirname "$TOOL")"
  curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/$TOOL_VERSION/appimagetool-x86_64.AppImage"
  echo "$TOOL_SHA256  $TOOL" | sha256sum -c -
  chmod +x "$TOOL"
fi

OUT="$DIST/NetSeer-$VERSION-$ARCH.AppImage"
# Extract-and-run works where FUSE isn't available (CI runners, containers).
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$ARCH" "$TOOL" --no-appstream "$APPDIR" "$OUT"
chmod +x "$OUT"

tar -C "$DIST" -czf "$DIST/NetSeer-$VERSION-linux-$ARCH.tar.gz" NetSeer
echo "Built $OUT"
echo "Built $DIST/NetSeer-$VERSION-linux-$ARCH.tar.gz"
