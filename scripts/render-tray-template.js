#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const [outFile, rawSize] = process.argv.slice(2);
const size = Number(rawSize);

if (!outFile || !Number.isInteger(size) || size <= 0) {
  console.error("Usage: render-tray-template.js <out.png> <size>");
  process.exit(1);
}

const VIEWBOX_SIZE = 44;
const SAMPLE_GRID = size <= 32 ? 8 : 4;

function distanceToSegmentSquared(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const x = start.x + t * dx;
  const y = start.y + t * dy;
  const px = point.x - x;
  const py = point.y - y;
  return px * px + py * py;
}

function isInStroke(point, points, width) {
  const radiusSquared = (width / 2) ** 2;
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegmentSquared(point, points[index - 1], points[index]) <= radiusSquared) {
      return true;
    }
  }
  return false;
}

const STROKES = [
  {
    width: 4.8,
    points: [
      { x: 17, y: 12 },
      { x: 8.8, y: 22 },
      { x: 17, y: 32 },
    ],
  },
  {
    width: 4.8,
    points: [
      { x: 27, y: 12 },
      { x: 35.2, y: 22 },
      { x: 27, y: 32 },
    ],
  },
  {
    width: 4.8,
    points: [
      { x: 18.4, y: 22 },
      { x: 25.6, y: 22 },
    ],
  },
];

function isCovered(point) {
  return STROKES.some((stroke) => isInStroke(point, stroke.points, stroke.width));
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    rows[rowStart] = 0;
    rgba.copy(rows, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const pixels = Buffer.alloc(size * size * 4);
const totalSamples = SAMPLE_GRID * SAMPLE_GRID;

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    let coveredSamples = 0;
    for (let sy = 0; sy < SAMPLE_GRID; sy += 1) {
      for (let sx = 0; sx < SAMPLE_GRID; sx += 1) {
        const point = {
          x: ((x + (sx + 0.5) / SAMPLE_GRID) / size) * VIEWBOX_SIZE,
          y: ((y + (sy + 0.5) / SAMPLE_GRID) / size) * VIEWBOX_SIZE,
        };
        if (isCovered(point)) coveredSamples += 1;
      }
    }

    const offset = (y * size + x) * 4;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = Math.round((coveredSamples / totalSamples) * 255);
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, encodePng(size, size, pixels));
