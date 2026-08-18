import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import probe from "../scripts/e2e-probe.ts";

const runDir = `test/.artifacts/live/e2e-probe-test-${process.pid}`;
mkdirSync(runDir, { recursive: true, mode: 0o700 });
after(() => {
  delete process.env.OV_E2E_FD;
  delete process.env.OV_E2E_TURN;
  rmSync(runDir, { recursive: true, force: true });
});

async function captureSegment(name, turn) {
  const path = `${runDir}/${name}.jsonl`;
  const fd = openSync(path, "wx", 0o600);
  process.env.OV_E2E_FD = String(fd);
  process.env.OV_E2E_TURN = String(turn);
  try {
    const handlers = new Map();
    probe({ on(event, handler) { handlers.set(event, handler); } });
    const context = { sessionManager: { getSessionId: () => "session-probe-test" } };
    await handlers.get("session_start")({}, context);
    await handlers.get("before_agent_start")({}, context);
    await handlers.get("before_provider_request")({ payload: { model: "probe", turn } }, {});
  } finally {
    closeSync(fd);
    delete process.env.OV_E2E_FD;
    delete process.env.OV_E2E_TURN;
  }
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
}

test("e2e probe writes path-free private JSONL across independent segments", async () => {
  const first = await captureSegment("segment-0", 0);
  const second = await captureSegment("segment-1", 1);

  assert.deepEqual(first.map((record) => record.kind), ["session", "providerPayload"]);
  assert.equal(first[1].payload.turn, 0);
  assert.equal(second[1].payload.turn, 1);
});

test("e2e probe rejects non-private artifact descriptors and invalid turns", () => {
  const path = `${runDir}/invalid.jsonl`;
  const fd = openSync(path, "wx", 0o600);
  try {
    chmodSync(path, 0o644);
    process.env.OV_E2E_FD = String(fd);
    assert.throws(() => probe({ on() {} }), /private/);

    chmodSync(path, 0o600);
    process.env.OV_E2E_TURN = "../../escape";
    assert.throws(() => probe({ on() {} }), /non-negative decimal integer/);
  } finally {
    closeSync(fd);
    delete process.env.OV_E2E_FD;
    delete process.env.OV_E2E_TURN;
  }
});
