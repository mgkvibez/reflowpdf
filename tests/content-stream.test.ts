import { describe, expect, it } from "vitest";

import { PdfSyntaxError, textShows, tokenize } from "../src/content-stream.js";

describe("PDF content stream lexer", () => {
  it("reads numbers, names and operators with offsets", () => {
    const tokens = tokenize("BT /F1 12 Tf 100 700 Td (Hello) Tj ET");
    expect(tokens.map((t) => t.kind)).toEqual([
      "operator", "name", "number", "operator", "number", "number", "operator", "string", "operator", "operator",
    ]);
    expect(tokens[1]).toMatchObject({ kind: "name", value: "F1", offset: 3 });
  });

  it("keeps raw text so a token can be written back where it came from", () => {
    const source = " 12 Tf ";
    const number = tokenize(source)[0];
    expect(number?.raw).toBe("12");
    expect(source.slice(number!.offset, number!.offset + number!.raw.length)).toBe("12");
  });

  it("handles escaped and nested parentheses in strings", () => {
    const [token] = tokenize("(a \\(b\\) c) Tj");
    expect(token).toMatchObject({ kind: "string", value: "a (b) c" });
  });

  it("handles escaped newlines", () => {
    const [token] = tokenize("(line\\nbreak) Tj");
    expect(token).toMatchObject({ value: "line\nbreak" });
  });

  it("refuses an unterminated string instead of returning partial output", () => {
    expect(() => tokenize("(unterminated")).toThrow(PdfSyntaxError);
  });

  it("groups TJ arrays into their strings, ignoring kerning numbers", () => {
    const shows = textShows(tokenize("[ (Hel) -20 (lo) ] TJ"));
    expect(shows).toHaveLength(1);
    expect(shows[0]?.strings).toEqual(["Hel", "lo"]);
  });

  it("finds every text-showing call in order", () => {
    const shows = textShows(tokenize("(one) Tj (two) Tj [(th) -10 (ree)] TJ"));
    expect(shows.map((s) => s.operator)).toEqual(["Tj", "Tj", "TJ"]);
    expect(shows[2]?.strings).toEqual(["th", "ree"]);
  });

  it("does not mistake a drawing operator for a text show", () => {
    expect(textShows(tokenize("0 0 100 100 re f"))).toHaveLength(0);
  });
});
