/**
 * The project carries no Node or DOM types on purpose (`"types": []`), so the two globals a test needs are declared
 * here rather than by adding a dependency that would leak into the library's type surface.
 */

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
}

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input: Uint8Array): string;
}
