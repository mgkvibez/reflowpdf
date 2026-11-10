/**
 * Just enough PDF to edit one, and not one byte more.
 *
 * A content-stream lexer is useless on a real file unless you can get the stream out of it: the bytes live inside an
 * indirect object, usually compressed, referenced from a page dictionary, reachable through an xref table. So this is the
 * smallest reader that turns a file into "pages and their decoded content streams".
 *
 * Deliberate refusals, because a PDF reader that guesses is a PDF corruptor:
 *
 * - Cross-reference streams (PDF 1.5) are refused by name. Their offsets are stored in a compressed object, and mixing
 *   "not supported" with "silently treated as a missing object" would produce edits against the wrong bytes.
 * - Encrypted files are refused by name. Every string and stream is ciphertext, so an edit would write plaintext into a
 *   file the reader will try to decrypt.
 * - Unsupported stream filters are refused by name, with the filter in the message.
 *
 * Everything else here is derived from the specification: the `startxref` chain, `/Prev` for incremental updates, and
 * streams decoded through the platform's `DecompressionStream` rather than a bundled inflater.
 */

import { LayoutError, positionedRuns } from "./text-layout.js";
import { tokenize } from "./content-stream.js";

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

export interface PdfName {
  readonly kind: "name";
  readonly name: string;
}

export interface PdfString {
  readonly kind: "string";
  readonly value: string;
  readonly hex: boolean;
}

export interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}

export interface PdfStream {
  readonly kind: "stream";
  readonly dict: Map<string, PdfValue>;
  readonly raw: Uint8Array;
}

export type PdfValue =
  | number
  | boolean
  | null
  | PdfName
  | PdfString
  | PdfRef
  | PdfStream
  | PdfValue[]
  | Map<string, PdfValue>;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

class Cursor {
  constructor(readonly bytes: Uint8Array, public at: number) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  /** PDF whitespace, which deliberately includes NUL. */
  skipWhitespace(): void {
    for (;;) {
      const byte = this.bytes[this.at];
      if (byte === undefined) return;
      if (WS.has(byte)) {
        this.at += 1;
        continue;
      }
      if (byte === 0x25) {
        while (this.at < this.bytes.length && this.bytes[this.at] !== 0x0a && this.bytes[this.at] !== 0x0d) this.at += 1;
        continue;
      }
      return;
    }
  }

  byte(): number {
    const byte = this.bytes[this.at];
    if (byte === undefined) throw new PdfError(`unexpected end of file at byte ${this.at}`);
    return byte;
  }
}

const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (byte: number): boolean => !WS.has(byte) && !DELIMITERS.has(byte);

function readToken(cursor: Cursor): string {
  const start = cursor.at;
  while (cursor.at < cursor.bytes.length && isRegular(cursor.byte())) cursor.at += 1;
  if (cursor.at === start) throw new PdfError(`expected a token at byte ${start}`);
  return latin1(cursor.bytes.subarray(start, cursor.at));
}

/** PDF strings are bytes, not UTF-16. Latin-1 keeps every byte's value intact for a round trip. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function parseName(cursor: Cursor): PdfName {
  cursor.at += 1; // "/"
  const start = cursor.at;
  while (cursor.at < cursor.bytes.length && isRegular(cursor.byte())) cursor.at += 1;
  let name = latin1(cursor.bytes.subarray(start, cursor.at));
  // "#20" style escapes in names are rare but legal
  name = name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return { kind: "name", name };
}

function parseLiteralString(cursor: Cursor): PdfString {
  cursor.at += 1; // "("
  let depth = 0;
  const bytes: number[] = [];
  for (;;) {
    const byte = cursor.byte();
    if (byte === 0x5c) {
      const next = cursor.bytes[cursor.at + 1];
      if (next === undefined) throw new PdfError("unterminated escape in string");
      const simple: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
      if (next >= 0x30 && next <= 0x37) {
        // up to three octal digits
        let digits = "";
        let scan = cursor.at + 1;
        while (digits.length < 3 && scan < cursor.bytes.length) {
          const digit = cursor.bytes[scan] as number;
          if (digit < 0x30 || digit > 0x37) break;
          digits += String.fromCharCode(digit);
          scan += 1;
        }
        bytes.push(parseInt(digits, 8) & 0xff);
        cursor.at = scan;
        continue;
      }
      bytes.push(simple[next] ?? next);
      cursor.at += 2;
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) {
      if (depth === 0) {
        cursor.at += 1;
        break;
      }
      depth -= 1;
    }
    bytes.push(byte);
    cursor.at += 1;
  }
  return { kind: "string", value: latin1(Uint8Array.from(bytes)), hex: false };
}

function parseHexString(cursor: Cursor): PdfString {
  cursor.at += 1; // "<"
  let hex = "";
  while (cursor.at < cursor.bytes.length && cursor.byte() !== 0x3e) {
    hex += String.fromCharCode(cursor.byte());
    cursor.at += 1;
  }
  if (cursor.byte() !== 0x3e) throw new PdfError("unterminated hex string");
  cursor.at += 1;
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  let value = "";
  for (let i = 0; i < padded.length; i += 2) value += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return { kind: "string", value, hex: true };
}

/** Parses one PDF value. `12 0 R` is a reference, which is why numbers are read before being committed. */
export function parseValue(cursor: Cursor): PdfValue {
  cursor.skipWhitespace();
  const byte = cursor.byte();

  if (byte === 0x2f) return parseName(cursor);
  if (byte === 0x28) return parseLiteralString(cursor);
  if (byte === 0x3c && cursor.bytes[cursor.at + 1] === 0x3c) {
    cursor.at += 2;
    const dict = new Map<string, PdfValue>();
    for (;;) {
      cursor.skipWhitespace();
      if (cursor.bytes[cursor.at] === 0x3e && cursor.bytes[cursor.at + 1] === 0x3e) {
        cursor.at += 2;
        return dict;
      }
      if (cursor.done) throw new PdfError("unterminated dictionary");
      const key = parseName(cursor);
      dict.set(key.name, parseValue(cursor));
    }
  }
  if (byte === 0x3c) return parseHexString(cursor);
  if (byte === 0x5b) {
    cursor.at += 1;
    const array: PdfValue[] = [];
    for (;;) {
      cursor.skipWhitespace();
      if (cursor.bytes[cursor.at] === 0x5d) {
        cursor.at += 1;
        return array;
      }
      if (cursor.done) throw new PdfError("unterminated array");
      array.push(parseValue(cursor));
    }
  }

  if (byte === 0x74 && latin1(cursor.bytes.subarray(cursor.at, cursor.at + 4)) === "true") {
    cursor.at += 4;
    return true;
  }
  if (byte === 0x66 && latin1(cursor.bytes.subarray(cursor.at, cursor.at + 5)) === "false") {
    cursor.at += 5;
    return false;
  }
  if (byte === 0x6e && latin1(cursor.bytes.subarray(cursor.at, cursor.at + 4)) === "null") {
    cursor.at += 4;
    return null;
  }

  const token = readToken(cursor);
  const numeric = Number(token);
  if (!Number.isFinite(numeric)) throw new PdfError(`expected a value, found ${JSON.stringify(token)} at byte ${cursor.at}`);
  // look ahead for "gen R"
  const save = cursor.at;
  cursor.skipWhitespace();
  let looksLikeRef = false;
  let gen = 0;
  if (cursor.at < cursor.bytes.length && cursor.bytes[cursor.at] !== undefined && /[0-9]/.test(String.fromCharCode(cursor.byte()))) {
    const genToken = readToken(cursor);
    const parsed = Number(genToken);
    cursor.skipWhitespace();
    if (Number.isFinite(parsed) && cursor.bytes[cursor.at] === 0x52) {
      const after = cursor.bytes[cursor.at + 1];
      if (after === undefined || WS.has(after) || DELIMITERS.has(after)) {
        cursor.at += 1;
        gen = parsed;
        looksLikeRef = true;
      }
    }
  }
  if (looksLikeRef) return { kind: "ref", num: numeric, gen };
  cursor.at = save;
  return numeric;
}

/** Minimal shape of the platform inflater; declared locally because this project carries no DOM or Node types. */
interface Inflater {
  readonly readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
  readonly writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
}

type InflaterCtor = new (format: "deflate" | "deflate-raw" | "gzip") => Inflater;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const platform = globalThis as unknown as { DecompressionStream?: InflaterCtor };
  const Ctor = platform.DecompressionStream;
  if (Ctor === undefined) throw new PdfError("this runtime has no DecompressionStream, so FlateDecode cannot be decoded");
  const stream = new Ctor("deflate");
  const writer = stream.writable.getWriter();
  const pending = writer.write(bytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
    }
  }
  await pending;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The attributes a page inherits from its `/Pages` ancestors, and therefore attributes it can be missing from its own
 * dictionary. `/Resources` is the one that matters here: a writer that puts fonts on the tree node and not on every
 * page is common, and reading only the page would find no fonts and fall back to guessing advance on a readable file.
 */
const INHERITABLE_KEYS = ["Resources", "MediaBox", "CropBox", "Rotate"] as const;

/** A page dictionary with its inherited attributes filled in, without mutating the cached object. */
function withInherited(dict: Map<string, PdfValue>, inherited: ReadonlyMap<string, PdfValue>): Map<string, PdfValue> {
  let merged: Map<string, PdfValue> | null = null;
  for (const key of INHERITABLE_KEYS) {
    if (dict.has(key) || !inherited.has(key)) continue;
    merged ??= new Map(dict);
    merged.set(key, inherited.get(key) as PdfValue);
  }
  return merged ?? dict;
}

export interface PdfPage {
  readonly index: number;
  readonly dict: Map<string, PdfValue>;
  /** The page's content stream, decoded and concatenated. */
  readonly content: string;
}

interface XrefEntry {
  readonly offset: number;
  readonly gen: number;
  readonly inUse: boolean;
}

export class PdfDocument {
  private constructor(
    readonly bytes: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: Map<string, PdfValue>,
    private readonly cache: Map<number, PdfValue>,
  ) {}

  static async open(bytes: Uint8Array): Promise<PdfDocument> {
    const text = latin1(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!text.startsWith("%PDF-")) throw new PdfError("not a PDF: the file does not start with %PDF-");

    const entries = new Map<number, XrefEntry>();
    const trailer = new Map<string, PdfValue>();
    let offset: number | null = findStartXref(bytes);

    for (let hops = 0; offset !== null; hops += 1) {
      if (hops > 64) throw new PdfError("cross-reference chain does not terminate");
      const section = readXrefSection(bytes, offset);
      // newest section first: an incremental update must win over the revision it updates
      for (const [num, entry] of section.entries) if (!entries.has(num)) entries.set(num, entry);
      for (const [key, value] of section.trailer) if (!trailer.has(key)) trailer.set(key, value);
      const prev = section.trailer.get("Prev");
      offset = typeof prev === "number" ? prev : null;
    }

    if (entries.size === 0) throw new PdfError("no cross-reference entries: the file has no readable objects");
    if (trailer.has("Encrypt")) throw new PdfError("encrypted PDFs are not supported: every string and stream is ciphertext");
    if (!trailer.has("Root")) throw new PdfError("trailer has no /Root, so the page tree cannot be found");
    return new PdfDocument(bytes, entries, trailer, new Map());
  }

  /** Parses one indirect object, or throws if the file does not contain it. */
  getObject(num: number): PdfValue {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(num);
    if (entry === undefined || !entry.inUse) throw new PdfError(`object ${num} is not in the cross-reference table`);

    const cursor = new Cursor(this.bytes, entry.offset);
    const head = `${num}`;
    if (latin1(this.bytes.subarray(cursor.at, cursor.at + head.length)) !== head) {
      throw new PdfError(`cross-reference points at ${entry.offset} for object ${num}, but that offset holds another object`);
    }
    cursor.at += head.length;
    cursor.skipWhitespace();
    readToken(cursor); // generation
    cursor.skipWhitespace();
    if (readToken(cursor) !== "obj") throw new PdfError(`object ${num} at ${entry.offset} does not start with "obj"`);

    let value = parseValue(cursor);
    cursor.skipWhitespace();
    const marker = latin1(this.bytes.subarray(cursor.at, cursor.at + 6));
    if (marker === "stream" && value instanceof Map) {
      let at = cursor.at + 6;
      if (this.bytes[at] === 0x0d) at += 1;
      if (this.bytes[at] === 0x0a) at += 1;
      const declared = value.get("Length");
      const length = typeof declared === "number" ? declared : this.indirectNumber(declared);
      if (length === null || length < 0 || at + length > this.bytes.length) {
        throw new PdfError(`object ${num} declares a stream length that does not fit in the file`);
      }
      value = { kind: "stream", dict: value, raw: this.bytes.subarray(at, at + length) };
    }
    this.cache.set(num, value);
    return value;
  }

  private indirectNumber(value: PdfValue | undefined): number | null {
    if (typeof value === "number") return value;
    if (value !== null && typeof value === "object" && "kind" in value && value.kind === "ref") {
      const resolved = this.getObject(value.num);
      return typeof resolved === "number" ? resolved : null;
    }
    return null;
  }

  /** Follows references until a direct value is reached. */
  resolve(value: PdfValue): PdfValue {
    let current = value;
    for (let hops = 0; current !== null && typeof current === "object" && "kind" in current && current.kind === "ref"; hops += 1) {
      if (hops > 32) throw new PdfError("reference cycle while resolving a value");
      current = this.getObject(current.num);
    }
    return current;
  }

  dictionary(value: PdfValue): Map<string, PdfValue> {
    const resolved = this.resolve(value);
    if (resolved instanceof Map) return resolved;
    if (resolved !== null && typeof resolved === "object" && "kind" in resolved && resolved.kind === "stream") return resolved.dict;
    throw new PdfError("expected a dictionary");
  }

  async decode(value: PdfValue): Promise<Uint8Array> {
    const resolved = this.resolve(value);
    if (resolved === null || typeof resolved !== "object" || !("kind" in resolved) || resolved.kind !== "stream") {
      throw new PdfError("expected a stream");
    }
    const filter = resolved.dict.get("Filter");
    if (filter === undefined) return resolved.raw;
    const names = Array.isArray(filter) ? filter : [filter];
    const decodeParms = resolved.dict.get("DecodeParms");

    let data = resolved.raw;
    let position = 0;
    for (const entry of names) {
      const name = entry !== null && typeof entry === "object" && "kind" in entry && entry.kind === "name" ? entry.name : null;
      if (name === null) throw new PdfError(`stream filter entry is not a name: ${describeFilters(names)}`);
      data = await this.applyFilter(name, data, decodeParms, position);
      position += 1;
    }
    return data;
  }

  private async applyFilter(name: string, data: Uint8Array, decodeParms: PdfValue | undefined, position: number): Promise<Uint8Array> {
    if (name === "FlateDecode" || name === "Fl") {
      this.refusePredictor(decodeParms, position);
      return inflate(data);
    }
    if (name === "ASCII85Decode" || name === "A85") return ascii85(data);
    if (name === "ASCIIHexDecode" || name === "AHx") return asciiHex(data);
    throw new PdfError(`unsupported stream filter ${name}`);
  }

  /** A predictor changes the bytes a filter produces, so ignoring one would hand out corrupt text. */
  private refusePredictor(decodeParms: PdfValue | undefined, position: number): void {
    if (decodeParms === undefined || decodeParms === null) return;
    const parms = this.resolve(decodeParms);
    const entry = Array.isArray(parms) ? parms[position] : parms;
    if (entry === undefined || entry === null) return;
    const dict = this.resolve(entry as PdfValue);
    if (!(dict instanceof Map) || dict.size === 0) return;
    if (dict.has("Predictor")) throw new PdfError("FlateDecode with a /Predictor is not supported");
  }

  get pages(): PdfPage[] {
    const root = this.dictionary(this.trailer.get("Root") as PdfValue);
    const pagesRef = root.get("Pages");
    if (pagesRef === undefined) throw new PdfError("catalog has no /Pages");
    const collected: PdfPage[] = [];
    this.walk(pagesRef, collected, new Map());
    return collected;
  }

  private walk(node: PdfValue, out: PdfPage[], inherited: ReadonlyMap<string, PdfValue>): void {
    const dict = this.dictionary(node);
    const type = this.resolve(dict.get("Type") as PdfValue);
    const name = type !== null && typeof type === "object" && "kind" in type && type.kind === "name" ? type.name : "";
    if (name === "Page") {
      out.push({ index: out.length, dict: withInherited(dict, inherited), content: "" });
      return;
    }
    const kids = this.resolve(dict.get("Kids") as PdfValue);
    if (!Array.isArray(kids)) throw new PdfError("page tree node has neither /Page type nor /Kids");
    const next = new Map(inherited);
    for (const key of INHERITABLE_KEYS) {
      const value = dict.get(key);
      if (value !== undefined) next.set(key, value);
    }
    for (const kid of kids) this.walk(kid, out, next);
  }

  /** Every page's decoded content, concatenated in reading order, with the pages filled in. */
  async readPages(): Promise<PdfPage[]> {
    const pages = this.pages;
    const filled: PdfPage[] = [];
    for (const page of pages) {
      const contents = page.dict.get("Contents");
      const list = contents === undefined ? [] : Array.isArray(this.resolve(contents)) ? (this.resolve(contents) as PdfValue[]) : [contents];
      const parts: string[] = [];
      for (const part of list) parts.push(latin1(await this.decode(part)));
      filled.push({ index: page.index, dict: page.dict, content: parts.join("\n") });
    }
    return filled;
  }

  /** The object number of a page's /Contents when it is a single indirect stream, which is what an edit replaces. */
  contentObjectNumber(page: PdfPage): number {
    const contents = page.dict.get("Contents");
    if (contents === null || contents === undefined || typeof contents !== "object" || !("kind" in contents) || contents.kind !== "ref") {
      throw new PdfError("page /Contents is not a single indirect object, so it cannot be replaced in place");
    }
    return contents.num;
  }

}

/** Text as a reader would see it: every page's lines, top of page first. */
export function documentText(pages: readonly PdfPage[]): string {
  return pages
    .map((page) => pageText(page.content))
    .filter((text) => text.length > 0)
    .join("\n");
}

export function pageText(content: string): string {
  let runs;
  try {
    runs = positionedRuns(tokenize(content));
  } catch (error) {
    if (error instanceof LayoutError) throw new PdfError(`cannot read text: ${error.message}`);
    throw error;
  }
  const rows = new Map<number, { x: number; text: string }[]>();
  for (const run of runs) {
    const key = Math.round(run.y * 100) / 100;
    const row = rows.get(key) ?? [];
    row.push({ x: run.x, text: run.text });
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((piece) => piece.text).join(""))
    .join("\n");
}

/** ASCII85, which PDF uses as a cheap ASCII armour around compressed streams. */
function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  let started = false;
  for (const byte of data) {
    if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00 || byte === 0x0c) continue;
    if (byte === 0x7e) break; // ~>
    if (byte === 0x3c && !started) {
      started = true; // <~
      continue;
    }
    started = true;
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) throw new PdfError(`invalid ASCII85 byte ${byte}`);
    group.push(byte - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 0) {
    if (group.length === 1) throw new PdfError("ASCII85 group of one digit cannot be decoded");
    const width = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, width - 1));
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const digits: string[] = [];
  for (const byte of data) {
    if (byte === 0x3e) break; // >
    const char = String.fromCharCode(byte);
    if (/[0-9a-fA-F]/.test(char)) digits.push(char);
  }
  if (digits.length % 2 === 1) digits.push("0");
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < digits.length; i += 2) out[i / 2] = parseInt(`${digits[i]}${digits[i + 1]}`, 16);
  return out;
}

function describeFilters(values: readonly PdfValue[]): string {
  return values
    .map((value) => (value !== null && typeof value === "object" && "kind" in value && value.kind === "name" ? `/${value.name}` : "?"))
    .join(" ");
}

function findStartXref(bytes: Uint8Array): number {
  const tailStart = Math.max(0, bytes.length - 2048);
  const tail = latin1(bytes.subarray(tailStart));
  const at = tail.lastIndexOf("startxref");
  if (at < 0) throw new PdfError("no startxref: the file has no cross-reference table pointer");
  const match = /startxref\s+(\d+)/.exec(tail.slice(at));
  if (match === null) throw new PdfError("startxref is not followed by an offset");
  const offset = Number(match[1]);
  if (offset < 0 || offset >= bytes.length) throw new PdfError(`startxref points outside the file (${offset})`);
  return offset;
}

interface XrefSection {
  readonly entries: Map<number, XrefEntry>;
  readonly trailer: Map<string, PdfValue>;
}

function readXrefSection(bytes: Uint8Array, offset: number): XrefSection {
  const entries = new Map<number, XrefEntry>();
  const cursor = new Cursor(bytes, offset);
  cursor.skipWhitespace();
  const token = latin1(bytes.subarray(cursor.at, cursor.at + 4));
  if (token !== "xref") {
    // A cross-reference stream starts with "N G obj" here
    throw new PdfError(
      `cross-reference streams are not supported (found ${JSON.stringify(token)} at byte ${offset}); save the file with a classic xref table`,
    );
  }
  cursor.at += 4;

  for (;;) {
    cursor.skipWhitespace();
    if (latin1(bytes.subarray(cursor.at, cursor.at + 7)) === "trailer") {
      cursor.at += 7;
      const trailer = parseValue(cursor);
      if (!(trailer instanceof Map)) throw new PdfError("trailer is not a dictionary");
      return { entries, trailer };
    }
    const start = Number(readToken(cursor));
    cursor.skipWhitespace();
    const count = Number(readToken(cursor));
    if (!Number.isFinite(start) || !Number.isFinite(count)) throw new PdfError(`malformed xref subsection at byte ${cursor.at}`);
    for (let i = 0; i < count; i += 1) {
      cursor.skipWhitespace();
      const position = Number(readToken(cursor));
      cursor.skipWhitespace();
      const gen = Number(readToken(cursor));
      cursor.skipWhitespace();
      const kind = latin1(bytes.subarray(cursor.at, cursor.at + 1));
      cursor.at += 1;
      if (!Number.isFinite(position) || !Number.isFinite(gen)) throw new PdfError(`malformed xref entry at byte ${cursor.at}`);
      const num = start + i;
      if (entries.has(num)) continue; // first definition in this section wins
      entries.set(num, { offset: position, gen, inUse: kind === "n" });
    }
  }
}

/**
 * Appends an incremental update: the original bytes are copied unchanged, and only the replaced objects plus a new xref
 * section are added. That is what makes "the rest of the file is untouched" checkable instead of promised.
 */
export function appendRevision(
  original: Uint8Array,
  replacements: readonly { num: number; gen?: number; body: string }[],
  trailer: { root: number; size: number; info?: number },
): Uint8Array {
  if (replacements.length === 0) throw new PdfError("an incremental update with no replacements is a wasted revision");
  const parts: string[] = [];
  const previous = findStartXref(original);
  let length = original.length;
  const tail = latin1(original.subarray(Math.max(0, original.length - 64)));
  if (!tail.includes("%%EOF")) throw new PdfError("original file does not end with %%EOF, so an update cannot be appended");

  const offsets = new Map<number, { offset: number; gen: number }>();
  let body = "";
  body += "\n";
  for (const replacement of replacements) {
    const gen = replacement.gen ?? 0;
    if (!Number.isInteger(replacement.num) || replacement.num <= 0) throw new PdfError(`invalid object number ${replacement.num}`);
    if (offsets.has(replacement.num)) throw new PdfError(`object ${replacement.num} is replaced twice in one revision`);
    offsets.set(replacement.num, { offset: length + body.length, gen });
    body += `${replacement.num} ${gen} obj\n${replacement.body}\nendobj\n`;
  }

  const numbers = [...offsets.keys()].sort((a, b) => a - b);
  const xrefOffset = length + body.length;
  let xref = "xref\n";
  for (let i = 0; i < numbers.length; ) {
    const first = numbers[i] as number;
    let last = first;
    while (i + 1 < numbers.length && numbers[i + 1] === last + 1) {
      i += 1;
      last = numbers[i] as number;
    }
    xref += `${first} ${last - first + 1}\n`;
    for (let num = first; num <= last; num += 1) {
      const entry = offsets.get(num) as { offset: number; gen: number };
      xref += `${String(entry.offset).padStart(10, "0")} ${String(entry.gen).padStart(5, "0")} n \n`;
    }
    i += 1;
  }
  const highest = Math.max(...numbers);
  const size = Math.max(trailer.size, highest + 1);
  let trailerDict = `<< /Size ${size} /Root ${trailer.root} 0 R /Prev ${previous}`;
  if (trailer.info !== undefined) trailerDict += ` /Info ${trailer.info} 0 R`;
  trailerDict += " >>";
  parts.push(body, xref, "trailer\n", trailerDict, "\nstartxref\n", `${xrefOffset}\n`, "%%EOF\n");

  const appended = parts.join("");
  const out = new Uint8Array(length + appended.length);
  out.set(original, 0);
  for (let i = 0; i < appended.length; i += 1) out[length + i] = appended.charCodeAt(i) & 0xff;
  return out;
}

/** A stream object for an edited content stream: uncompressed, because a hand-written length cannot disagree with itself. */
export function streamBody(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
}
