/**
 * The whole path on a real file: read the article, reflow a paragraph, save, and read the saved bytes again.
 *
 * Two readers are used, and only one of them is this repository's. The first pass proves the save can be reopened and the
 * text is where the reflow put it. The second hands the same bytes to pypdf, a library that shares no code with this one,
 * and asks the questions a person would ask of the file: does it open, how many pages does it have, and does it still
 * contain the sentence that was written into it.
 *
 * The leading the reflow needs is measured from the file, from the distance between its own baselines, rather than passed
 * as a plausible number. A test that invented 14 would be agreeing with itself about the line spacing.
 *
 * It skips the pypdf passes when python and pypdf are not installed, because a cold checkout runs `npm test` with no
 * Python at all.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tokenize } from "../src/content-stream.js";
import { saveEditedContent } from "../src/edit.js";
import { pageFonts } from "../src/fonts.js";
import { PdfDocument, documentText } from "../src/pdf.js";
import { reflowParagraph } from "../src/reflow.js";
import { positionedRuns } from "../src/text-layout.js";

const FIXTURE = "tests/fixtures/article.pdf";
// deliberately unlike anything in the article: the fixture already says "The quick brown fox", so a replacement that
// began with those words would appear twice in the saved file and a count would prove nothing
const REPLACEMENT =
  "A reflowed paragraph keeps the compositor honest: every other line on the page stays exactly where it was, which is " +
  "the only claim this project makes.";

const fixture = new Uint8Array(readFileSync(FIXTURE));

function hasPypdf(): boolean {
  try {
    execFileSync("python3", ["-c", "import pypdf"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Ask pypdf what it sees, in one process, so the test reads one answer rather than several exits. */
function readWithPypdf(path: string): { pages: number; text: string } {
  const script = `
import json, sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
print(json.dumps({"pages": len(reader.pages), "text": reader.pages[0].extract_text()}))
`;
  const output = execFileSync("python3", ["-c", script, path], { encoding: "utf8" }) as string;
  return JSON.parse(output) as { pages: number; text: string };
}

let fileCounter = 0;

/** Write the bytes somewhere pypdf can see them, ask it, and clean up. */
function readWithPypdfBytes(bytes: Uint8Array, label: string): { pages: number; text: string } {
  const directory = mkdtempSync(join(tmpdir(), "reflowpdf-roundtrip-"));
  const path = join(directory, `${label}-${fileCounter++}.pdf`);
  try {
    writeFileSync(path, bytes);
    return readWithPypdf(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Article {
  document: PdfDocument;
  page: { content: string };
  widthMap: ReturnType<typeof pageFonts>["widths"];
  runsBefore: ReturnType<typeof positionedRuns>;
  /** The file's own line spacing, from the two highest distinct baselines it prints. */
  leading: number;
}

async function open(bytes: Uint8Array = fixture): Promise<Article> {
  const document = await PdfDocument.open(bytes);
  const [page] = await document.readPages();
  const fonts = pageFonts(document, page!);
  const runsBefore = positionedRuns(tokenize(page!.content), fonts.widths);
  const baselines = [...new Set(runsBefore.map((run) => run.y))].sort((left, right) => right - left);
  const leading = baselines.length > 1 ? baselines[0]! - baselines[1]! : 14;
  return { document, page: page!, widthMap: fonts.widths, runsBefore, leading };
}

/** Extracted text keeps the file's own line breaks and its own wrapping, so comparisons flatten whitespace first. */
const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

const reflow = (article: Article, text: string) =>
  reflowParagraph(article.page.content, 0, text, {
    fonts: article.widthMap,
    leading: article.leading,
    pushFollowing: true,
  });

describe("a reflowed paragraph, saved and read back", () => {
  it("reopens with the new text, and the lines below it moved down by as much as it grew", async () => {
    const article = await open();
    const result = reflow(article, REPLACEMENT);
    const saved = saveEditedContent(article.document, article.page as never, result.stream);

    const reopenedDocument = await PdfDocument.open(saved);
    const reopenedPages = await reopenedDocument.readPages();
    const reopenedPage = reopenedPages[0]!;
    expect(flatten(documentText(reopenedPages))).toContain("A reflowed paragraph keeps the compositor honest");

    const after = positionedRuns(tokenize(reopenedPage.content), pageFonts(reopenedDocument, reopenedPage).widths);
    expect(result.pushedRuns).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(article.runsBefore.length);

    // every line that was pushed kept its own left edge: a push is a translation, not a re-layout
    const lowestParagraphBaseline = Math.min(
      ...article.runsBefore
        .filter((run) => Math.abs(run.x - article.runsBefore[0]!.x) < 0.01)
        .map((run) => run.y),
    );
    const pushed = after.filter((run) => run.y < lowestParagraphBaseline - 0.01);
    expect(pushed.length).toBeGreaterThan(0);
    for (const run of pushed) {
      const origin = article.runsBefore.find((entry) => entry.text === run.text);
      if (origin) expect(run.x).toBeCloseTo(origin.x, 6);
    }
  });

  it("moves each pushed line by a whole number of leadings, not by an arbitrary amount", async () => {
    const article = await open();
    const result = reflow(article, REPLACEMENT);
    const saved = saveEditedContent(article.document, article.page as never, result.stream);
    const reopenedDocument = await PdfDocument.open(saved);
    const [reopenedPage] = await reopenedDocument.readPages();
    const after = positionedRuns(tokenize(reopenedPage!.content), pageFonts(reopenedDocument, reopenedPage!).widths);

    expect(result.pushedRuns).toBeGreaterThan(0);
    let checked = 0;
    for (const run of after) {
      const origin = article.runsBefore.find((entry) => entry.text === run.text);
      if (origin === undefined || run.y === origin.y) continue;
      const leadings = (origin.y - run.y) / article.leading;
      expect(Math.abs(leadings - Math.round(leadings))).toBeLessThan(1e-6);
      expect(Math.round(leadings)).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("opens in pypdf, keeps its page count, and carries the new sentence", async () => {
    if (!hasPypdf()) return;
    const article = await open();
    const original = readWithPypdfBytes(fixture, "original");
    const result = reflow(article, REPLACEMENT);
    const saved = saveEditedContent(article.document, article.page as never, result.stream);
    const reopened = readWithPypdfBytes(saved, "reflowed");

    expect(reopened.pages).toBe(original.pages);
    expect(flatten(reopened.text)).toContain("the only claim this project makes");
    // the sentence that was written is there, and it is not in the file as pypdf read it before the edit
    expect(flatten(original.text)).not.toContain("the only claim this project makes");
    expect(reopened.text.match(/The quick brown fox/g) ?? []).toHaveLength(1);
  });

  it("survives a second reflow of the saved file, which is what makes the save readable rather than merely valid", async () => {
    if (!hasPypdf()) return;
    const article = await open();
    const once = saveEditedContent(article.document, article.page as never, reflow(article, REPLACEMENT).stream);

    const again = await open(once);
    const twice = saveEditedContent(again.document, again.page as never, reflow(again, "Second pass.").stream);
    const reread = readWithPypdfBytes(twice, "twice");
    expect(flatten(reread.text)).toContain("Second pass.");
    // the rest of the paragraph the first pass wrote is still there, which is how this proves the second pass read the
    // saved file rather than the original fixture
    expect(flatten(reread.text)).toContain("the only claim this project makes");
    expect(reread.pages).toBe(1);
  });
});
