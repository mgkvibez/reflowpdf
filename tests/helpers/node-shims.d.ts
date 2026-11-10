/**
 * The project carries no Node or DOM types on purpose (`"types": []`), so the two globals a test needs are declared
 * here rather than by adding a dependency that would leak into the library's type surface.
 */

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { encoding?: "utf8"; stdio?: "ignore" | "inherit" | "pipe" },
  ): string;
}

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input: Uint8Array): string;
}
