/**
 * Line editing: retype a run, and move the rest of that line out of its way.
 *
 * Every edit is a splice into the original content stream, never a re-serialisation. That matters because a rebuilt
 * stream loses everything the editor did not model (colour operators, marked content, the exact numeric formatting),
 * and the point of this project is that the untouched 99% of a document stays untouched.
 *
 * Advance comes from the run: the font's `/Widths` when the caller read them, one em per glyph when it did not. This
 * module needs no branch for that, because `advanceOf` asks the run and the run knows whether its number was measured.
 * That is the one thing `/Widths` was always going to be able to change without touching a caller, and it did.
 */

import { tokenize, type Token } from "./content-stream.js";
import type { FontWidths } from "./fonts.js";
import type { PdfDocument, PdfPage } from "./pdf.js";
import { PdfError, appendRevision, streamBody } from "./pdf.js";
import { positionedRuns, type PositionedRun } from "./text-layout.js";

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Escapes a string for a PDF literal string: the three characters an editor can corrupt. */
export function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  const fixed = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function applyEdits(stream: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = stream;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > previousStart) throw new EditError("overlapping edits: two splices claim the same bytes");
    previousStart = edit.start;
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

interface ShowOperator {
  readonly operator: Token & { kind: "operator" };
  readonly args: Token[];
  readonly start: number;
  readonly end: number;
}

/** Locates the showing operator whose byte offset matches a positioned run, plus the byte span of its arguments. */
function showOperatorAt(tokens: readonly Token[], offset: number): ShowOperator {
  const index = tokens.findIndex((token) => token.kind === "operator" && token.offset === offset);
  if (index < 0) throw new EditError(`no showing operator at byte ${offset}`);
  const operator = tokens[index] as Token & { kind: "operator" };
  let first = index;
  while (first > 0 && tokens[first - 1]?.kind !== "operator") first -= 1;
  const args = tokens.slice(first, index);
  if (args.length === 0) throw new EditError(`showing operator at byte ${offset} has no arguments to replace`);
  const start = (args[0] as Token).offset;
  const end = operator.offset + operator.raw.length;
  return { operator, args, start, end };
}

/** The splice that replaces a run's text; kept separate so several edits can be applied in one pass. */
function replacementEdit(tokens: readonly Token[], run: PositionedRun, newText: string): TextEdit {
  const span = showOperatorAt(tokens, run.offset);
  const escaped = `(${escapePdfText(newText)})`;
  switch (span.operator.value) {
    case "Tj":
      return { start: span.start, end: span.end, replacement: `${escaped} Tj` };
    case "TJ":
      // a TJ array collapses to one string: its kerning numbers describe the old glyphs, not the new ones
      return { start: span.start, end: span.end, replacement: `[${escaped}] TJ` };
    case "'":
      return { start: span.start, end: span.end, replacement: `${escaped} '` };
    case '"':
      throw new EditError('the " operator carries word and character spacing that would be lost; rewrite it as Tj first');
    default:
      throw new EditError(`${span.operator.value} is not a text-showing operator`);
  }
}

const POSITIONING = new Set(["Tm", "Td", "TD", "T*", "TL", "BT"]);

/**
 * The splice that moves a run to an absolute x, by rewriting the positioning operator that put it there.
 *
 * Only the operators that actually set a position are adjustable: `T*` takes no arguments, so a run positioned by a new
 * line has nowhere to put a number and is refused by name rather than shifted by an unknown amount.
 */
function moveEdit(tokens: readonly Token[], run: PositionedRun, newX: number): TextEdit {
  const show = showOperatorAt(tokens, run.offset);
  const showIndex = tokens.indexOf(show.operator);

  for (let index = showIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== "operator" || !POSITIONING.has(token.value)) continue;
    let first = index;
    while (first > 0 && tokens[first - 1]?.kind !== "operator") first -= 1;
    const args = tokens.slice(first, index);
    const numbers = args.filter((arg) => arg.kind === "number") as (Token & { kind: "number" })[];

    if (token.value === "Tm") {
      const xToken = numbers[4];
      if (xToken === undefined) throw new EditError("Tm with fewer than six operands");
      return { start: xToken.offset, end: xToken.offset + xToken.raw.length, replacement: formatNumber(newX) };
    }
    if (token.value === "Td" || token.value === "TD") {
      const txToken = numbers[0];
      if (txToken === undefined) throw new EditError(`${token.value} with no horizontal operand`);
      const shifted = txToken.value + (newX - run.x);
      return { start: txToken.offset, end: txToken.offset + txToken.raw.length, replacement: formatNumber(shifted) };
    }
    if (token.value === "T*") {
      throw new EditError("this run starts a new line with T*, which takes no x operand, so it cannot be moved");
    }
    if (token.value === "BT") break;
  }
  throw new EditError(`no positioning operator before the run at byte ${run.offset}`);
}

/**
 * Byte offset where the operands of the operator that positioned this run begin.
 *
 * A reflow replaces a whole block of lines, so it needs the left edge of the first line's positioning group rather than
 * one number inside it. A run positioned by `BT` itself has no operands, and the offset returned is just past the `BT`,
 * because a replacement that swallowed the `BT` would sit outside a text object and every reader would reject it.
 */
export function positioningStart(tokens: readonly Token[], run: PositionedRun): number {
  const show = showOperatorAt(tokens, run.offset);
  const showIndex = tokens.indexOf(show.operator);

  for (let index = showIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== "operator" || !POSITIONING.has(token.value)) continue;
    if (token.value === "BT") return token.offset + token.raw.length;
    let first = index;
    while (first > 0 && tokens[first - 1]?.kind !== "operator") first -= 1;
    return (tokens[first] as Token).offset;
  }
  throw new EditError(`no positioning operator before the run at byte ${run.offset}`);
}

/** Byte offset just past this run's showing operator, which is where a block replacement stops. */
export function showEnd(tokens: readonly Token[], run: PositionedRun): number {
  const show = showOperatorAt(tokens, run.offset);
  return show.operator.offset + show.operator.raw.length;
}

/** Formats a coordinate the way this editor writes numbers: four decimals, no trailing zeros. */
export function formatCoordinate(value: number): string {
  return formatNumber(value);
}

/** Rewrites one run's text in place and returns the new stream. */
export function replaceRunText(stream: string, run: PositionedRun, newText: string): string {
  return applyEdits(stream, [replacementEdit(tokenize(stream), run, newText)]);
}

/** Moves one run to an absolute x and returns the new stream. */
export function moveRunTo(stream: string, run: PositionedRun, newX: number): string {
  return applyEdits(stream, [moveEdit(tokenize(stream), run, newX)]);
}

/**
 * How far the pen moves for a run's text.
 *
 * Measured from the font when the run carries its `/Widths`, and one em per glyph when it does not, which is exactly the
 * distinction `PositionedRun.advanceExact` reports. Shifting the rest of a line after an edit is only as right as this
 * number, which is why the fallback is not silent.
 */
export function advanceOf(run: PositionedRun, text: string = run.text): number {
  if (run.widths !== undefined) return run.widths.advance(text, run.fontSize);
  return text.length * run.fontSize;
}

export interface LineEdit {
  readonly stream: string;
  /** How much the rest of the line moved, in points. Negative when the new text is shorter. */
  readonly delta: number;
  /** How many later runs on the same line were repositioned. */
  readonly shifted: number;
}

/**
 * Replaces one run's text and pushes the rest of its line along by the difference in advance.
 *
 * "The rest of its line" is decided by y, not by stream order: a run is on the line if its baseline is within a
 * hundredth of a point, which is the same tolerance the text grouping uses.
 *
 * Pass the page's font widths to shift by a measured distance rather than one em per glyph; `delta` is then exact to the
 * thousandths the font declares.
 */
export function editLine(
  stream: string,
  runIndex: number,
  newText: string,
  fonts?: ReadonlyMap<string, FontWidths>,
): LineEdit {
  const tokens = tokenize(stream);
  const runs = positionedRuns(tokens, fonts);
  const target = runs[runIndex];
  if (target === undefined) throw new EditError(`no run at index ${runIndex}; the page has ${runs.length}`);
  if (target.fontSize <= 0) throw new EditError(`run ${runIndex} has no font size, so its advance cannot be computed`);

  const delta = advanceOf(target, newText) - advanceOf(target);
  // every splice is computed against the original stream's offsets and applied in one descending pass, so an earlier
  // replacement can never invalidate a later shift
  const edits: TextEdit[] = [replacementEdit(tokens, target, newText)];
  let shifted = 0;
  for (const later of runs.slice(runIndex + 1)) {
    if (Math.abs(later.y - target.y) > 0.01) continue;
    if (delta === 0) break;
    edits.push(moveEdit(tokens, later, later.x + delta));
    shifted += 1;
  }

  return { stream: applyEdits(stream, edits), delta, shifted };
}

/** Writes an edited content stream back as an incremental update, leaving every other byte of the file alone. */
export function saveEditedContent(document: PdfDocument, page: PdfPage, content: string): Uint8Array {
  const rootValue = document.trailer.get("Root");
  if (rootValue === null || rootValue === undefined || typeof rootValue !== "object" || !("kind" in rootValue) || rootValue.kind !== "ref") {
    throw new PdfError("trailer /Root is not an indirect reference");
  }
  const size = document.trailer.get("Size");
  if (typeof size !== "number") throw new PdfError("trailer has no /Size");
  const info = document.trailer.get("Info");
  const infoNumber = info !== null && typeof info === "object" && "kind" in info && info.kind === "ref" ? info.num : undefined;

  const body = streamBody(content);
  return appendRevision(
    document.bytes,
    [{ num: document.contentObjectNumber(page), body }],
    infoNumber === undefined ? { root: rootValue.num, size } : { root: rootValue.num, size, info: infoNumber },
  );
}
