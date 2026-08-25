import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { startScriptedProvider } from "./live/scripted-provider.mjs";

const ROOT = `test/.artifacts/scripted-provider-${process.pid}`;

test.after(() => rm(ROOT, { recursive: true, force: true }));

test("scripted provider 以最小 SSE 实现 completions 与 Codex zstd tool call", async () => {
  await mkdir(ROOT, { recursive: true });
  const completions = await startScriptedProvider({
    agentDir: ROOT,
    respond: () => ({ toolCall: { name: "viking_search", input: { query: "fact" } } }),
  });
  try {
    const model = JSON.parse(await readFile(`${ROOT}/models.json`, "utf8"));
    const response = await fetch(`${model.providers.scripted.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.match(await response.text(), /chat\.completion\.chunk/);
  } finally {
    await completions.close();
  }

  const codex = await startScriptedProvider({
    agentDir: ROOT,
    api: "openai-codex-responses",
    respond: (_messages, request) => ({ toolCall: { name: "viking_archive_expand", input: { offset: request } } }),
  });
  try {
    const model = JSON.parse(await readFile(`${ROOT}/models.json`, "utf8"));
    const body = zstdCompressSync(Buffer.from(JSON.stringify({ input: [] })));
    const response = await fetch(`${model.providers.scripted.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body,
    });
    const text = await response.text();
    assert.match(text, /response\.completed/);
    assert.match(text, /viking_archive_expand/);
    assert.equal(codex.requests(), 1);
  } finally {
    await codex.close();
  }
});
