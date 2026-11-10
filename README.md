# reflowpdf

**Click a paragraph in a real PDF, retype it, and have the text reflow inside its existing column.**

pdf.js reads PDFs beautifully. pdf-lib creates them. Nothing open sits in the middle: editing text *in place* in a PDF
that came from somewhere else, without the layout falling apart.

## Why it is open

Reflow is the one PDF feature every consumer of every PDF viewer eventually asks for, and it is missing because it is
genuinely hard: the text you click is a sequence of show-operators with absolute positions, the column width is implied by
where the rest of the lines land, and any replacement must be re-encoded into a font subset that already exists in the
file.

## Order of work


1. **Lexer** — done: content streams tokenized with byte offsets, because a token you cannot put back where it came from
   cannot be edited.
2. **Text runs** — done: show-operators grouped into positioned runs with coordinates, font and size.
3. **Line editing** — done: replace a run's text, shift the rest of the line by the change in advance, save as an
   incremental update.
4. **Reflow**: infer the column from neighbouring lines, re-break the paragraph, regenerate the show-operators.
5. **Fonts** — advance done: `/Widths` is read, so a shift is a measurement. Still missing: reusing the embedded subset
   for characters the file does not already contain, and a missing glyph is refused rather than substituted.
6. **Round-trip proof** — partly done: the file reopens in an independent reader with the edit in place. Pixel comparison
   across renderers still needs a renderer.

## Text placement

`positionedRuns` walks the stream tracking the text matrix (`BT`, `Tm`, `Td`, `TD`, `T*`, `TL`, `Tf`) and returns one run
per showing operator with its origin, font and size, plus the operator's byte offset so the run can be rewritten in place.
A `TJ` array is one run, because its pieces share an origin and rewriting them separately loses the kerning anchor.

A scaled or rotated text matrix is refused by name rather than measured wrongly, since a wrong x puts the replacement
text in the wrong column.

## Advance is measured, not assumed

One em per glyph is enough to tell runs apart and not enough to move text: it overstates Helvetica by about a third, so an
edit that changed a line's length put everything after it in the wrong place. `src/fonts.ts` reads the real number from
the page's `/Resources /Font`: `/Widths` indexed by character code from `/FirstChar`, with `/FontDescriptor /MissingWidth`
for codes the table does not cover, which is what `Type1`, `MMType1` and `TrueType` fonts need.

Each run says whether its advance was measured (`advanceExact`), and `editLine` takes the widths and shifts by the
difference, so `delta` is exact to whatever precision the font declares. On the embedded-font fixture, editing "left run"
to "left run, but longer" shifts its neighbour by 63.79 points; the one-em fallback would have shifted it by 132, nearly an
inch, which is exactly how a column stops being a column.

Refusals, because a plausible wrong number is worse than an error:

- `Type0` fonts: codes are glyph indices chosen by a CMap and widths live in `/W`, a different shape of table. Indexing it
  the way `/Widths` is indexed would measure the wrong glyph and look fine.
- `Type3` fonts: widths are in glyph space and need `/FontMatrix` to become points.
- a font with no `/Widths` at all: the base-14 fonts keep their metrics in Adobe's AFM files, which are not in the
  document, so the caller gets the one-em fallback and a run that says it is not exact.

Fonts are also read from the `/Pages` ancestors when a page does not carry `/Resources` itself, which is where real
writers often put them; reading only the page would find no fonts on a perfectly readable file.

## The file, not just the stream

A content stream is only useful inside the object that holds it, so `src/pdf.ts` reads as much PDF as an editor needs and
refuses the rest by name:

- the `startxref` chain and `/Prev`, newest revision first, so a file can be edited again and again;
- classic xref tables, indirect objects parsed lazily by offset, `/Length` checked against the file rather than trusted;
- stream filters **chained**, which is what real files use: the test fixture arrives as `/ASCII85Decode /FlateDecode`;
- the page tree, walked to pages, each page's decoded content;

and these refusals, each because guessing produces a corrupt file rather than an error: cross-reference streams,
encrypted documents, `/Predictor` decode parameters, `DCTDecode` and friends, and an xref offset that points at the wrong
object.

Writing is an **incremental update**: the original bytes are copied verbatim, one replaced object is appended, and a new
xref section points at it with `/Prev` back to the old one. So "everything else in the file is untouched" is a property
you can check with `saved.slice(0, original.length) === original`, and the test does exactly that.

## Editing a line

`editLine(stream, runIndex, newText)` replaces a run's text and pushes the rest of that line along by the difference in
advance. Every splice is computed against the original offsets and applied in one descending pass, because a replacement
changes every byte offset after it and a two-pass version edits the wrong bytes (that bug happened during development and
is now a test).

Refusals, by name: the `"` operator (its word and character spacing operands would be lost), a later run positioned by
`T*` (which takes no x operand, so there is nowhere to put the shift), and overlapping splices.

## Verified against a real file

`tests/fixtures/article.pdf` is a one-page document written by ReportLab, committed as bytes so the suite needs no PDF
toolchain (`tools/make-fixture.py` records how it was made; the suite itself has no Python or PDF dependency). The
round-trip test opens it, retypes the middle line, saves, reopens the saved bytes through the full `startxref` chain, and
asserts the text. Independently, the edited file was opened with **pypdf**, a reader this project shares no code with: one
page, metadata intact, and the new sentence extracted in place. The revision it appends names exactly one object.

`tests/fixtures/article-ttf.pdf` is the same idea for measurement: DejaVu Sans embedded, so the file carries a real
`/Widths` table. Retyping "left run" as "left run, but longer" shifts its neighbour by 63.787 points, and pypdf's text
visitor, reading the saved file, reports that neighbour at x = 243.7871, which is 180 plus the shift. The expected
advances came from ReportLab, which reads the TrueType tables itself, so the number being checked was never produced by
the code being checked.

## Status

**Stage 1: you can edit a real PDF and the file stays valid.** Lexer, reader, page tree, chained filters, text placement
with measured advance, line editing and incremental-update saving all exist with tests, on two real fixtures: one in
base-14 fonts where advance is honestly flagged as approximate, and one with DejaVu Sans embedded where it is measured
against numbers ReportLab computed from the TrueType tables. What is missing is reflow itself (inferring the column and
re-breaking the paragraph) and font subset reuse for characters the file does not already contain.

**Tests:** 61

```bash
npm ci && npm run verify
```

## Non-goals

- Not a PDF renderer. That is pdf.js's job and it is done.
- No OCR, no form filling, no signing.
- Never silently substitute a font: a missing glyph is a refusal, not a guess.

## Licence

MIT.
