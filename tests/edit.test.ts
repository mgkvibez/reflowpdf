import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
import { advanceOf, editLine, escapePdfText, moveRunTo, replaceRunText, saveEditedContent } from "../src/edit.js";
import { PdfDocument, documentText } from "../src/pdf.js";
import { positionedRuns } from "../src/text-layout.js";

const runs = (stream: string) => positionedRuns(tokenize(stream));
const fixture = new Uint8Array(readFileSync("tests/fixtures/article.pdf"));

describe("rewriting a run", () => {
  it("replaces a Tj operand and leaves the surrounding operators alone", () => {
    const stream = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj ET";
    const [run] = runs(stream);
    expect(replaceRunText(stream, run!, "Goodbye")).toBe("BT /F1 12 Tf 1 0 0 1 72 700 Tm (Goodbye) Tj ET");
  });

  it("escapes the three characters that would corrupt the string", () => {
    expect(escapePdfText("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
    const stream = "BT /F1 12 Tf 1 0 0 1 72 700 Tm (x) Tj ET";
    const [run] = runs(stream);
    const edited = replaceRunText(stream, run!, "50% (net)");
    expect(edited).toContain("(50% \\(net\\)) Tj");
    expect(runs(edited)[0]!.text).toBe("50% (net)");
  });

  it("collapses a TJ array, because its kerning numbers describe the old glyphs", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 100 700 Tm [(Hel) -120 (lo)] TJ ET";
    const [run] = runs(stream);
    const edited = replaceRunText(stream, run!, "Hello there");
    expect(edited).toContain("[(Hello there)] TJ");
    expect(edited).not.toContain("-120");
  });

  it("keeps the quote operator's newline behaviour instead of silently turning it into Tj", () => {
    const stream = "BT /F1 10 Tf 14 TL 1 0 0 1 40 700 Tm (one) ' ET";
    const [run] = runs(stream);
    expect(replaceRunText(stream, run!, "two")).toContain("(two) '");
  });

  it("refuses the double-quote operator by name, because its spacing operands would be lost", () => {
    const stream = 'BT /F1 10 Tf 14 TL 1 0 0 1 40 700 Tm 1 2 (one) " ET';
    const [run] = runs(stream);
    expect(() => replaceRunText(stream, run!, "two")).toThrow(/carries word and character spacing/);
  });
});

describe("moving a run", () => {
  it("rewrites the x operand of an absolute Tm", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 72 700 Tm (a) Tj ET";
    const [run] = runs(stream);
    const moved = moveRunTo(stream, run!, 120);
    expect(moved).toContain("1 0 0 1 120 700 Tm");
    expect(runs(moved)[0]!.x).toBe(120);
  });

  it("adds the delta to a relative Td rather than replacing the running total", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 10 700 Tm (a) Tj 10 0 Td (b) Tj ET";
    const [, second] = runs(stream);
    const moved = moveRunTo(stream, second!, 60);
    expect(moved).toContain("50 0 Td");
    expect(runs(moved)[1]!.x).toBe(60);
  });

  it("refuses a run positioned by T*, which takes no x operand at all", () => {
    const stream = "BT /F1 10 Tf 14 TL 1 0 0 1 40 700 Tm (a) Tj T* (b) Tj ET";
    const [, second] = runs(stream);
    expect(() => moveRunTo(stream, second!, 100)).toThrow(/T\*.*cannot be moved/);
  });
});

describe("editing a line", () => {
  it("pushes the rest of the line along by the change in advance", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 50 700 Tm (one) Tj 30 0 Td (two) Tj ET";
    const before = runs(stream);
    const result = editLine(stream, 0, "one two three");
    expect(result.delta).toBe("one two three".length * 10 - "one".length * 10);
    expect(result.shifted).toBe(1);
    const after = runs(result.stream);
    expect(after.map((run) => run.text)).toEqual(["one two three", "two"]);
    expect(after[1]!.x).toBeCloseTo((before[1] as { x: number }).x + result.delta, 5);
  });

  it("leaves runs on other lines exactly where they were", () => {
    const stream = "BT /F1 10 Tf 1 0 0 1 50 700 Tm (top) Tj 0 -14 Td (bottom) Tj ET";
    const result = editLine(stream, 0, "a much longer top line");
    expect(result.shifted).toBe(0);
    const after = runs(result.stream);
    expect(after[1]).toMatchObject({ text: "bottom", x: 50, y: 686 });
  });

  it("refuses a run index that does not exist instead of editing the last run", () => {
    expect(() => editLine("BT /F1 10 Tf 1 0 0 1 0 0 Tm (a) Tj ET", 3, "b")).toThrow(/no run at index 3/);
  });

  it("measures advance from the font size, so a zero-size run is a refusal rather than a silent no-op", () => {
    const stream = "BT 1 0 0 1 0 0 Tm (a) Tj ET";
    const [run] = runs(stream);
    expect(advanceOf(run!)).toBe(0);
    expect(() => editLine(stream, 0, "b")).toThrow(/has no font size/);
  });
});

describe("round trip against a real PDF", () => {
  it("opens a file, retypes a line, saves an incremental update, and reads the change back", async () => {
    const original = fixture;
    const document = await PdfDocument.open(original);
    const [page] = await document.readPages();
    const runsOnPage = positionedRuns(tokenize(page!.content));
    const index = runsOnPage.findIndex((run) => run.text.startsWith("The quick brown fox"));
    expect(index).toBeGreaterThanOrEqual(0);

    const edited = editLine(page!.content, index, "The extremely quick brown fox jumps over the lazy dog.");
    const saved = saveEditedContent(document, page!, edited.stream);

    // an incremental update copies the original bytes verbatim and appends; nothing earlier may change
    expect(saved.slice(0, original.length)).toEqual(original);
    expect(original.length).toBe(fixture.length);

    const reopened = await PdfDocument.open(saved);
    const pages = await reopened.readPages();
    expect(pages).toHaveLength(1);
    expect(documentText(pages)).toBe(
      [
        "Browser PDF editing",
        "The extremely quick brown fox jumps over the lazy dog.",
        "Nothing open sits in the middle of reading and creating.",
        "Reflow is the feature every reader eventually asks for.",
      ].join("\n"),
    );
    // the old sentence is gone, not merely covered: the content stream was replaced, not appended to
    expect(pages[0]!.content).not.toContain("(The quick brown fox");
  });

  it("keeps editing the edited file, which is what following the /Prev chain buys", async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const first = saveEditedContent(document, page!, editLine(page!.content, 1, "First edit.").stream);

    const second = await PdfDocument.open(first);
    const [pageTwo] = await second.readPages();
    const secondEdit = saveEditedContent(second, pageTwo!, editLine(pageTwo!.content, 2, "Second edit.").stream);

    const third = await PdfDocument.open(secondEdit);
    const text = documentText(await third.readPages());
    expect(text.split("\n")).toEqual(["Browser PDF editing", "First edit.", "Second edit.", "Reflow is the feature every reader eventually asks for."]);
    expect(secondEdit.slice(0, first.length)).toEqual(first);
  });

  it("refuses to save a page whose content is a stream array, rather than replacing only the first part", async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const doctored = { ...page!, dict: new Map(page!.dict).set("Contents", [page!.dict.get("Contents") as never]) };
    expect(() => saveEditedContent(document, doctored, "x")).toThrow(/not a single indirect object/);
  });
});
