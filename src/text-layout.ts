/**
 * Where the text actually sits on the page.
 *
 * The lexer finds text-showing operators; reflow needs their coordinates, because "replace this line and keep the column"
 * is a question about geometry. PDF gives that geometry through a tiny handful of operators: `Tm` sets the text matrix
 * absolutely, `Td`/`TD` move it relative to the line start, `T*` starts a new line at the leading, `TL` sets that leading,
 * `Tf` sets the font and size, and `TJ` intersperses kerning adjustments measured in thousandths of an em.
 *
 * Scope is deliberate: this tracks the text matrix, not the full CTM, so it is correct for content streams that do not
 * scale or rotate between `q`/`Q` pairs. A stream that does is refused by name rather than silently mis-measured,
 * because a wrong x position produces a replacement in the wrong column, which is worse than a refusal.
 */

import { TEXT_OPERATORS, type Token } from "./content-stream.js";
import type { FontWidths } from "./fonts.js";

export interface PositionedRun {
  readonly text: string;
  /** Text-space origin of the run's first glyph, in points. */
  readonly x: number;
  readonly y: number;
  readonly font: string;
  readonly fontSize: number;
  /** How far the pen moved for `text`, in points: the font's `/Widths` when they were supplied, else one em per glyph. */
  readonly advance: number;
  /** False when `advance` is the one-em fallback, so a caller can tell a measurement from an approximation. */
  readonly advanceExact: boolean;
  /** The font's widths, when the caller supplied them, so an editor can measure replacement text the same way. */
  readonly widths?: FontWidths;
  /** Byte offset of the showing operator, so an editor can rewrite this run in place. */
  readonly offset: number;
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

interface State {
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  leading: number;
  font: string;
  fontSize: number;
  /** Horizontal scale and character spacing, both of which move the pen without moving the origin. */
  penX: number;
}

function numbers(tokens: readonly Token[]): number[] {
  return tokens.filter((token) => token.kind === "number").map((token) => (token as { value: number }).value);
}

function stringsIn(tokens: readonly Token[]): string[] {
  return tokens.filter((token) => token.kind === "string").map((token) => (token as { value: string }).value);
}

/**
 * Walks the stream and returns one run per text-showing operator, with its origin.
 *
 * A `TJ` array produces one run, not one per string: the pieces are part of the same showing operation and must be
 * rewritten together, or the kerning numbers between them lose their anchor.
 *
 * `fonts` is the page's `/Widths` table, keyed by the resource name the stream uses (`/F1`). With it, advance is
 * measured and a later run's origin is exact; without it, advance is one em per glyph and each run says so through
 * `advanceExact`, because a caller that shifts text has to know whether the number it shifted by was measured.
 */
export function positionedRuns(tokens: readonly Token[], fonts?: ReadonlyMap<string, FontWidths>): PositionedRun[] {
  const runs: PositionedRun[] = [];
  const state: State = { x: 0, y: 0, lineX: 0, lineY: 0, leading: 0, font: "", fontSize: 0, penX: 0 };
  let pending: Token[] = [];

  for (const token of tokens) {
    if (token.kind !== "operator") {
      if (token.kind !== "comment") pending.push(token);
      continue;
    }

    const operator = token.value;
    const args = numbers(pending);

    switch (operator) {
      case "BT":
        state.x = 0;
        state.y = 0;
        state.lineX = 0;
        state.lineY = 0;
        state.penX = 0;
        break;
      case "TL":
        state.leading = args.at(-1) ?? 0;
        break;
      case "Tf": {
        const name = pending.find((item) => item.kind === "name");
        state.font = name === undefined ? "" : (name as { value: string }).value;
        state.fontSize = args.at(-1) ?? 0;
        break;
      }
      case "Tm":
        if (args.length >= 6 && (args[0] !== 1 || args[1] !== 0 || args[2] !== 0 || args[3] !== 1)) {
          // a scaled or rotated text matrix: this module does not model it, and guessing would misplace the text
          throw new LayoutError(
            `text matrix with scale or rotation is not supported (matrix ${args.slice(0, 4).join(" ")}) at byte ${token.offset}`,
          );
        }
        if (args.length >= 6) {
          state.x = args[4] as number;
          state.y = args[5] as number;
          state.lineX = state.x;
          state.lineY = state.y;
          state.penX = 0;
        }
        break;
      case "Td":
      case "TD": {
        const tx = args[0] ?? 0;
        const ty = args[1] ?? 0;
        state.lineX += tx;
        state.lineY += ty;
        state.x = state.lineX;
        state.y = state.lineY;
        state.penX = 0;
        if (operator === "TD") state.leading = -ty;
        break;
      }
      case "T*":
        state.lineY -= state.leading;
        state.x = state.lineX;
        state.y = state.lineY;
        state.penX = 0;
        break;
      default:
        break;
    }

    if ((TEXT_OPERATORS as readonly string[]).includes(operator)) {
      const strings = stringsIn(pending);
      if (strings.length > 0) {
        const text = strings.join("");
        const widths = fonts?.get(state.font);
        // Advance the pen across every string in the showing operation, minus the kerning between them. Kerning follows
        // the spec's sign convention, where a positive array number moves the pen left.
        let advance = 0;
        let advanceExact = widths !== undefined;
        for (const item of pending) {
          if (item.kind === "string") {
            const value = (item as { value: string }).value;
            if (widths === undefined) {
              advance += value.length * state.fontSize;
            } else {
              advance += widths.advance(value, state.fontSize);
              advanceExact &&= widths.measuresExactly(value);
            }
          }
          if (item.kind === "number") advance -= ((item as { value: number }).value / 1000) * state.fontSize;
        }
        runs.push({
          text,
          x: state.x + state.penX,
          y: state.y,
          font: state.font,
          fontSize: state.fontSize,
          advance,
          advanceExact,
          ...(widths === undefined ? {} : { widths }),
          offset: token.offset,
        });
        state.penX += advance;
      }
    }

    pending = [];
  }

  return runs;
}
