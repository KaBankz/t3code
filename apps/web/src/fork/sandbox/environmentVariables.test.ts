import { describe, expect, it } from "vite-plus/test";

import { parseEnvironmentVariables } from "./environmentVariables";

describe("parseEnvironmentVariables", () => {
  it("keeps everything after the first = and skips comments", () => {
    expect(
      parseEnvironmentVariables("# keys\nANTHROPIC_API_KEY=sk=1\n\n  GH_TOKEN = abc  \n"),
    ).toEqual({ ANTHROPIC_API_KEY: "sk=1", GH_TOKEN: "abc" });
  });

  it("names the line that is not KEY=value", () => {
    expect(() => parseEnvironmentVariables("OK=1\nnot a pair")).toThrow("Line 2");
    expect(() => parseEnvironmentVariables("1BAD=x")).toThrow("Line 1");
  });
});
