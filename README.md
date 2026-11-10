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
5. **Fonts**: read `/Widths` so advance is exact; reuse the embedded subset; refuse rather than substituting a face.
6. **Round-trip proof** — partly done: the file reopens in an independent reader with the edit in place. Pixel comparison
   across renderers still needs a renderer.

## Text placement

`positionedRuns` walks the stream tracking the text matrix (`BT`, `Tm`, `Td`, `TD`, `T*`, `TL`, `Tf`) and returns one run
per showing operator with its origin, font and size, plus the operator's byte offset so the run can be rewritten in place.
A `TJ` array is one run, because its pieces share an origin and rewriting them separately loses the kerning anchor.

Two honest limits: glyph advance is approximated at one em per glyph until the font's `/Widths` is read, and a scaled or
rotated text matrix is refused by name rather than measured wrongly, since a wrong x puts the replacement text in the
wrong column.

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

## Status

**Stage 1: you can edit a real PDF and the file stays valid.** Lexer, reader, page tree, chained filters, text placement,
line editing and incremental-update saving all exist with tests. What is missing is reflow itself (inferring the column
and re-breaking the paragraph), font `/Widths` so advance stops being an approximation, and font subset reuse for
characters that are not already in the file.

**Tests:** 38

```bash
npm ci && npm run verify
```

## Non-goals

- Not a PDF renderer. That is pdf.js's job and it is done.
- No OCR, no form filling, no signing.
- Never silently substitute a font: a missing glyph is a refusal, not a guess.

## Licence

MIT.
