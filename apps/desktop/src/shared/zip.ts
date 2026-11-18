// The parts of the zip format the updater reads from a release's archive without downloading all of
// it: the end record and the central directory (which say where each file is and how big it is), and
// a local header (which says where the file's data starts). Pure: bytes in, numbers out.
//
// Only what `ditto -c -k` writes is accepted: no zip64, no encryption, and the two methods a bundle
// uses (stored and deflated). Anything else throws, and the updater then downloads the whole archive.

export type ZipEntry = {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  /** Of the data in the archive, and of the file. */
  csize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
  /** The length of the name in the central directory. */
  nameLength: number;
};

export type ZipEnd = { entries: number; directorySize: number; directoryOffset: number };

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const SENTINEL = 0xffffffff;

/** The end record is 22 bytes and may be followed by a comment of up to 65535 bytes. */
export const END_SEARCH = 22 + 0xffff;
export const LOCAL_HEADER = 30;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Finds the end record in the last bytes of an archive. */
export const parseEnd = (tail: Uint8Array): ZipEnd => {
  const data = view(tail);
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (data.getUint32(at, true) !== END_SIGNATURE) continue;
    if (at + 22 + data.getUint16(at + 20, true) !== tail.length) continue;
    const entries = data.getUint16(at + 10, true);
    const directorySize = data.getUint32(at + 12, true);
    const directoryOffset = data.getUint32(at + 16, true);
    if (entries === 0xffff || directorySize === SENTINEL || directoryOffset === SENTINEL)
      throw new Error("The archive is zip64, which the updater does not read piecewise.");
    return { entries, directorySize, directoryOffset };
  }
  throw new Error("The archive has no end record.");
};

/** The entries of a central directory, by name. */
export const parseDirectory = (bytes: Uint8Array, entries: number): Map<string, ZipEntry> => {
  const data = view(bytes);
  const found = new Map<string, ZipEntry>();
  let at = 0;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > bytes.length || data.getUint32(at, true) !== CENTRAL_SIGNATURE)
      throw new Error("The archive's directory is damaged.");
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const csize = data.getUint32(at + 20, true);
    const size = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const offset = data.getUint32(at + 42, true);
    if (at + 46 + nameLength > bytes.length) throw new Error("The archive's directory is damaged.");
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if ((flags & 1) !== 0) throw new Error(`The archive's ${name} is encrypted.`);
    if (csize === SENTINEL || size === SENTINEL || offset === SENTINEL)
      throw new Error("The archive is zip64, which the updater does not read piecewise.");
    if (found.has(name)) throw new Error(`The archive lists ${name} twice.`);
    found.set(name, { name, method, csize, size, offset, nameLength });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
};

/** What a local header (its first 30 bytes) says of the bytes that follow it before the data. */
export const parseLocal = (header: Uint8Array): { nameLength: number; extraLength: number } => {
  if (header.length < LOCAL_HEADER) throw new Error("The archive ended inside a file's header.");
  const data = view(header);
  if (data.getUint32(0, true) !== LOCAL_SIGNATURE)
    throw new Error("The archive has no file where its directory says one starts.");
  return { nameLength: data.getUint16(26, true), extraLength: data.getUint16(28, true) };
};
