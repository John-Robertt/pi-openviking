import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENVIKING_API_PREFIX,
  OPENVIKING_API_VERSION,
  openVikingApiPath,
} from "../shared/openviking-api.mjs";

test("OpenViking API 路径只由版本前缀与相对路径组合", () => {
  assert.equal(OPENVIKING_API_PREFIX, `/api/v${OPENVIKING_API_VERSION}`);
  assert.equal(openVikingApiPath("/content/read?uri=x"), "/api/v1/content/read?uri=x");
  assert.throws(() => openVikingApiPath("content/read"), /must start with/);
});
