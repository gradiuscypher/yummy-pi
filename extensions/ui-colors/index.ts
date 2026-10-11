import { Theme, type ExtensionAPI, type ThemeBg, type ThemeColor, type ThemeStyle } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, colorToOklch, foregroundAnsi, indexedColor, mixColors, oklchColor, rgbColor, type Color } from "@earendil-works/pi-tui";

const PATCH_STATE = Symbol.for("yummy-pi:ui-colors:patch");
type PatchState = { users: number; restore: () => void };

// Preserve the terminal-adaptive system palette, with brighter secondary UI text
// and a subtly cooler, less saturated background for successful tool blocks.
// User-message backgrounds are a little lighter, but remain blue.
// Tool output, other panels, green text, and general muted text stay untouched.
// Pi currently has no per-token override API, so wrap these public rendering
// methods temporarily and restore them on shutdown/reload.
export default function (pi: ExtensionAPI) {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || restore) return;

    const prototype = Theme.prototype;
    const existing: PatchState | undefined = Object.getOwnPropertyDescriptor(prototype, PATCH_STATE)?.value;
    const release = (state: PatchState) => {
      restore = () => {
        restore = undefined;
        if (--state.users === 0) state.restore();
      };
    };
    // Package copies and a migrated personal copy share the host Theme class.
    // Apply the wrappers once, and keep them until the last owner shuts down.
    if (existing) {
      existing.users++;
      release(existing);
      return;
    }
    const originalFg = prototype.fg;
    const originalBg = prototype.bg;
    const originalStyle = prototype.style;
    const originalGetFgAnsi = prototype.getFgAnsi;
    const originalGetBgAnsi = prototype.getBgAnsi;

    function secondaryColor(theme: Theme, token: unknown): Color | undefined {
      if (theme.name !== "system" || (token !== "dim" && token !== "thinkingText")) return;
      // Read current colors rather than caching: system colors can change after
      // terminal discovery or when the terminal switches light/dark appearance.
      return mixColors(theme.colors[token], theme.colors.text, 0.3);
    }

    function adjustedBackground(theme: Theme, token: unknown): Color | undefined {
      if (theme.name !== "system") return;
      if (token === "userMessageBg" && theme.appearance === "dark") {
        // The 256-color cube can turn a small blue lightness adjustment into teal
        // or grey. Choose a blue cell explicitly, distinct from success teal (23).
        if (theme.getColorMode() !== "truecolor") return indexedColor(24);
        const { l, c, h } = colorToOklch(theme.colors.userMessageBg);
        return oklchColor(Math.min(l + 0.04, 1), c, h);
      }
      if (token !== "toolSuccessBg") return;
      const { l, c, h } = colorToOklch(theme.colors.toolSuccessBg);
      // Darken the previously selected teal just a little. The local tmux client
      // advertises RGB support, although Pi currently selects 256-color output.
      // Preserve the visible fallback's hue, lowering #005555 to #004b4b.
      if (theme.appearance === "dark" && theme.getColorMode() !== "truecolor") {
        return rgbColor(0, 75, 75);
      }
      return oklchColor(Math.max(l - (theme.appearance === "dark" ? 0.04 : 0), 0), c * 0.8, (h + 35) % 360);
    }

    function backgroundEscape(theme: Theme, token: unknown, color: Color): string {
      // Use verified RGB support for this one background only, so the subtle
      // darkening does not quantize back to the same teal cell (or to black).
      return backgroundAnsi(color, token === "toolSuccessBg" ? "truecolor" : theme.getColorMode());
    }

    prototype.fg = function (token: ThemeColor, text: string): string {
      const color = secondaryColor(this, token);
      return color
        ? originalStyle.call(this, text, { fg: color })
        : originalFg.call(this, token, text);
    };
    prototype.bg = function (token: ThemeBg, text: string): string {
      const color = adjustedBackground(this, token);
      return color
        ? `${backgroundEscape(this, token, color)}${text}\x1b[49m`
        : originalBg.call(this, token, text);
    };
    prototype.style = function (text: string, options: ThemeStyle): string {
      const fg = secondaryColor(this, options.fg);
      const bg = adjustedBackground(this, options.bg);
      if (bg && options.bg === "toolSuccessBg") {
        const styled = originalStyle.call(this, text, {
          ...options,
          ...(fg ? { fg } : {}),
          bg: undefined,
        });
        return `${backgroundEscape(this, options.bg, bg)}${styled}\x1b[49m`;
      }
      return originalStyle.call(this, text, {
        ...options,
        ...(fg ? { fg } : {}),
        ...(bg ? { bg } : {}),
      });
    };
    prototype.getFgAnsi = function (token: ThemeColor): string {
      const color = secondaryColor(this, token);
      return color ? foregroundAnsi(color, this.getColorMode()) : originalGetFgAnsi.call(this, token);
    };

    prototype.getBgAnsi = function (token: ThemeBg): string {
      const color = adjustedBackground(this, token);
      return color ? backgroundEscape(this, token, color) : originalGetBgAnsi.call(this, token);
    };

    const state: PatchState = {
      users: 1,
      restore: () => {
        prototype.fg = originalFg;
        prototype.bg = originalBg;
        prototype.style = originalStyle;
        prototype.getFgAnsi = originalGetFgAnsi;
        prototype.getBgAnsi = originalGetBgAnsi;
        Reflect.deleteProperty(prototype, PATCH_STATE);
      },
    };
    Object.defineProperty(prototype, PATCH_STATE, { value: state, configurable: true });
    release(state);
    // Select the terminal-adaptive palette and request normal theme rendering.
    ctx.ui.setTheme("system");
  });

  pi.on("session_shutdown", () => restore?.());
}
