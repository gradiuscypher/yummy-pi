import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";

export default function (pi: ExtensionAPI) {
  const HERE = fileURLToPath(import.meta.url);
  const REPO_ROOT = path.resolve(path.dirname(HERE), "../..");
  const EXTENSIONS_DIR = path.join(REPO_ROOT, "extensions");

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "## Extension Development",
        "",
        `This pi instance uses the yummy-pi extension pack. The repo root is at: ${REPO_ROOT}`,
        `All extensions live under: ${EXTENSIONS_DIR}`,
        "",
        "When building or modifying extensions:",
        `- Create each extension in its own subdirectory: ${EXTENSIONS_DIR}/<extension-name>/`,
        "- Use an index.ts entry point that exports a default function receiving ExtensionAPI",
        "- Extensions are loaded via jiti, so TypeScript works without compilation",
        "- After saving an extension, tell the user to run /reload to activate it",
        "- If the extension needs npm dependencies, add a package.json in the extension directory",
        "- Extensions can register tools (pi.registerTool), commands (pi.registerCommand),",
        "  shortcuts (pi.registerShortcut), and subscribe to events (pi.on)",
        "- See the other extensions in this repo for reference patterns",
      ].join("\n"),
    };
  });
}
