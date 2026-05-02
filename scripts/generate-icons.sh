#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

render_svg() {
  src="$1"
  size="$2"
  out="$3"
  qlmanage -t -s "$size" -o "$TMP_DIR" "$src" >/dev/null 2>&1
  mv "$TMP_DIR/$(basename "$src").png" "$out"
}

render_svg "$BUILD_DIR/icon.svg" 1024 "$BUILD_DIR/icon.png"
render_svg "$BUILD_DIR/trayTemplate.svg" 22 "$BUILD_DIR/trayTemplate.png"
render_svg "$BUILD_DIR/trayTemplate.svg" 44 "$BUILD_DIR/trayTemplate@2x.png"

mkdir -p "$ROOT/src/assets"
cp "$BUILD_DIR/icon.png" "$ROOT/src/assets/icon.png"
cp "$BUILD_DIR/trayTemplate.png" "$ROOT/src/assets/trayTemplate.png"
cp "$BUILD_DIR/trayTemplate@2x.png" "$ROOT/src/assets/trayTemplate@2x.png"

ICONSET="$TMP_DIR/icon.iconset"
mkdir -p "$ICONSET"
sips -z 16 16 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$BUILD_DIR/icon.png" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"

ICO_DIR="$TMP_DIR/ico"
mkdir -p "$ICO_DIR"
for size in 16 32 48 64 128 256; do
  sips -z "$size" "$size" "$BUILD_DIR/icon.png" --out "$ICO_DIR/icon_${size}.png" >/dev/null
done

node - "$BUILD_DIR/icon.ico" "$ICO_DIR"/icon_*.png <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outFile, ...inputFiles] = process.argv.slice(2);
const images = inputFiles
  .map((file) => ({
    file,
    size: Number(path.basename(file).match(/_(\d+)\.png$/)?.[1] || 0),
    data: fs.readFileSync(file),
  }))
  .filter((image) => image.size > 0)
  .sort((a, b) => a.size - b.size);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = images.map((image) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
  entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.data.length;
  return entry;
});

fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
NODE

echo "Generated icons in $BUILD_DIR and src/assets"
