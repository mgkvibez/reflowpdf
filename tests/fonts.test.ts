import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
import { FontError, FontWidths, pageFonts, readWidths } from "../src/fonts.js";
import { PdfDocument } from "../src/pdf.js";
import { positionedRuns } from "../src/text-layout.js";
import { buildPdf } from "./helpers/build-pdf.js";

/** A page whose /Resources /Font holds one font with the given dictionary body. */
const documentWith = (fontDict: string, extraObjects: readonly string[] = []) =>
  PdfDocument.open(
    buildPdf({
      objects: [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
        fontDict,
        "<< /Length 8 >>\nstream\nBT ET\nQ\nendstream",
        ...extraObjects,
      ],
    }),
  );

describe("font widths", () => {
  it("indexes /Widths from /FirstChar, which is what a character code means", () => {
    const widths = new FontWidths("F1", "Type1", 32, [278, 355, 556], 0);
    expect(widths.widthOf(32)).toEqual({ thousandths: 278, exact: true });
    expect(widths.widthOf(34)).toEqual({ thousandths: 556, exact: true });
    expect(widths.lastChar).toBe(34);
  });

  it("falls back to /MissingWidth for a code the table does not cover, and says the number was defaulted", () => {
    const widths = new FontWidths("F1", "Type1", 32, [278], 250);
    expect(widths.widthOf(90)).toEqual({ thousandths: 250, exact: false });
    expect(widths.measuresExactly(" ")).toBe(true);
    expect(widths.measuresExactly(" Z")).toBe(false);
  });

  it("turns thousandths of an em into points at the size the run declares", () => {
    const widths = new FontWidths("F1", "Type1", 32, [500, 250, 1000], 0);
    // 32 = 500, 33 = 250, 34 = 1000 -> 1750 thousandths at 12pt
    expect(widths.advance(" !\"", 12)).toBeCloseTo(21, 10);
  });

  it("reads /Widths, /FirstChar and /LastChar out of a font dictionary", async () => {
    const document = await documentWith(
      "<< /Type /Font /Subtype /TrueType /BaseFont /Body /FirstChar 65 /LastChar 67 /Widths [600 700 800] >>",
    );
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    expect([...fonts.unresolved]).toEqual([]);
    const width = fonts.widths.get("F1")!;
    expect(width.subtype).toBe("TrueType");
    expect(width.widthOf(66)!.thousandths).toBe(700);
  });

  it("reads /MissingWidth from the font descriptor", async () => {
    const document = await documentWith(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Body /FirstChar 65 /LastChar 65 /Widths [600] " +
        "/FontDescriptor << /Type /FontDescriptor /MissingWidth 321 >> >>",
    );
    const [page] = await document.readPages();
    const width = pageFonts(document, page!).widths.get("F1")!;
    expect(width.widthOf(66)).toEqual({ thousandths: 321, exact: false });
  });

  it("refuses a font with no /Widths, because a base-14 font keeps its metrics in a file that is not here", async () => {
    const document = await documentWith("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    expect(fonts.widths.size).toBe(0);
    expect(fonts.unresolved.get("F1")).toMatch(/no \/Widths/);
  });

  it("refuses a Type0 font by name instead of indexing /W as if it were /Widths", async () => {
    const document = await documentWith(
      "<< /Type /Font /Subtype /Type0 /BaseFont /Body /Encoding /Identity-H /DescendantFonts [] >>",
    );
    const [page] = await document.readPages();
    expect(pageFonts(document, page!).unresolved.get("F1")).toMatch(/Type0.*glyph indices/);
  });

  it("refuses a Type3 font, whose widths are in glyph space rather than points", async () => {
    const document = await documentWith(
      "<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << >> /Encoding << >> " +
        "/FirstChar 0 /LastChar 0 /Widths [500] >>",
    );
    const [page] = await document.readPages();
    expect(pageFonts(document, page!).unresolved.get("F1")).toMatch(/Type3.*FontMatrix/);
  });

  it("refuses a /Widths table that disagrees with the /LastChar it declares", async () => {
    const document = await documentWith(
      "<</Type /Font /Subtype /Type1 /BaseFont /Body /FirstChar 65 /LastChar 70 /Widths [600 700]>>",
    );
    const [page] = await document.readPages();
    expect(pageFonts(document, page!).unresolved.get("F1")).toMatch(/disagree/);
  });

  it("throws FontError from readWidths, so a caller reading one font gets the reason rather than a map", async () => {
    const document = await documentWith("<< /Type /Font /Subtype /Type1 /BaseFont /Body >>");
    const dict = document.dictionary(
      document.dictionary(document.dictionary([...(await document.readPages())][0]!.dict.get("Resources")!).get("Font")!)
        .get("F1")!,
    );
    expect(() => readWidths(document, "F1", dict)).toThrow(FontError);
  });

  it("finds fonts inherited from a /Pages node, which is where real writers often put them", async () => {
    const bytes = buildPdf({
      objects: [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>",
        "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /TrueType /BaseFont /Body /FirstChar 65 /LastChar 65 /Widths [600] >>",
        "<< /Length 8 >>\nstream\nBT ET\nQ\nendstream",
      ],
    });
    const document = await PdfDocument.open(bytes);
    const [page] = await document.readPages();
    expect(page!.dict.has("Resources")).toBe(true);
    expect(pageFonts(document, page!).widths.get("F1")!.widthOf(65)!.thousandths).toBe(600);
  });
});

describe("widths on a real embedded font", () => {
  // article-ttf.pdf is written by tools/make-fixture.py with DejaVu Sans embedded, so the file carries a real /Widths
  // table. The expected advances below were computed by ReportLab, which reads the TrueType hmtx table itself and shares
  // no code with this reader: it is the independent answer, not ours echoed back.
  const fixture = new Uint8Array(readFileSync("tests/fixtures/article-ttf.pdf"));

  it("measures a line in an embedded TrueType font to the number an independent tool computes", async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    const width = fonts.widths.get("F2+0")!;
    expect(width.subtype).toBe("TrueType");
    // ReportLab stringWidth("Widths, not guesses", DejaVuSans, 12) = 121.21875
    expect(width.advance("Widths, not guesses", 12)).toBeCloseTo(121.21875, 5);
  });

  it("agrees with ReportLab on a shorter string to within the precision ReportLab wrote into /Widths", async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const width = pageFonts(document, page!).widths.get("F2+0")!;
    // ReportLab stringWidth("left run", DejaVuSans, 11) = 39.9716796875; the /Widths table it wrote is rounded a little
    // finer than that, so the two agree to under a millionth of a point and not to the last bit.
    expect(Math.abs(width.advance("left run", 11) - 39.9716796875)).toBeLessThan(1e-6);
    expect(width.measuresExactly("left run")).toBe(true);
  });

  it("reads every run on the page with a measured advance", async () => {
    const document = await PdfDocument.open(fixture);
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    const runs = positionedRunsWithFonts(page!.content, fonts.widths);
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(run.advanceExact).toBe(true);
    expect(runs[3]!.text).toBe("right run");
  });

  it("falls back and admits it on a file whose base-14 fonts carry no /Widths", async () => {
    const document = await PdfDocument.open(new Uint8Array(readFileSync("tests/fixtures/article.pdf")));
    const [page] = await document.readPages();
    const fonts = pageFonts(document, page!);
    expect(fonts.widths.size).toBe(0);
    expect(fonts.unresolved.size).toBeGreaterThan(0);
    const runs = positionedRunsWithFonts(page!.content, fonts.widths);
    for (const run of runs) expect(run.advanceExact).toBe(false);
  });
});

const positionedRunsWithFonts = (content: string, widths: ReadonlyMap<string, FontWidths>) =>
  positionedRuns(tokenize(content), widths);
