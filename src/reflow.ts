/**
 * Reflow: retype a paragraph and have it re-break inside the column it already sits in.
 *
 * This is the feature the repository exists for, and it has three parts that are each a place to invent something. The
 * column is not in the file: it has to be read off the lines that are there, so it is inferred as the left edge they
 * share and the width of the widest one, which is the only width the document actually states. The break has to be made
 * with measured advances, which is why this module takes the page's font widths. And the result has to go back into the
 * stream as show operators, which is why the replacement is one splice covering exactly the block and nothing else.
 *
 * When the paragraph grows, the text below it is pushed down by the same amount, because a reflow that leaves the page
 * overlapping is not a reflow. Only absolute `Tm` placement can be adjusted, so a file that positions its later text with
 * relative moves is refused by name instead of half-moved.
 *
 * What this does not do: hyphenate (a word wider than the column overflows rather than being split, because a hyphen
 * that is not in the font produces a missing glyph), justify (the file's own spacing operators are not modelled, so every
 * line is set flush left at the column edge), or mix fonts inside one paragraph (a block with two fonts is refused by
 * name, since reflow would have to decide which one the new text is in). It moves text, not graphics: a rectangle or an
 * image below a grown paragraph stays where it was.
 */

import { tokenize } from "./content-stream.js";
import {
  applyEdits,
  escapePdfText,
  formatCoordinate,
  moveRunDown,
  positioningStart,
  showEnd,
  type TextEdit,
} from "./edit.js";
import type { FontWidths } from "./fonts.js";
import { positionedRuns, type PositionedRun } from "./text-layout.js";

export class ReflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflowError";
  }
}

/** The horizontal extent a paragraph is allowed to occupy, in points. */
export interface Column {
  readonly left: number;
  readonly right: number;
}

export interface ReflowOptions {
  /** How many lines the paragraph occupies today. Default 1. */
  readonly lineCount?: number;
  /** Baseline-to-baseline distance, for a one-line paragraph where no neighbour states it. */
  readonly leading?: number;
  /** The page's font widths. Without them the break is made with one em per glyph and says so. */
  readonly fonts?: ReadonlyMap<string, FontWidths>;
  /**
   * Move the text below out of the way when the paragraph grows or shrinks. Default true.
   *
   * Passing false keeps the rest of the page where it is and accepts the overlap, which is what a caller wants when it is
   * about to re-lay the whole page itself. Naming it false is the only way to get an overlapping result: if the text
   * below cannot be moved, the reflow refuses rather than returning a document it knows is broken.
   */
  readonly pushFollowing?: boolean;
}

export interface ReflowResult {
  readonly stream: string;
  /** The lines the new text was broken into. */
  readonly lines: readonly string[];
  /** How wide each of those lines is, in points, measured the same way the break was. */
  readonly advances: readonly number[];
  readonly column: Column;
  /** False when the break was made with the one-em fallback rather than the font's own widths. */
  readonly breakExact: boolean;
  /** Lines the block had before the reflow, so a caller can tell whether the paragraph grew or shrank. */
  readonly replacedLines: number;
  /** Runs further down the page that were moved to make room, and zero when nothing needed to move. */
  readonly pushedRuns: number;
  /** How far those runs moved, in points, downwards. Zero when the paragraph had room to grow into. */
  readonly pushedBy: number;
  /**
   * Space left between the reflowed paragraph and the line under it, measured in lines: the gap minus one leading.
   *
   * Zero means the next line sits exactly one leading below the paragraph's last baseline, which is normal. Negative
   * means the reflowed block needs that many points it does not have, which is the amount `pushedBy` moves the text below
   * by, or the overlap that is left when `pushFollowing` is false. Null when nothing sits below.
   */
  readonly clearance: number | null;
}

/** Runs grouped into lines by baseline, in stream order, which is the order a paragraph reads in. */
export function linesOf(runs: readonly PositionedRun[]): PositionedRun[][] {
  const lines: PositionedRun[][] = [];
  for (const run of runs) {
    const line = lines.at(-1);
    if (line !== undefined && Math.abs(line[0]!.y - run.y) <= 0.01) line.push(run);
    else lines.push([run]);
  }
  return lines;
}

/** The column a paragraph sits in: the left edge its lines share, and the width of the widest line. */
export function inferColumn(lines: readonly (readonly PositionedRun[])[]): Column {
  if (lines.length === 0) throw new ReflowError("no lines, so there is no column to infer");
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    if (line.length === 0) continue;
    const first = line[0]!;
    const last = line.at(-1)!;
    left = Math.min(left, first.x);
    right = Math.max(right, last.x + last.advance);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) {
    throw new ReflowError(`the lines do not state a usable column (left ${left}, right ${right})`);
  }
  return { left, right };
}

/**
 * Breaks text into lines that fit a width, measuring every word with the font.
 *
 * Greedy, because that is what the file's own line ends imply. A word wider than the whole column goes on a line of its
 * own and overflows: splitting it would need a hyphen, and a hyphen the font does not contain is a missing glyph, which
 * is the failure this project exists to avoid.
 */
export function breakIntoLines(
  text: string,
  measure: (candidate: string) => number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0] as string;

  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

/**
 * Replaces one paragraph's text, re-broken into its own column, and returns the new stream.
 *
 * `startRunIndex` is any run in the paragraph's first line; `lineCount` says how many of the following lines belong to
 * the paragraph. Everything outside those lines is left byte-identical, because the replacement is a single splice from
 * the first line's positioning operands to the last line's show operator.
 */
export function reflowParagraph(
  stream: string,
  startRunIndex: number,
  newText: string,
  options: ReflowOptions = {},
): ReflowResult {
  const lineCount = options.lineCount ?? 1;
  if (lineCount < 1) throw new ReflowError(`a paragraph is at least one line, not ${lineCount}`);

  const tokens = tokenize(stream);
  const runs = positionedRuns(tokens, options.fonts);
  const target = runs[startRunIndex];
  if (target === undefined) throw new ReflowError(`no run at index ${startRunIndex}; the page has ${runs.length}`);

  const groups = linesOf(runs);
  const firstLine = groups.findIndex((line) => line.includes(target));
  const block = groups.slice(firstLine, firstLine + lineCount);
  if (block.length < lineCount) {
    throw new ReflowError(`the paragraph runs past the last line: ${block.length} of ${lineCount} lines exist`);
  }
  const blockRuns = block.flat();

  const font = target.font;
  const fontSize = target.fontSize;
  if (fontSize <= 0) throw new ReflowError(`run ${startRunIndex} has no font size, so no width can be measured`);
  for (const run of blockRuns) {
    if (run.font !== font) {
      throw new ReflowError(
        `the paragraph mixes fonts (${font} and ${run.font}), so reflow would have to choose one for the new text`,
      );
    }
    if (Math.abs(run.fontSize - fontSize) > 1e-9) {
      throw new ReflowError(`the paragraph mixes sizes (${fontSize} and ${run.fontSize})`);
    }
  }

  const column = inferColumn(block);
  const blockBottom = block.at(-1)![0]!.y;
  const widths = target.widths;
  const measure = (candidate: string): number =>
    widths === undefined ? candidate.length * fontSize : widths.advance(candidate, fontSize);

  const lines = breakIntoLines(newText, measure, column.right - column.left);
  const advances = lines.map((line) => measure(line));

  const leading = leadingOf(block, options.leading);
  const lowest = target.y - (lines.length - 1) * leading;
  const clearance = clearanceBelow(groups, block, lowest, leading);
  // Only the shortfall moves, not the whole growth: a paragraph that grows into slack it already had disturbs nothing.
  const shortfall = clearance === null ? 0 : Math.max(0, -clearance);
  const pushing = (options.pushFollowing ?? true) && shortfall > 0;
  const pushedBy = pushing ? shortfall : 0;
  const start = positioningStart(tokens, blockRuns[0]!);
  const end = showEnd(tokens, blockRuns.at(-1)!);
  // The block's replacement ends by restoring the text line matrix to where the block left it. Without that, a
  // following `Td 0 -14` inside the same text object would be measured from the new last line instead of the old one, and
  // every relative move after a reflow would silently land a line or two off. Absolute `Tm` for each new line plus one
  // restore keeps the operators after the block meaning exactly what they meant before.
  const lastLine = block.at(-1)!;
  const restore = `1 0 0 1 ${formatCoordinate(lastLine[0]!.x)} ${formatCoordinate(lastLine[0]!.y)} Tm`;
  const replacement = [
    ...lines.map(
      (line, index) =>
        `1 0 0 1 ${formatCoordinate(column.left)} ${formatCoordinate(target.y - index * leading)} Tm ` +
        `(${escapePdfText(line)}) Tj`,
    ),
    restore,
  ].join("\n");

  // Everything below the paragraph moves by however much is needed to keep one leading between them. Only absolute `Tm`
  // positions are adjustable, so a file that places its later text with relative moves gets a refusal rather than a
  // half-moved page.
  const edits: TextEdit[] = [{ start, end, replacement }];
  let pushedRuns = 0;
  if (pushing) {
    for (const run of runs) {
      if (run.y >= blockBottom - 0.01) continue;
      try {
        edits.push(moveRunDown(tokens, run, run.y - pushedBy));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ReflowError(
          `the text below this paragraph cannot be moved, so the reflow would overlap it: ${reason}. Pass ` +
            "`pushFollowing: false` to accept the overlap, or reflow a paragraph whose followers are placed absolutely.",
        );
      }
      pushedRuns += 1;
    }
  }

  return {
    stream: applyEdits(stream, edits),
    lines,
    advances,
    column,
    breakExact: widths !== undefined && lines.every((line) => widths.measuresExactly(line)),
    replacedLines: block.length,
    clearance,
    pushedRuns,
    pushedBy,
  };
}

/**
 * How much room is left between the reflowed block and the first line under it.
 *
 * The next line is the highest baseline below the block's own last one, which is where a page of text resumes reading.
 */
function clearanceBelow(
  groups: readonly (readonly PositionedRun[])[],
  block: readonly (readonly PositionedRun[])[],
  lowest: number,
  leading: number,
): number | null {
  const blockBottom = block.at(-1)![0]!.y;
  let next: number | null = null;
  for (const line of groups) {
    const y = line[0]!.y;
    if (y >= blockBottom - 0.01) continue;
    next = next === null ? y : Math.max(next, y);
  }
  if (next === null) return null;
  // how much less room than one full line is left between the reflowed paragraph and the line under it
  return lowest - next - leading;
}

/** The distance between baselines, taken from the block itself when it has more than one line. */
function leadingOf(block: readonly (readonly PositionedRun[])[], declared: number | undefined): number {
  if (block.length > 1) {
    const leading = block[0]![0]!.y - block[1]![0]!.y;
    if (leading > 0) return leading;
    throw new ReflowError(`the paragraph's lines are not in reading order (${leading} points apart)`);
  }
  if (declared !== undefined) {
    if (declared <= 0) throw new ReflowError(`leading must be positive, not ${declared}`);
    return declared;
  }
  throw new ReflowError(
    "a one-line paragraph states no leading, so a reflow that adds a line would have to invent the baseline: pass " +
      "`leading`, or reflow a paragraph of two or more lines",
  );
}
