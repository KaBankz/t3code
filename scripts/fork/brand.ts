// The fork's product name and the rules for applying it. Change FORK_NAME, then run
// `node scripts/fork/rebrand.ts`; `scripts/fork/sync-upstream.sh` regenerates the
// branding commit on every upstream sync, so new upstream strings get renamed too.

export const UPSTREAM_NAME = "T3 Code";
export const FORK_NAME = "Crafting Table";

// Expo derives the Xcode workspace, scheme and .app names from the app name minus spaces.
export const UPSTREAM_COMPACT_NAME = "T3Code";
export const FORK_COMPACT_NAME = FORK_NAME.replaceAll(/[^A-Za-z0-9]/g, "");

/** Tracked paths that ship in the product. Docs, marketing, infra and packaging stay upstream's. */
export const INCLUDED_PATHS = [
  "apps/desktop/",
  "apps/mobile/",
  "apps/server/",
  "apps/web/",
  "native/",
  "packages/",
  "scripts/",
];

export const SKIPPED_PATHS: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [
  { path: "scripts/fork/", reason: "This tool." },
  {
    path: "apps/desktop/src/app/DesktopUserData.",
    reason: "Legacy profile folder names that existing installs migrate from.",
  },
  {
    path: "apps/desktop/src/app/DesktopLegacyLocalStorage.",
    reason: "Version 1 profile folder names scanned for localStorage import.",
  },
  {
    path: "scripts/mobile-showcase-environment.ts",
    reason: "Showcases the upstream repository by name.",
  },
  { path: "apps/mobile/modules/t3-source-text/UPSTREAM.md", reason: "Upstream provenance note." },
  {
    path: "apps/server/src/cli/triagePrompt.",
    reason: "Must stay byte-identical to .github/triage/PLAYBOOK.md for the upstream repository.",
  },
  {
    path: "packages/shared/src/paletteSearch.test.ts",
    reason: "Search fixtures that match the upstream name against `t3code`.",
  },
  {
    path: "packages/shared/src/t3McpToolPresentation.test.ts",
    reason: "Tool labels built from the MCP server name, which is protected below.",
  },
];

/** Text that keeps the upstream name wherever it appears, because something outside matches on it. */
export const PROTECTED_TEXT: ReadonlyArray<{ readonly text: string; readonly reason: string }> = [
  {
    text: 'CODEX_CLIENT_NAME = "T3 Code"',
    reason: "Codex originator; OpenAI keys the model list on it.",
  },
  { text: '"clientInfo":{"name":"T3 Code","title":"T3 Code"', reason: "Codex replay fixtures." },
  { text: 'name: "T3 Code", title: "T3 Code"', reason: "Codex replay fixtures." },
  { text: '"originator":"T3 Code"', reason: "Codex replay fixtures." },
  { text: '"userAgent":"T3 Code/', reason: "Codex replay fixtures." },
  { text: 'userAgent: "T3 Code/', reason: "Codex replay fixtures." },
  { text: "unknown (T3 Code; ", reason: "Codex replay fixtures." },
  {
    text: 'agent_name_hint: "T3 Code"',
    reason: "Registers the ChatGPT sign-in client with OpenAI, alongside the Codex originator.",
  },
  { text: 'get("agent_name_hint"), "T3 Code"', reason: "Mirrors agent_name_hint." },
  {
    text: 'McpServer.layerHttp({\n  name: "T3 Code",',
    reason: "Providers label tools with the MCP server name; t3McpToolPresentation matches it.",
  },
  {
    text: "Application Support/T3 Code (Dev)",
    reason: "Legacy profile folder that existing dev installs keep using.",
  },
  { text: "T3 Code \\((Alpha|Dev)\\)", reason: "Matches the legacy profile folders." },
  {
    text: "Written by T3 Code: runs the desktop app's bundled t3 CLI.",
    reason: "Marker that identifies CLI shims already installed on disk.",
  },
  { text: "a T3 Code version before 0.1.0", reason: "Names upstream releases." },
];

/** Files that refer to the Xcode names Expo derives from the mobile app name. */
export const COMPACT_NAME_PATHS = [
  "scripts/mobile-native-client.ts",
  "scripts/mobile-native-client.test.ts",
  "scripts/mobile-showcase.ts",
  "scripts/mobile-showcase.test.ts",
];
