import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
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
