import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PdfDocument, PdfError, documentText } from "../src/pdf.js";
import { buildPdf } from "./helpers/build-pdf.js";

const fixture = readFileSync("tests/fixtures/article.pdf");
const bytes = new Uint8Array(fixture);

describe("opening a real PDF", () => {
  it("reads the pages, the page tree and the decoded content stream of a file written by a real library", async () => {
    const document = await PdfDocument.open(bytes);
    const pages = await document.readPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.content).toContain("Tj");
    expect(documentText(pages)).toBe(
      [
        "Browser PDF editing",
        "The quick brown fox jumps over the lazy dog.",
        "Nothing open sits in the middle of reading and creating.",
        "Reflow is the feature every reader eventually asks for.",
      ].join("\n"),
    );
  });

  it("finds the object number of the page's content stream, which is what an edit replaces", async () => {
    const document = await PdfDocument.open(bytes);
    const [page] = await document.readPages();
    expect(document.contentObjectNumber(page!)).toBeGreaterThan(1);
  });

  it("refuses a file that is not a PDF, by name", async () => {
    await expect(PdfDocument.open(new TextEncoder().encode("not a pdf at all"))).rejects.toThrow(/does not start with %PDF-/);
  });

  it("refuses a cross-reference stream rather than pretending its objects are missing", async () => {
    const streamPdf = buildPdf({ objects: ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"] });
    const text = new TextDecoder("latin1").decode(streamPdf);
    const patched = text.replace(/startxref\n\d+/, `startxref\n${text.indexOf("1 0 obj")}`);
    const patchedBytes = new Uint8Array(patched.length);
    for (let i = 0; i < patched.length; i += 1) patchedBytes[i] = patched.charCodeAt(i) & 0xff;
    await expect(PdfDocument.open(patchedBytes)).rejects.toThrow(/cross-reference streams are not supported/);
  });

  it("refuses an encrypted document, because an edit would write plaintext into ciphertext", async () => {
    const encrypted = buildPdf({
      objects: ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"],
      trailerExtra: "/Encrypt << /Filter /Standard >>",
    });
    await expect(PdfDocument.open(encrypted)).rejects.toThrow(/encrypted PDFs are not supported/);
  });

  it("refuses a filter it cannot decode, naming the filter", async () => {
    const jpeg = buildPdf({
      objects: [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        `<< /Length 4 /Filter /DCTDecode >>\nstream\nJFIF\nendstream`,
      ],
    });
    const document = await PdfDocument.open(jpeg);
    const pages = await document.readPages().catch((error: unknown) => error);
    expect(pages).toBeInstanceOf(PdfError);
    expect((pages as PdfError).message).toContain("unsupported stream filter DCTDecode");
  });

  it("refuses a cross-reference entry that points at the wrong object", async () => {
    const pdf = buildPdf({ objects: ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"] });
    const text = new TextDecoder("latin1").decode(pdf);
    // rewrite object 2's xref offset to point at object 1
    const objectOne = text.indexOf("1 0 obj");
    const patched = text.replace(/(\d{10}) 00000 n \n(\d{10}) 00000 n /, (_match: string, first: string) =>
      `${first} 00000 n \n${String(objectOne).padStart(10, "0")} 00000 n `,
    );
    const patchedBytes = new Uint8Array(patched.length);
    for (let i = 0; i < patched.length; i += 1) patchedBytes[i] = patched.charCodeAt(i) & 0xff;
    const document = await PdfDocument.open(patchedBytes);
    expect(() => document.getObject(2)).toThrow(/holds another object/);
  });
});
