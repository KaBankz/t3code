// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain text rewrite over tracked files.
// Renames the product in every tracked file under INCLUDED_PATHS. `--check` writes
// nothing and exits 1 when a file still needs renaming.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  COMPACT_NAME_PATHS,
  FORK_COMPACT_NAME,
  FORK_NAME,
  INCLUDED_PATHS,
  PROTECTED_TEXT,
  SKIPPED_PATHS,
  UPSTREAM_COMPACT_NAME,
  UPSTREAM_NAME,
} from "./brand.ts";

const root = NodePath.resolve(import.meta.dirname, "..", "..");
const check = process.argv.includes("--check");

const tracked = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...INCLUDED_PATHS], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter((file) => file !== "" && !SKIPPED_PATHS.some((skipped) => file.startsWith(skipped.path)));

// Private-use characters cannot appear in source, so they stand in for protected text.
const placeholder = (index: number) => String.fromCodePoint(0xf0000 + index);

function rename(file: string, text: string): string {
  let result = text;
  PROTECTED_TEXT.forEach((entry, index) => {
    result = result.replaceAll(entry.text, placeholder(index));
  });
  // Form-encoded request bodies spell the space as + or %20.
  for (const space of [" ", "+", "%20"]) {
    result = result.replaceAll(
      UPSTREAM_NAME.replaceAll(" ", space),
      FORK_NAME.replaceAll(" ", space),
    );
  }
  if (COMPACT_NAME_PATHS.includes(file)) {
    result = result.replaceAll(UPSTREAM_COMPACT_NAME, FORK_COMPACT_NAME);
  }
  PROTECTED_TEXT.forEach((entry, index) => {
    result = result.replaceAll(placeholder(index), entry.text);
  });
  return result;
}

const changed: Array<string> = [];
for (const file of tracked) {
  const absolute = NodePath.join(root, file);
  if (!NodeFS.existsSync(absolute)) continue;
  const bytes = NodeFS.readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  const next = rename(file, text);
  if (next === text) continue;
  changed.push(file);
  if (!check) NodeFS.writeFileSync(absolute, next);
}

if (check) {
  for (const file of changed) console.log(file);
  console.log(`${changed.length} files still say "${UPSTREAM_NAME}".`);
  process.exitCode = changed.length === 0 ? 0 : 1;
} else {
  // The new name has a different length, so wrapped lines move.
  if (changed.length > 0) {
    NodeChildProcess.execFileSync(
      NodePath.join(root, "node_modules", ".bin", "vp"),
      ["fmt", "--no-error-on-unmatched-pattern", ...changed],
      { cwd: root, stdio: "inherit" },
    );
  }
  console.log(`Renamed "${UPSTREAM_NAME}" to "${FORK_NAME}" in ${changed.length} files.`);
}
