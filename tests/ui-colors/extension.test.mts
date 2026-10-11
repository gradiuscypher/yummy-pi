import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, Theme, type Extension, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(root, "extensions/ui-colors/index.ts");

async function loadColors(source: "settings" | "cli" = "settings") {
  const directory = await mkdtemp(join(tmpdir(), "yummy-pi-colors-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(source === "settings" ? { packages: [root] } : {}),
      additionalExtensionPaths: source === "cli" ? [root] : [],
      disabledBuiltinExtensions: ["mcp", "llama.cpp", "codemode", "tool-search"],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions.find(extension => extension.path === entry);
    assert.ok(extension, "loading yummy-pi must discover the bundled UI color extension");
    return extension;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function lifecycle(extension: Extension, event: "session_start" | "session_shutdown", mode: ExtensionContext["mode"] = "tui") {
  const selected: unknown[] = [];
  const context = { mode, ui: { setTheme: (theme: unknown) => { selected.push(theme); return { success: true }; } } } as ExtensionContext;
  for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, context);
  return selected;
}

async function sampleTheme(mode: "256color" | "truecolor", name = "system") {
  const document: { colors: Record<string, string> } = JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "utf8"));
  const foregrounds = Object.fromEntries(Object.keys(document.colors).filter(token => !token.endsWith("Bg")).map(token => [token, token === "text" || token === "userMessageText" ? "#e6e6e6" : "#657b83"])) as ConstructorParameters<typeof Theme>[0];
  const backgrounds: ConstructorParameters<typeof Theme>[1] = {
    selectedBg: "#1d2e37", searchMatchBg: "#1d2e37", userMessageBg: "#1d2e37", customMessageBg: "#352435",
    toolPendingBg: "#262626", toolSuccessBg: "#1e3026", toolErrorBg: "#352424",
  };
  return new Theme(foregrounds, backgrounds, mode, { name, appearance: "dark" });
}

test("package settings and CLI package loading both include UI colors", async () => {
  for (const source of ["settings", "cli"] as const) {
    const extension = await loadColors(source);
    try { assert.deepEqual(await lifecycle(extension, "session_start"), ["system"]); }
    finally { await lifecycle(extension, "session_shutdown"); }
  }
});

test("bundled colors render the tuned blocks without altering other roles", async () => {
  const extension = await loadColors();
  const theme = await sampleTheme("256color");
  const before = Object.fromEntries(Object.keys(theme.colors).map(token => [token, token.endsWith("Bg") ? theme.bg(token as Parameters<Theme["bg"]>[0], "sample") : theme.fg(token as Parameters<Theme["fg"]>[0], "sample")]));
  const otherTheme = await sampleTheme("256color", "dark");
  const otherBefore = otherTheme.bg("toolSuccessBg", "sample");
  try {
    await lifecycle(extension, "session_start");
    assert.equal(theme.getBgAnsi("toolSuccessBg"), "\x1b[48;2;0;75;75m");
    assert.equal(theme.getBgAnsi("userMessageBg"), "\x1b[48;5;24m");
    for (const token of Object.keys(theme.colors)) {
      const actual = token.endsWith("Bg") ? theme.bg(token as Parameters<Theme["bg"]>[0], "sample") : theme.fg(token as Parameters<Theme["fg"]>[0], "sample");
      if (["dim", "thinkingText", "userMessageBg", "toolSuccessBg"].includes(token)) assert.notEqual(actual, before[token], token);
      else assert.equal(actual, before[token], `${token} must stay unchanged`);
    }
    for (const mode of ["256color", "truecolor"] as const) {
      const current = await sampleTheme(mode);
      const box = new Box(1, 0, text => current.bg("toolSuccessBg", text));
      box.addChild(new Text(current.fg("toolOutput", "Completed tool output"), 0, 0));
      assert.ok(!box.render(40).join("\n").includes("\x1b[48;5;16m"));
      assert.equal(current.bg("toolSuccessBg", "sample"), current.style("sample", { bg: "toolSuccessBg" }));
    }
    assert.equal(otherTheme.bg("toolSuccessBg", "sample"), otherBefore);
  } finally { await lifecycle(extension, "session_shutdown"); }
  assert.equal(theme.bg("toolSuccessBg", "sample"), before.toolSuccessBg);
});

test("duplicate package copies share one patch and clean up in either shutdown order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const copies = [await loadColors(), await loadColors()];
    const original = Theme.prototype.bg;
    try {
      await lifecycle(copies[0], "session_start");
      const patched = Theme.prototype.bg;
      await lifecycle(copies[1], "session_start");
      assert.equal(Theme.prototype.bg, patched, "a second copy must not wrap the theme again");
      await lifecycle(copies[order[0]], "session_shutdown");
      assert.equal(Theme.prototype.bg, patched, "the other copy still owns the patch");
      await lifecycle(copies[order[1]], "session_shutdown");
      assert.equal(Theme.prototype.bg, original);
      await lifecycle(copies[0], "session_start");
      assert.notEqual(Theme.prototype.bg, original, "reload must reapply colors");
    } finally { for (const copy of copies) await lifecycle(copy, "session_shutdown"); }
    assert.equal(Theme.prototype.bg, original);
  }
});

test("non-TUI sessions do not patch colors or select a theme", async () => {
  const extension = await loadColors();
  const original = Theme.prototype.bg;
  for (const mode of ["print", "json", "rpc"] as const) {
    assert.deepEqual(await lifecycle(extension, "session_start", mode), []);
    assert.equal(Theme.prototype.bg, original);
    await lifecycle(extension, "session_shutdown", mode);
  }
});
