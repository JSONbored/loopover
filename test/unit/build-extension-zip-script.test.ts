import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crc32, createStoredZip, listFiles } from "../../scripts/extension-zip-core.js";

// Minimal reader for the STORED (uncompressed) archives createStoredZip writes. It walks the
// end-of-central-directory + central directory rather than trusting insertion order, so a wrong
// byte offset anywhere in the writer (the running `offset` accumulator, a header field length, a
// signature) surfaces as a parse failure or a content mismatch instead of a corrupted download.
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ExtractedEntry {
  name: string;
  data: Buffer;
  storedCrc: number;
}

function readStoredZip(zip: Buffer): ExtractedEntry[] {
  const eocdOffset = zip.length - 22;
  expect(zip.readUInt32LE(eocdOffset)).toBe(SIG_EOCD);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: ExtractedEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(SIG_CENTRAL);
    const storedCrc = zip.readUInt32LE(cursor + 16);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    // Follow the central directory's pointer into the local file header and slice the payload.
    expect(zip.readUInt32LE(localOffset)).toBe(SIG_LOCAL);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + uncompressedSize);

    entries.push({ name, data: Buffer.from(data), storedCrc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(eocdOffset);
  return entries;
}

describe("build-extension.ts zip writer (#7464)", () => {
  describe("crc32", () => {
    it("matches the canonical CRC-32 test vector", () => {
      // crc32("123456789") === 0xCBF43926 is the standard reference vector for CRC-32/ISO-HDLC.
      expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    });

    it("returns 0 for empty input and an unsigned 32-bit result for arbitrary bytes", () => {
      expect(crc32(Buffer.alloc(0))).toBe(0);
      const value = crc32(Buffer.from([0x00, 0xff, 0x10, 0x80]));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(value)).toBe(true);
    });
  });

  describe("listFiles", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "loopover-listfiles-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns every nested file as a sorted absolute path", () => {
      mkdirSync(join(dir, "icons"), { recursive: true });
      writeFileSync(join(dir, "manifest.json"), "{}");
      writeFileSync(join(dir, "background.js"), "//");
      writeFileSync(join(dir, "icons", "icon-16.png"), "png");

      const files = listFiles(dir);
      expect(files).toEqual([
        join(dir, "background.js"),
        join(dir, "icons", "icon-16.png"),
        join(dir, "manifest.json"),
      ]);
    });
  });

  describe("createStoredZip", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "loopover-storedzip-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("round-trips every fixture file back out byte-for-byte", () => {
      const fixtures: Record<string, Buffer> = {
        "manifest.json": Buffer.from('{"name":"loopover","version":"1.0.0"}'),
        "background.js": Buffer.from("console.log('bg');\n"),
        // Binary content with the full byte range exercises the CRC and the length fields.
        "icons/icon-16.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x42]),
        "empty.txt": Buffer.alloc(0),
      };
      mkdirSync(join(dir, "icons"), { recursive: true });
      for (const [name, data] of Object.entries(fixtures)) {
        writeFileSync(join(dir, name), data);
      }

      const zip = createStoredZip(dir);
      const entries = readStoredZip(zip);

      // listFiles sorts, so the archive lists names in sorted order.
      expect(entries.map((entry) => entry.name)).toEqual([
        "background.js",
        "empty.txt",
        "icons/icon-16.png",
        "manifest.json",
      ]);

      for (const entry of entries) {
        const expected = fixtures[entry.name];
        expect(expected).toBeDefined();
        expect(entry.data).toEqual(expected);
        // The CRC recorded in the header must be the real CRC of the stored bytes.
        expect(entry.storedCrc).toBe(crc32(entry.data));
      }
    });

    it("preserves a directory-name separator in stored entry names", () => {
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "nested", "file.js"), "x");

      const entries = readStoredZip(createStoredZip(dir));
      expect(entries.map((entry) => entry.name)).toEqual(["nested/file.js"]);
    });
  });
});
