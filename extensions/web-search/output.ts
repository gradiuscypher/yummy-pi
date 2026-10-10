import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function toolOutput(details: Record<string, unknown>, isError = false) {
  const text = JSON.stringify(details, null, 2);
  const limit = 24000;
  // JSON round-trip drops optional undefined metadata before programmatic output.
  if (text.length <= limit) {
    const structuredContent: { [key: string]: JsonValue } = JSON.parse(text);
    return { content: [{ type: "text" as const, text }], details, structuredContent, isError };
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-web-research-"));
  const fullOutputPath = join(directory, "result.json");
  await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
  return {
    content: [{ type: "text" as const, text: `${text.slice(0, limit)}\n\n[Output truncated. Full JSON saved to ${fullOutputPath}; use read to inspect it.]` }],
    details: { fullOutputPath, truncated: true, totalCharacters: text.length },
    structuredContent: { fullOutputPath, truncated: true, totalCharacters: text.length },
    isError,
  };
}
