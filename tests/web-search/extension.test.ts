import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../../extensions/web-search/index.ts";
import { toolOutput } from "../../extensions/web-search/output.ts";

function harness() {
  const tools = new Map<string, ToolDefinition>();
  const commands: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.push(name),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()].filter(name => name !== "web_search"),
  } as unknown as ExtensionAPI;
  register(pi);
  const execute = async (name: string, params: Record<string, unknown> = {}) => {
    const result = await tools.get(name)!.execute("test", params, new AbortController().signal, undefined, {} as ExtensionToolContext);
    const content = result.content[0];
    assert.equal(content.type, "text");
    return JSON.parse(content.type === "text" ? content.text : "{}");
  };
  return { tools, commands, execute };
}
test("registers research tools and a diagnostic command; status respects inactive tools without leaking keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-search-test-"));
  const previous = process.env.PI_WEB_SEARCH_CONFIG;
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ providers: { exa: { apiKey: "private-secret" } } }));
    process.env.PI_WEB_SEARCH_CONFIG = path;
    const { tools, commands, execute } = harness();
    assert.deepEqual([...tools.keys()].sort(), ["web_search", "web_search_status", "web_search_usage", "web_fetch", "web_sitemap"].sort());
    assert.deepEqual(commands, ["web-search-status"]);
    const status = await execute("web_search_status");
    assert.equal(status.tools.find((x: any) => x.name === "web_search").active, false);
    assert.equal(status.providers.find((x: any) => x.id === "exa").credentialPresent, true);
    assert.equal(status.statistics.toolCalls.web_search_status, 1);
    assert.ok(!JSON.stringify(status).includes("private-secret"));
    await writeFile(path, '{"apiKey":"private-secret",');
    const invalid = await execute("web_search_status");
    assert.equal(invalid.configStatus, "invalid");
    assert.ok(!JSON.stringify(invalid).includes("private-secret"));
    // Fetch is provider/config independent and rejects private destinations before networking.
    const fetchResult = await execute("web_fetch", { url: "http://127.0.0.1" });
    assert.equal(fetchResult.status, "failed");
    const after = await execute("web_search_status");
    assert.equal(after.statistics.pageFailures, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test("large tool output is bounded and complete output is stored in a private temp file", async () => {
  const details = { text: "x".repeat(40000) };
  const result = await toolOutput(details);
  assert.ok(result.content[0].text.length < 25000);
  const outputDetails = result.details as { fullOutputPath: string; truncated: boolean };
  assert.equal(outputDetails.truncated, true);
  assert.deepEqual(JSON.parse(await readFile(outputDetails.fullOutputPath, "utf8")), details);
  await rm(join(outputDetails.fullOutputPath, ".."), { recursive: true, force: true });
});
