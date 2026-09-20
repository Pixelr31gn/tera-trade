import { rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { writeScaffoldFiles } from "../src/autoProvisioner/scaffold.js";
import { PROVISIONER_DIR } from "../src/autoProvisioner/state.js";

const TEST_BLUEPRINT_ID = 999999;
const TEST_TITLE = "test scaffold cleanup target";

afterEach(() => {
  // Belt-and-suspenders cleanup in case a test fails before its own assertion -- this directory
  // name is unique to this test file's fixture blueprintId/title, never a real one.
  const dir = path.join(PROVISIONER_DIR, `${TEST_BLUEPRINT_ID}-${TEST_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`);
  rmSync(dir, { recursive: true, force: true });
});

describe("autoProvisioner.writeScaffoldFiles", () => {
  it("writes files under the blueprint's own staging directory", () => {
    const result = writeScaffoldFiles(TEST_BLUEPRINT_ID, TEST_TITLE, [{ path: "types.ts", content: "export type X = string;\n" }]);
    expect(result.stagingDirAbsolute.startsWith(PROVISIONER_DIR)).toBe(true);
    expect(result.filesWritten).toEqual(["types.ts"]);
  });

  it("refuses a path that would escape the staging directory via ..", () => {
    expect(() => writeScaffoldFiles(TEST_BLUEPRINT_ID, TEST_TITLE, [{ path: "../../../etc/passwd", content: "nope" }])).toThrow(/outside the staging directory/);
  });

  it("refuses an absolute path", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\evil.ts" : "/etc/evil.ts";
    expect(() => writeScaffoldFiles(TEST_BLUEPRINT_ID, TEST_TITLE, [{ path: outside, content: "nope" }])).toThrow(/outside the staging directory/);
  });
});
