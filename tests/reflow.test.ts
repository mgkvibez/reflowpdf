import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
import { saveEditedContent } from "../src/edit.js";
import { FontWidths, pageFonts } from "../src/fonts.js";
import { PdfDocument } from "../src/pdf.js";
import { ReflowError, breakIntoLines, inferColumn, linesOf, reflowParagraph } from "../src/reflow.js";
import { positionedRuns } from "../src/text-layout.js";

// every printable code is half an em wide, so a measured break and a one-em break disagree about what fits
const halfEm = new Map([["F1", new FontWidths("F1", "Type1", 32, Array.from({ length: 95 }, () => 400), 0)]]);
const runsOf = (stream: string, fonts?: ReadonlyMap<string, FontWidths>) =>
  positionedRuns(tokenize(stream), fonts);

describe("grouping runs into lines", () => {
  it("puts runs on the same baseline together and keeps stream order", () => {
    const runs = runsOf("BT /F1 10 Tf 1 0 0 1 10 700 Tm (a) Tj 40 0 Td (b) Tj 0 -14 Td (c) Tj ET");
    expect(linesOf(runs).map((line) => line.map((run) => run.text))).toEqual([["a", "b"], ["c"]]);
  });

  it("treats a hundredth of a point of baseline drift as the same line, which is what the shift tolerance uses", () => {
    const runs = runsOf("BT /F1 10 Tf 1 0 0 1 10 700 Tm (a) Tj 1 0.005 Td (b) Tj ET");
    expect(linesOf(runs)).toHaveLength(1);
  });
});

describe("inferring the column", () => {
  it("takes the shared left edge and the widest line's right edge", () => {
    const runs = runsOf("BT /F1 10 Tf 1 0 0 1 72 700 Tm (ab) Tj 0 -14 Td (abcd) Tj ET", halfEm);
    // 400 thousandths of an em at 10pt = 4 points per glyph, so the longer line ends at 72 + 16
    expect(inferColumn(linesOf(runs))).toEqual({ left: 72, right: 88 });
  });

  it("refuses lines that state no usable width rather than inventing one", () => {
    const runs = runsOf("BT /F1 0 Tf 1 0 0 1 72 700 Tm () Tj ET", halfEm);
    expect(() => inferColumn(linesOf(runs))).toThrow(ReflowError);
  });
});

describe("breaking text into a column", () => {
  const measure = (text: string) => text.length * 4;

  it("fills each line and starts a new one rather than splitting a word", () => {
    expect(breakIntoLines("aa aa aa aa", measure, 20)).toEqual(["aa aa", "aa aa"]);
  });

  it("lets a word wider than the column overflow on its own line instead of hyphenating it", () => {
    // a hyphen the font does not contain would be a missing glyph, which is the failure this project exists to avoid
    expect(breakIntoLines("aa aaaaaaaa aa", measure, 20)).toEqual(["aa", "aaaaaaaa", "aa"]);
  });

  it("collapses runs of whitespace, and returns nothing for nothing", () => {
    expect(breakIntoLines("  aa   aa  ", measure, 20)).toEqual(["aa aa"]);
    expect(breakIntoLines("   ", measure, 20)).toEqual([]);
  });
});

describe("reflowing a paragraph", () => {
  const twoLines = "BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaaa) Tj 0 -14 Td (aaaaa) Tj ET";

  it("rewrites the block at the inferred left edge with the paragraph's own leading", () => {
    const result = reflowParagraph(twoLines, 0, "aa aa aa aa aa", { fonts: halfEm, lineCount: 2 });
    expect(result.column).toEqual({ left: 100, right: 120 });
    expect(result.lines).toEqual(["aa aa", "aa aa", "aa"]);
    expect(result.replacedLines).toBe(2);
    const after = runsOf(result.stream, halfEm);
    expect(after.map((run) => [run.text, run.x, run.y])).toEqual([
      ["aa aa", 100, 700],
      ["aa aa", 100, 686],
      ["aa", 100, 672],
    ]);
  });

  it("flags a break made with the one-em fallback instead of pretending it measured anything", () => {
    const measured = reflowParagraph(twoLines, 0, "aa aa aa aa", { fonts: halfEm, lineCount: 2 });
    const guessed = reflowParagraph(twoLines, 0, "aa aa aa aa", { lineCount: 2 });
    expect(measured.breakExact).toBe(true);
    expect(guessed.breakExact).toBe(false);
    // the fallback measures the column with the same wrong model as the text, so it does not even notice it is wrong:
    // both breaks fit their own column, and only the real file below shows how far apart the answers are
    for (const result of [measured, guessed]) {
      const width = result.column.right - result.column.left;
      for (const advance of result.advances) expect(advance).toBeLessThanOrEqual(width + 1e-9);
    }
  });

  it("leaves every byte outside the block untouched", () => {
    const prefix = "q 0 0 1 RG ";
    const suffix = " Q";
    const stream = `BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaaa) Tj 0 -14 Td (aaaaa) Tj ET`;
    const wrapped = `${prefix}BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaaa) Tj 0 -14 Td (aaaaa) Tj ET${suffix}`;
    const result = reflowParagraph(wrapped, 0, "aa aa", { fonts: halfEm, lineCount: 2 });
    expect(result.stream.startsWith(prefix)).toBe(true);
    expect(result.stream.endsWith(suffix)).toBe(true);
    // the text matrix that opened the block was inside the replaced span, so the new block brings its own
    expect(result.stream).toContain("1 0 0 1 100 700 Tm (aa aa) Tj");
    expect(stream.length).toBeGreaterThan(0);
  });

  it("escapes parentheses in the new text rather than emitting a broken string", () => {
    const result = reflowParagraph(twoLines, 0, "aa (aa)", { fonts: halfEm, lineCount: 2 });
    // seven glyphs at 4 points do not fit a 20 point column, so the parenthesised word is its own line
    expect(result.lines).toEqual(["aa", "(aa)"]);
    expect(result.stream).toContain("(\\(aa\\)) Tj");
    expect(runsOf(result.stream, halfEm).map((run) => run.text)).toEqual(["aa", "(aa)"]);
  });

  it("refuses a paragraph that mixes fonts, because reflow would have to pick one", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaa) Tj /F2 10 Tf (aaaa) Tj ET";
    expect(() => reflowParagraph(stream, 0, "aa", { fonts: halfEm, lineCount: 1 })).toThrow(/mixes fonts/);
  });

  it("refuses a one-line paragraph with no leading, since a new line needs a baseline", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaaa) Tj ET";
    expect(() => reflowParagraph(stream, 0, "aa aa aa", { fonts: halfEm })).toThrow(/states no leading/);
    const withLeading = reflowParagraph(stream, 0, "aa aa aa", { fonts: halfEm, leading: 12 });
    expect(withLeading.lines).toEqual(["aa aa", "aa"]);
    expect(withLeading.clearance).toBeNull();
  });

  it("refuses a paragraph longer than the lines below it exist", () => {
    expect(() => reflowParagraph(twoLines, 0, "aa", { fonts: halfEm, lineCount: 5 })).toThrow(/runs past the last line/);
  });

  it("refuses a run index that is not there, and a paragraph of no lines", () => {
    expect(() => reflowParagraph(twoLines, 9, "aa", { fonts: halfEm })).toThrow(/no run at index 9/);
    expect(() => reflowParagraph(twoLines, 0, "aa", { fonts: halfEm, lineCount: 0 })).toThrow(/at least one line/);
  });

  it("reports how much room is left under the paragraph, so a caller knows it grew into its neighbour", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 100 700 Tm (aaaaa) Tj 0 -14 Td (aaaaa) Tj 0 -14 Td (aaaaa) Tj ET";
    // one line of text, one leading of room under it, so growing by a line leaves exactly no slack
    const grown = reflowParagraph(stream, 0, "aa aa", { fonts: halfEm, lineCount: 1, leading: 14 });
    expect(grown.clearance).toBe(0);
    const tooBig = reflowParagraph(stream, 0, "aa aa aa aa aa aa", { fonts: halfEm, lineCount: 1, leading: 14 });
    expect(tooBig.lines).toHaveLength(3);
    expect(tooBig.clearance).toBe(-28);
  });
});

describe("reflow against a real PDF", () => {
  const fixture = new Uint8Array(readFileSync("tests/fixtures/article-ttf.pdf"));

  const open = async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    const runs = positionedRuns(tokenize(page!.content), fonts.widths);
    return { document, page: page!, fonts, runs };
  };

  it("re-breaks a real paragraph inside the column its own lines state", async () => {
    const { page, fonts, runs } = await open();
    const index = runs.findIndex((run) => run.text.startsWith("The rest of this line"));
    const column = inferColumn(linesOf(runs));
    expect(column.left).toBe(72);

    const newText =
      "The rest of this line has to stay in its column, and now it is long enough that it needs to break twice.";
    const result = reflowParagraph(page.content, index, newText, { fonts: fonts.widths, lineCount: 1, leading: 30 });
    expect(result.lines).toHaveLength(3);
    expect(result.breakExact).toBe(true);
    // every line fits the column it was measured against
    for (const advance of result.advances) expect(advance).toBeLessThanOrEqual(column.right - column.left + 1e-9);
    expect(result.lines.join(" ")).toBe(newText);
  });

  it("writes the reflow back out as an incremental update that a fresh read agrees with", async () => {
    const { document, page, fonts, runs } = await open();
    const index = runs.findIndex((run) => run.text.startsWith("The rest of this line"));
    const newText = "The rest of this line has to stay in its column, and it is long enough to break twice.";
    const result = reflowParagraph(page.content, index, newText, { fonts: fonts.widths, lineCount: 1, leading: 30 });
    const saved = saveEditedContent(document, page, result.stream);
    expect(saved.slice(0, fixture.length)).toEqual(fixture);

    const reopened = await PdfDocument.open(saved);
    const [reopenedPage] = await reopened.readPages();
    const after = positionedRuns(tokenize(reopenedPage!.content), pageFonts(reopened, reopenedPage!).widths);
    const produced = after.filter((run) => result.lines.includes(run.text));
    expect(produced.map((run) => run.text)).toEqual(result.lines);
    expect(produced.map((run) => run.x)).toEqual(result.lines.map(() => 72));
    expect(produced.map((run) => run.y)).toEqual(result.lines.map((_, index) => 730 - index * 30));
  });

  it("overflows the real column when the widths are missing, which is why the flag is not decoration", async () => {
    const { page, fonts, runs } = await open();
    const index = runs.findIndex((run) => run.text.startsWith("The rest of this line"));
    const text = "The rest of this line has to stay in its column, and it is long enough to break twice.";
    const measured = reflowParagraph(page.content, index, text, { fonts: fonts.widths, lineCount: 1, leading: 30 });
    const guessed = reflowParagraph(page.content, index, text, { lineCount: 1, leading: 30 });

    // the fallback wraps at the same character counts, because it measures the column the same wrong way, so the line
    // count agrees and the damage is horizontal: its lines run past the right edge the document actually states
    const realWidth = measured.column.right - measured.column.left;
    expect(guessed.lines).toEqual(measured.lines);
    for (const advance of measured.advances) expect(advance).toBeLessThanOrEqual(realWidth + 1e-9);
    expect(Math.max(...guessed.advances)).toBeGreaterThan(realWidth * 1.5);
  });

  it("says plainly when the reflowed paragraph runs into the text under it", async () => {
    const { page, fonts, runs } = await open();
    const index = runs.findIndex((run) => run.text.startsWith("The rest of this line"));
    const long =
      "The rest of this line has to stay in its column, and now it is long enough that it needs to break twice.";
    const result = reflowParagraph(page.content, index, long, {
      fonts: fonts.widths,
      lineCount: 1,
      leading: 30,
    });
    // the paragraph grew by two lines into a gap of one, so it overlaps the line below instead of hiding that
    expect(result.clearance).toBeLessThan(0);
    expect(result.clearance).toBe(-60);
  });
});
