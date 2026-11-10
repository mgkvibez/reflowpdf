/**
 * Builds a tiny PDF with a correct classic xref table, so tests can present bytes a real writer would never produce.
 *
 * Every offset is computed from the assembled file rather than written by hand: a fixture with a wrong offset tests the
 * wrong refusal, which is how parser tests lie to their authors.
 */

export interface BuildOptions {
  readonly objects: readonly string[];
  readonly trailerExtra?: string;
}

export function buildPdf({ objects, trailerExtra = "" }: BuildOptions): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}
