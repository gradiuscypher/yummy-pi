/**
 * Bash command safety module for plan/build mode.
 *
 * During the PLAN phase, only read-only commands are allowed.
 * During BUILD phase, all commands are allowed.
 */

import type { PlanBuildConfig } from "./types.ts";

// ── Destructive command patterns (blocked in PLAN phase) ────────────────

const DESTRUCTIVE_PATTERNS = [
	// File deletion
	/\brm\b/i,
	/\brmdir\b/i,
	/\bunlink\b/i,
	/\bshred\b/i,
	// File modification
	/\bmv\b/i,
	/\bcp\b/i,
	/\binstall\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	// Redirects (write to files)
	/(^|[^<])>(?!>)/,
	/>>/,
	// Permissions
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	// Package managers (write operations)
	/\bnpm\s+(install|uninstall|update|ci|link|publish|rebuild|fund|doctor)/i,
	/\byarn\s+(add|remove|install|publish|upgrade)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall|freeze\s*>)/i,
	/\bpip3\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade|autoremove)/i,
	/\bbrew\s+(install|uninstall|upgrade|pin|unpin|tap|untap)/i,
	/\bcargo\s+(install|uninstall|update|add|remove)/i,
	/\bgo\s+(install|get)\b/i,
	// Git destructive
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash\s+(save|push|pop|drop|clear)|cherry-pick|revert|tag|init|clone|remote\s+(add|remove|set-url)|config\s+(?!.*--get))/i,
	// Privilege escalation
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bdoas\b/i,
	// Process control
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\bpgrep\b.*\|.*\bxargs\b.*\bkill\b/i,
	// System control
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bhalt\b/i,
	/\bpoweroff\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask|set-default)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\blaunchctl\s+(load|unload|start|stop|submit|remove)/i,
	// Editors and interactive tools
	/\b(vim?|nano|emacs|code|subl|micro|helix|nvim)\b/i,
	// Docker destructive
	/\bdocker\s+(build|push|rmi|rm|stop|kill|system\s+prune|volume\s+rm|container\s+rm)/i,
	// Disk operations
	/\bmkfs\b/i,
	/\bmount\b/i,
	/\bumount\b/i,
	/\bfdisk\b/i,
	/\bparted\b/i,
	// Network changes
	/\bifconfig\b/i,
	/\bip\s+(link|addr).*(add|del|set)/i,
	/\biptables\b/i,
];

// ── Safe read-only command patterns (allowed in PLAN phase) ────────────

const SAFE_PATTERNS = [
	// File viewing
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*zcat\b/,
	/^\s*zless\b/,
	// Search
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*ag\b/,
	/^\s*ack\b/,
	/^\s*find\b/,
	/^\s*fd\b/,
	/^\s*locate\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*command\s+-v\b/,
	// Directory
	/^\s*ls\b/,
	/^\s*eza\b/,
	/^\s*exa\b/,
	/^\s*pwd\b/,
	/^\s*tree\b/,
	/^\s*dirent\b/,
	// Output / formatting
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*cmp\b/,
	/^\s*comm\b/,
	/^\s*cut\b/,
	/^\s*paste\b/,
	/^\s*tr\b/,
	/^\s*column\b/,
	/^\s*nl\b/,
	/^\s*xxd\b/,
	/^\s*hexdump\b/,
	/^\s*od\b/,
	/^\s*base64\b/,
	// File metadata
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*md5\b/,
	/^\s*md5sum\b/,
	/^\s*sha1sum\b/,
	/^\s*sha256sum\b/,
	/^\s*sha512sum\b/,
	/^\s*shasum\b/,
	/^\s*cksum\b/,
	// Disk usage
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*ncdu\b/,
	// Environment / system
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*who\b/,
	/^\s*w\b/,
	/^\s*id\b/,
	/^\s*groups\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*hostname\b/,
	/^\s*arch\b/,
	// Process info (read-only)
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*pgrep\b/,
	/^\s*pidof\b/,
	// Memory / resource info
	/^\s*free\b/,
	/^\s*vmstat\b/,
	/^\s*iostat\b/,
	/^\s*mpstat\b/,
	/^\s*lsof\b/,
	// Git read-only
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|blame|stash\s+list|stash\s+show|whatchanged|shortlog|describe|rev-parse|rev-list|ls-files|ls-tree|ls-remote|for-each-ref|name-rev|tag\s+-l)/i,
	/^\s*git\s+ls-/i,
	// Package manager info
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|fund|dist-tag|access\s+ls-pack)/i,
	/^\s*yarn\s+(list|info|why|audit|workspaces\s+info)/i,
	/^\s*pip\s+(list|show|search|freeze\s*$)/i,
	/^\s*brew\s+(list|info|search|outdated|leaves|deps|uses|config)/i,
	/^\s*apt(-get)?\s+(list|search|show|policy)/i,
	/^\s*cargo\s+(search|tree|metadata)/i,
	/^\s*go\s+(list|version|env|doc)\b/i,
	// Version checks
	/^\s*(node|npm|npx|python|python3|ruby|perl|php|java|javac|rustc|rustup|cargo|go)\s+--version/i,
	/^\s*(git|docker|kubectl|helm|terraform)\s+version/i,
	// Network read-only
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*ping\b/,
	/^\s*nslookup\b/,
	/^\s*dig\b/,
	/^\s*host\b/,
	/^\s*traceroute\b/,
	/^\s*nc\s+-z/i,
	/^\s*ssh\s+-T/i,
	// JSON/YAML/TOML tools
	/^\s*jq\b/,
	/^\s*yq\b/,
	/^\s*fx\b/,
	// Text processing (read-only uses)
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*xargs\b.*\b(cat|ls|grep|head|tail|wc|file|stat)\b/i,
	// Man pages
	/^\s*man\b/,
	/^\s*help\b/,
	/^\s*info\b/,
	// Misc read-only
	/^\s*bat\b/,
	/^\s*delta\b/,
	/^\s*icdiff\b/,
	/^\s*colordiff\b/,
];

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Check if a bash command is safe for plan mode.
 * A command is safe if it matches at least one safe pattern
 * and does not match any destructive pattern.
 */
export function isSafeCommand(command: string, config?: PlanBuildConfig): boolean {
	const safePatterns = buildSafePatterns(config);
	const blockPatterns = buildBlockPatterns(config);

	const isBlocked = blockPatterns.some((p) => p.test(command));
	const isSafe = safePatterns.some((p) => p.test(command));

	return !isBlocked && isSafe;
}

/**
 * Get the reason a command was blocked (for user notification).
 */
export function getBlockReason(command: string): string {
	const trimmed = command.trim();

	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) {
		const matched = DESTRUCTIVE_PATTERNS.find((p) => p.test(command));
		return `Command matched destructive pattern: ${matched}`;
	}

	if (!SAFE_PATTERNS.some((p) => p.test(command))) {
		return "Command not in the read-only allowlist (try using built-in tools: read, grep, find, ls instead)";
	}

	return "Unknown reason";
}

/**
 * Build the effective list of safe patterns (built-in + user config).
 */
function buildSafePatterns(config?: PlanBuildConfig): RegExp[] {
	const patterns = [...SAFE_PATTERNS];
	if (config?.extraSafePatterns) {
		for (const p of config.extraSafePatterns) {
			try {
				patterns.push(new RegExp(`^\\s*${p}`));
			} catch {
				// Skip invalid patterns
			}
		}
	}
	return patterns;
}

/**
 * Build the effective list of block patterns (built-in + user config).
 */
function buildBlockPatterns(config?: PlanBuildConfig): RegExp[] {
	const patterns = [...DESTRUCTIVE_PATTERNS];
	if (config?.extraBlockedPatterns) {
		for (const p of config.extraBlockedPatterns) {
			try {
				patterns.push(new RegExp(p));
			} catch {
				// Skip invalid patterns
			}
		}
	}
	return patterns;
}
