/** deterministic 测试共享：test/.artifacts/ 下的临时目录，测试结束即清理。 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACTS = fileURLToPath(new URL("../.artifacts/", import.meta.url));

export function makeTmp(t) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const dir = mkdtempSync(join(ARTIFACTS, "run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
