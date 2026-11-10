/**
 * Glyph advance, read from the font instead of assumed.
 *
 * `positionedRuns` used to advance one em per glyph, which is enough to tell runs apart and not enough to move text: an
 * em overstates Helvetica's average glyph by about a third, so after an edit that changed the length of a line, every
 * later run on that line landed in the wrong place. The real number is in the file. A simple font declares `/Widths`,
 * one integer per character code from `/FirstChar` to `/LastChar`, in thousandths of an em, plus a
 * `/FontDescriptor /MissingWidth` for codes it does not list.
 *
 * What is read, and what is refused, follows from what a width means in each font type:
 *
 * - `Type1`, `MMType1`, `TrueType`: one byte per code, so `code - FirstChar` indexes `/Widths` directly. These are read.
 * - `Type0`: codes are glyph indices chosen by a CMap and the widths live in `/W`, a different shape of table entirely.
 *   Refused by name, because indexing `/W` the way `/Widths` is indexed would measure the wrong glyph and look plausible.
 * - `Type3`: widths are in glyph space and scaled by `/FontMatrix`, so a raw `/Widths` integer is not a distance.
 * - no `/Widths` at all: refused. The base-14 fonts keep their metrics in Adobe's AFM files, which are not in the file;
 *   inventing them is the same guess as one em per glyph, and a guess that looks like a measurement is worse than an
 *   approximation that admits what it is.
 */

import type { PdfDocument, PdfPage, PdfValue } from "./pdf.js";

export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontError";
  }
}

/** One advance, with whether it came from the font's own table or from its declared default. */
export interface GlyphWidth {
  /** Thousandths of an em, which is how PDF stores a width. */
  readonly thousandths: number;
  /** False when the code fell outside `/FirstChar..LastChar` and `/MissingWidth` was used instead. */
  readonly exact: boolean;
}

export class FontWidths {
  constructor(
    readonly name: string,
    readonly subtype: string,
    private readonly firstChar: number,
    private readonly widths: readonly number[],
    private readonly missingWidth: number,
  ) {}

  get lastChar(): number {
    return this.firstChar + this.widths.length - 1;
  }

  /** The width of one character code, flagged when it came from `/MissingWidth` rather than the table. */
  widthOf(code: number): GlyphWidth {
    const index = code - this.firstChar;
    if (index >= 0 && index < this.widths.length) return { thousandths: this.widths[index] as number, exact: true };
    return { thousandths: this.missingWidth, exact: false };
  }

  /**
   * How far the pen moves for `text` at `fontSize`, in points.
   *
   * Character codes, not Unicode: a simple font's `/Widths` is indexed by the code in the string, which is what the
   * content stream contains.
   */
  advance(text: string, fontSize: number): number {
    let thousandths = 0;
    for (let index = 0; index < text.length; index += 1) thousandths += this.widthOf(text.charCodeAt(index)).thousandths;
    return (thousandths * fontSize) / 1000;
  }

  /** False when any code in `text` needed the default width, so the advance is real but not fully measured. */
  measuresExactly(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
      if (!this.widthOf(text.charCodeAt(index)).exact) return false;
    }
    return true;
  }
}

export interface PageFonts {
  /** Fonts whose advance can be measured, by the resource name the content stream uses. */
  readonly widths: ReadonlyMap<string, FontWidths>;
  /** Fonts the page names whose advance cannot be read, each with the reason. Callers fall back and say so. */
  readonly unresolved: ReadonlyMap<string, string>;
}

function nameOf(value: PdfValue | undefined, document: PdfDocument): string | null {
  if (value === undefined) return null;
  const resolved = document.resolve(value);
  return resolved !== null && typeof resolved === "object" && "kind" in resolved && resolved.kind === "name"
    ? resolved.name
    : null;
}

function numberOf(value: PdfValue | undefined, document: PdfDocument): number | null {
  if (value === undefined) return null;
  const resolved = document.resolve(value);
  return typeof resolved === "number" ? resolved : null;
}

/** The widths of every font a page can show text in, read from its `/Resources /Font`. */
export function pageFonts(document: PdfDocument, page: PdfPage): PageFonts {
  const widths = new Map<string, FontWidths>();
  const unresolved = new Map<string, string>();
  const resources = page.dict.get("Resources");
  if (resources === undefined) return { widths, unresolved };
  const entries = document.dictionary(resources).get("Font");
  if (entries === undefined) return { widths, unresolved };

  for (const [name, reference] of document.dictionary(entries)) {
    try {
      widths.set(name, readWidths(document, name, document.dictionary(reference)));
    } catch (error) {
      if (!(error instanceof FontError)) throw error;
      unresolved.set(name, error.message);
    }
  }
  return { widths, unresolved };
}

/** Reads one font dictionary, or throws `FontError` naming why this font's advance cannot be measured. */
export function readWidths(document: PdfDocument, name: string, dict: Map<string, PdfValue>): FontWidths {
  const subtype = nameOf(dict.get("Subtype"), document);
  if (subtype === null) throw new FontError(`${name} declares no /Subtype, so its encoding is unknown`);
  if (subtype === "Type0") {
    throw new FontError(
      `${name} is a Type0 font: its codes are glyph indices from a CMap and its widths live in /W, which this reader ` +
        "does not index",
    );
  }
  if (subtype === "Type3") {
    throw new FontError(`${name} is a Type3 font: its widths are in glyph space and need /FontMatrix to become points`);
  }
  if (subtype !== "Type1" && subtype !== "MMType1" && subtype !== "TrueType") {
    throw new FontError(`${name} has unsupported subtype /${subtype}`);
  }

  const firstChar = numberOf(dict.get("FirstChar"), document);
  const declared = dict.get("Widths");
  if (firstChar === null || declared === undefined) {
    throw new FontError(
      `${name} declares no /Widths, so its advance would be a guess: a base-14 font keeps its metrics in an AFM file ` +
        "that is not in this document",
    );
  }
  const resolved = document.resolve(declared);
  if (!Array.isArray(resolved)) throw new FontError(`${name} has a /Widths entry that is not an array`);

  const table: number[] = [];
  for (const entry of resolved) {
    const width = numberOf(entry, document);
    if (width === null) throw new FontError(`${name} has a non-numeric entry in /Widths`);
    table.push(width);
  }
  const lastChar = numberOf(dict.get("LastChar"), document);
  if (lastChar !== null && lastChar - firstChar + 1 !== table.length) {
    throw new FontError(
      `${name} declares /LastChar ${lastChar} but /Widths covers ${table.length} codes from ${firstChar}, so the table ` +
        "and the declared range disagree",
    );
  }

  // /MissingWidth is optional and defaults to 0 in the spec; recording whether it was declared is what lets a caller
  // know that an unlisted code was defaulted rather than measured.
  const descriptor = dict.get("FontDescriptor");
  let missingWidth = 0;
  if (descriptor !== undefined) {
    missingWidth = numberOf(document.dictionary(descriptor).get("MissingWidth"), document) ?? 0;
  }
  return new FontWidths(name, subtype, firstChar, table, missingWidth);
}
