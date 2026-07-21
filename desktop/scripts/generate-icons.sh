#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/to/Neuroforge_Logo.png" >&2
  exit 2
fi

SOURCE=$1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(dirname "$SCRIPT_DIR")
ASSETS_DIR="$DESKTOP_DIR/assets"
ICONSET_DIR="$ASSETS_DIR/NeuroForge.iconset"

if [ ! -f "$SOURCE" ]; then
  echo "Logo source does not exist: $SOURCE" >&2
  exit 1
fi

mkdir -p "$ASSETS_DIR/icons" "$ICONSET_DIR"
cp "$SOURCE" "$ASSETS_DIR/neuroforge-logo.png"
cp "$SOURCE" "$ASSETS_DIR/neuroforge-window.png"
cp "$SOURCE" "$ASSETS_DIR/neuroforge-splash.png"

make_icon() {
  pixels=$1
  output=$2
  /usr/bin/sips -s format png -z "$pixels" "$pixels" "$SOURCE" --out "$output" >/dev/null
}

make_icon 16 "$ICONSET_DIR/icon_16x16.png"
make_icon 32 "$ICONSET_DIR/icon_16x16@2x.png"
make_icon 32 "$ICONSET_DIR/icon_32x32.png"
make_icon 64 "$ICONSET_DIR/icon_32x32@2x.png"
make_icon 128 "$ICONSET_DIR/icon_128x128.png"
make_icon 256 "$ICONSET_DIR/icon_128x128@2x.png"
make_icon 256 "$ICONSET_DIR/icon_256x256.png"
make_icon 512 "$ICONSET_DIR/icon_256x256@2x.png"
make_icon 512 "$ICONSET_DIR/icon_512x512.png"
make_icon 1024 "$ICONSET_DIR/icon_512x512@2x.png"

for pixels in 16 32 64 128 256 512 1024; do
  make_icon "$pixels" "$ASSETS_DIR/icons/${pixels}x${pixels}.png"
done

if ! /usr/bin/iconutil --convert icns --output "$ASSETS_DIR/NeuroForge.icns" "$ICONSET_DIR" 2>/dev/null; then
  if [ ! -d "$DESKTOP_DIR/node_modules/png2icons" ]; then
    echo "iconutil could not convert the iconset and png2icons is not installed." >&2
    echo "Run npm install in $DESKTOP_DIR, then retry." >&2
    exit 1
  fi
  node "$SCRIPT_DIR/generate-icns.mjs" "$SOURCE" "$ASSETS_DIR/NeuroForge.icns"
fi
echo "Generated NeuroForge desktop icon assets in $ASSETS_DIR"
