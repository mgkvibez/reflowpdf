import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
import { FontWidths } from "../src/fonts.js";
import { LayoutError, positionedRuns } from "../src/text-layout.js";

const runs = (stream: string) => positionedRuns(tokenize(stream));

describe("positioned text", () => {
  it("places a run at the text matrix origin", () => {
    const [run] = runs("BT /F1 12 Tf 1 0 0 1 72 720 Tm (Hello) Tj ET");
    expect(run).toMatchObject({ text: "Hello", x: 72, y: 720, font: "F1", fontSize: 12 });
  });

  it("moves the origin with Td and keeps the new line start", () => {
    const placed = runs("BT /F1 10 Tf 1 0 0 1 50 700 Tm (one) Tj 0 -14 Td (two) Tj ET");
    expect(placed.map((run) => [run.text, run.x, run.y])).toEqual([
      ["one", 50, 700],
      ["two", 50, 686],
    ]);
  });

  it("starts a new line at the leading on T* and honours TL", () => {
    const placed = runs("BT /F1 10 Tf 14 TL 1 0 0 1 30 500 Tm (a) Tj T* (b) Tj ET");
    expect(placed.map((run) => run.y)).toEqual([500, 486]);
  });

  it("lets TD set the leading as well as move the line", () => {
    const placed = runs("BT /F1 10 Tf 1 0 0 1 30 500 Tm (a) Tj 0 -20 TD (b) Tj T* (c) Tj ET");
    expect(placed.map((run) => run.y)).toEqual([500, 480, 460]);
  });

  it("treats a TJ array as one run and subtracts its kerning from the advance", () => {
    const [first, second] = runs("BT /F1 10 Tf 1 0 0 1 100 700 Tm [(Hel) -120 (lo)] TJ (there) Tj ET");
    expect(first!.text).toBe("Hello");
    // 5 glyphs at 10pt = 50, plus 120/1000 em of negative kerning moving the pen right by 1.2
    expect(first!.text).toBe("Hello");
    expect(second!.text).toBe("there");
    expect(second!.x).toBeCloseTo(100 + 50 + 1.2, 5);
  });

  it("records the operator offset so the run can be rewritten in place", () => {
    const stream = "BT /F1 12 Tf 1 0 0 1 10 20 Tm (x) Tj ET";
    const [run] = runs(stream);
    expect(stream.slice(run!.offset, run!.offset + 2)).toBe("Tj");
  });

  it("refuses a scaled or rotated text matrix instead of misplacing the text", () => {
    expect(() => runs("BT /F1 12 Tf 2 0 0 2 72 720 Tm (x) Tj ET")).toThrow(LayoutError);
  });

  it("ignores non-text operators and comments", () => {
    const placed = runs("q 0 0 1 RG % a comment\nBT /F1 9 Tf 1 0 0 1 5 5 Tm (only) Tj ET Q");
    expect(placed).toHaveLength(1);
    expect(placed[0]!.text).toBe("only");
  });
});

describe("advance measured from the font", () => {
  // /Widths from code 65 ('A'): A = 600, B = 400 thousandths, which is the shape of a simple font's table
  const widths = new Map([["F1", new FontWidths("F1", "Type1", 65, [600, 400], 0)]]);

  it("advances the pen by the declared widths instead of one em per glyph", () => {
    const [first, second] = positionedRuns(tokenize("BT /F1 10 Tf 1 0 0 1 100 700 Tm (AB) Tj (AB) Tj ET"), widths);
    // A 600 + B 400 = 1000 thousandths = exactly one em at 10pt, which the fallback would also have said
    expect(first!.advance).toBeCloseTo(10, 10);
    expect(first!.advanceExact).toBe(true);
    const [onlyA] = positionedRuns(tokenize("BT /F1 10 Tf 1 0 0 1 100 700 Tm (A) Tj ET"), widths);
    // ... and one glyph where they disagree: an em would say 10, the font says 6
    expect(onlyA!.advance).toBeCloseTo(6, 10);
    expect(second!.x).toBeCloseTo(110, 10);
  });

  it("subtracts kerning from a measured advance, so a TJ array still lands where the writer put it", () => {
    const [, second] = positionedRuns(
      tokenize("BT /F1 10 Tf 1 0 0 1 100 700 Tm [(AB) -50 (AB)] TJ (A) Tj ET"),
      widths,
    );
    // two measured ems = 20, and the spec says a TJ number is subtracted from the pen, so -50 at 10pt adds half a point
    expect(second!.x).toBeCloseTo(100 + 20 + 0.5, 10);
  });

  it("flags a run whose font is not in the supplied table rather than borrowing another font's widths", () => {
    const [run] = positionedRuns(tokenize("BT /F9 10 Tf 1 0 0 1 10 10 Tm (AB) Tj ET"), widths);
    expect(run!.advanceExact).toBe(false);
    expect(run!.advance).toBe(20);
    expect(run!.widths).toBeUndefined();
  });

  it("flags a code the table does not cover, because /MissingWidth is a declared default and not a measurement", () => {
    const [run] = positionedRuns(tokenize("BT /F1 10 Tf 1 0 0 1 10 10 Tm (AZ) Tj ET"), widths);
    expect(run!.advanceExact).toBe(false);
    expect(run!.advance).toBeCloseTo(6, 10);
  });

  it("keeps the one-em fallback when no fonts are supplied at all, which is what every earlier caller does", () => {
    const [run] = runs("BT /F1 10 Tf 1 0 0 1 10 10 Tm (AB) Tj ET");
    expect(run!.advance).toBe(20);
    expect(run!.advanceExact).toBe(false);
    expect(run!.widths).toBeUndefined();
  });
});
