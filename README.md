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

1. **Lexer** (this repository's first artefact): tokenize content streams with byte offsets, because a token you cannot
   put back where it came from cannot be edited.
2. **Text runs**: group show-operators into positioned runs per line.
3. **Line editing**: replace a run's text, adjust the text matrix so the rest of the line shifts with it.
4. **Reflow**: infer the column from neighbouring lines, re-break the paragraph, regenerate the show-operators.
5. **Fonts**: reuse the embedded subset; refuse rather than silently substituting a different face.
6. **Round-trip proof**: a document opened, edited and saved must render pixel-comparably everywhere except the edit.

## Status

**Stage 0: scaffolding.** The content-stream lexer exists and is tested (numbers, names, strings with escapes and nested
parentheses, arrays, dicts, operators, comments, byte offsets, and text-show grouping for `Tj`/`TJ`/`'`/`"`). There is no
xref parsing, no object model, no editor and no reflow yet.

```bash
npm ci && npm run verify
```

## Non-goals

- Not a PDF renderer. That is pdf.js's job and it is done.
- No OCR, no form filling, no signing.
- Never silently substitute a font: a missing glyph is a refusal, not a guess.

## Licence

MIT.
