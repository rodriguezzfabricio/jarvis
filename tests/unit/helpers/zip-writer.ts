/**
 * Writes zip archives byte by byte, so tests can craft what a hostile or broken fixture could hold (decision
 * 123's extraction limits): paths that climb out, symlink modes, sizes that lie, wrong checksums, and Go's
 * own layout (data descriptors after each entry, Unix modes, no folder entries).
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipItem {
  name: string;
  data?: Buffer | string;
  /** Unix mode in the upper external attributes (default a regular 0644 file). */
  mode?: number;
  /** 0 stored, 8 deflated; any other number is written as is, with the data stored. */
  method?: number;
  /** Extra general-purpose flag bits (1: encrypted). */
  flags?: number;
  /** The uncompressed size the headers claim (default the real one). */
  declaredSize?: number;
  /** The CRC-32 the headers claim (default the real one). */
  crc?: number;
  /** Sizes and CRC after the data, as Go's archive/zip writes them. */
  dataDescriptor?: boolean;
}

export function makeZip(items: readonly ZipItem[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const raw = Buffer.from(it.data ?? "");
    const method = it.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = it.crc ?? crc32(raw);
    const size = it.declaredSize ?? raw.length;
    const name = Buffer.from(it.name);
    const flags = 0x800 | (it.dataDescriptor ? 0x8 : 0) | (it.flags ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(it.dataDescriptor ? 0 : crc >>> 0, 14);
    local.writeUInt32LE(it.dataDescriptor ? 0 : body.length, 18);
    local.writeUInt32LE(it.dataDescriptor ? 0 : size, 22);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(it.dataDescriptor ? 16 : 0);
    if (it.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    parts.push(local, name, body, descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((it.mode ?? 0o100644) * 0x10000) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length & 0xffff, 8);
  end.writeUInt16LE(items.length & 0xffff, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
