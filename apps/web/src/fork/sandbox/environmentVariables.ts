const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Parses `KEY=value` lines; blank lines and `#` comments are skipped. */
export function parseEnvironmentVariables(text: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = separator === -1 ? line : line.slice(0, separator).trim();
    if (separator === -1 || !ENVIRONMENT_VARIABLE_NAME.test(name)) {
      throw new Error(`Line ${index + 1} is not KEY=value.`);
    }
    environment[name] = line.slice(separator + 1).trim();
  }
  return environment;
}
