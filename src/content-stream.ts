/**
 * A PDF content-stream lexer.
 *
 * Reading a PDF is not hard; rewriting one without corrupting it is. Reflow needs to parse a content stream, find the
 * text-showing operators with their positions, and write replacements back into exactly the same stream. So the first
 * artefact here is a tokenizer that reports byte offsets, because a token you cannot put back where it came from cannot
 * be edited.
 *
 * Deliberately not a full PDF parser yet: no xref, no object streams, no filters. Those come when the tokenizer has
 * proven itself against real files.
 */

export type Token =
  | { readonly kind: "number"; readonly value: number; readonly offset: number; readonly raw: string }
  | { readonly kind: "name"; readonly value: string; readonly offset: number; readonly raw: string }
  | { readonly kind: "string"; readonly value: string; readonly offset: number; readonly raw: string }
  | { readonly kind: "operator"; readonly value: string; readonly offset: number; readonly raw: string }
  | { readonly kind: "array-start" | "array-end" | "dict-start" | "dict-end"; readonly offset: number; readonly raw: string }
  | { readonly kind: "comment"; readonly value: string; readonly offset: number; readonly raw: string };

export class PdfSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "PdfSyntaxError";
  }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/** Tokenizes a decoded content stream. Offsets are relative to the string, which is what an editor needs. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const code = source.charCodeAt(i);

    if (WHITESPACE.has(code)) {
      i += 1;
      continue;
    }

    if (code === 0x25) {
      const start = i;
      while (i < source.length && source.charCodeAt(i) !== 0x0a && source.charCodeAt(i) !== 0x0d) i += 1;
      tokens.push({ kind: "comment", value: source.slice(start + 1, i), offset: start, raw: source.slice(start, i) });
      continue;
    }

    if (code === 0x5b) {
      tokens.push({ kind: "array-start", offset: i, raw: "[" });
      i += 1;
      continue;
    }
    if (code === 0x5d) {
      tokens.push({ kind: "array-end", offset: i, raw: "]" });
      i += 1;
      continue;
    }
    if (code === 0x3c && source.charCodeAt(i + 1) === 0x3c) {
      tokens.push({ kind: "dict-start", offset: i, raw: "<<" });
      i += 2;
      continue;
    }
    if (code === 0x3e && source.charCodeAt(i + 1) === 0x3e) {
      tokens.push({ kind: "dict-end", offset: i, raw: ">>" });
      i += 2;
      continue;
    }

    if (code === 0x2f) {
      const start = i;
      i += 1;
      while (i < source.length && isRegular(source.charCodeAt(i))) i += 1;
      const raw = source.slice(start, i);
      tokens.push({ kind: "name", value: raw.slice(1), offset: start, raw });
      continue;
    }

    if (code === 0x28) {
      const start = i;
      let depth = 0;
      let value = "";
      i += 1;
      for (;;) {
        if (i >= source.length) throw new PdfSyntaxError("unterminated string", start);
        const c = source.charCodeAt(i);
        if (c === 0x5c) {
          const next = source[i + 1];
          if (next === undefined) throw new PdfSyntaxError("unterminated escape", i);
          const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          value += escaped[next] ?? next;
          i += 2;
          continue;
        }
        if (c === 0x28) depth += 1;
        if (c === 0x29) {
          if (depth === 0) {
            i += 1;
            break;
          }
          depth -= 1;
        }
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: "string", value, offset: start, raw: source.slice(start, i) });
      continue;
    }

    const start = i;
    while (i < source.length && isRegular(source.charCodeAt(i))) i += 1;
    const raw = source.slice(start, i);
    if (raw === "") throw new PdfSyntaxError(`unexpected character ${JSON.stringify(source[i])}`, start);
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      tokens.push({ kind: "number", value: numeric, offset: start, raw });
    } else {
      tokens.push({ kind: "operator", value: raw, offset: start, raw });
    }
  }

  return tokens;
}

/** The text-showing calls a reflow engine must find. */
export const TEXT_OPERATORS = ["Tj", "TJ", "'", '"'] as const;

export interface TextShow {
  readonly operator: string;
  readonly strings: readonly string[];
  readonly offset: number;
}

/**
 * Groups the operands that belong to each text-showing operator.
 *
 * A `Tj` takes one string, a `TJ` takes an array that interleaves strings and kerning numbers, and `'`/`"` are
 * shorthands. Reflow must not rewrite a show call without knowing which operands it consumes.
 */
export function textShows(tokens: readonly Token[]): TextShow[] {
  const shows: TextShow[] = [];
  let pending: Token[] = [];

  for (const token of tokens) {
    if (token.kind === "operator") {
      if ((TEXT_OPERATORS as readonly string[]).includes(token.value)) {
        const strings = pending.filter((t) => t.kind === "string").map((t) => (t as { value: string }).value);
        shows.push({ operator: token.value, strings, offset: token.offset });
      }
      pending = [];
      continue;
    }
    if (token.kind === "comment") continue;
    pending.push(token);
  }

  return shows;
}
