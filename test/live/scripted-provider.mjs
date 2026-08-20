// test/live/scripted-provider.mjs — 需要确定性模型行为的 live workload 的进程内脚本化 provider。
//
// 职责：以 OpenAI completions SSE 方言按固定脚本响应 chat 请求，把"模型选择工具"这一
// 不受控变量从真实边界 gate 中移除；Pi agent loop、tool_call hook、观察与同步链路保持真实。
// 只响应脚本内容，不持有凭证：models.json 使用占位 apiKey。
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL = "scripted";

// loopback provider 不经 HTTP 代理：live 子进程环境透传进程代理变量，127.0.0.1 请求会被截获。
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

function sseFrame(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function completionChunks(output) {
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: SCRIPTED_MODEL };
  if (output?.toolCall) {
    return [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "call_scripted_1", type: "function",
          function: { name: output.toolCall.name, arguments: JSON.stringify(output.toolCall.input) } },
      ] } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
  }
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: String(output?.text ?? "") } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

/**
 * 启动脚本化 provider 并把其身份写入 agentDir/models.json。
 * respond(messages) 返回 { toolCall: { name, input } } 或 { text }。
 * 返回 { runOverrides, requests, close }；runOverrides 直接展开进 runPi 选项。
 */
export async function startScriptedProvider({ agentDir, respond }) {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      requests++;
      let output;
      try {
        output = respond(JSON.parse(body || "{}").messages ?? []);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" }).end(`scripted provider: ${error?.message || error}`);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(sseFrame(completionChunks(output)));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [SCRIPTED_PROVIDER]: {
        baseUrl,
        api: "openai-completions",
        apiKey: "scripted",
        models: [{ id: SCRIPTED_MODEL }],
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    runOverrides: {
      provider: { provider: SCRIPTED_PROVIDER, model: SCRIPTED_MODEL },
      envStrip: PROXY_KEYS,
      extraEnv: { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    },
    requests: () => requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}
