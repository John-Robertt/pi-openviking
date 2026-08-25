// test/live/scripted-provider.mjs — 需要确定性模型行为的 live workload 的进程内脚本化 provider。
//
// 职责：按固定脚本响应 Pi 当前使用的 OpenAI SSE 方言，把“模型选择工具”这一不受控变量
// 从真实边界 gate 中移除；Pi agent loop、tool_call hook、观察与同步链路保持真实。
// 只响应脚本内容，不持有真实凭证：models.json 使用本地占位身份。
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL = "scripted";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

function completionBody(output) {
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: SCRIPTED_MODEL };
  const chunks = output?.toolCall ? [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
      { index: 0, id: "call_scripted_1", type: "function",
        function: { name: output.toolCall.name, arguments: JSON.stringify(output.toolCall.input) } },
    ] } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ] : [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: String(output?.text ?? "") } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function codexBody(output, responseId) {
  const item = output?.toolCall ? {
    type: "function_call",
    id: `fc_${responseId}`,
    call_id: `call_${responseId}`,
    name: output.toolCall.name,
    arguments: JSON.stringify(output.toolCall.input),
  } : {
    type: "message",
    id: `msg_${responseId}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: String(output?.text ?? ""), annotations: [] }],
  };
  const response = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * 启动脚本化 provider 并把其身份写入 agentDir/models.json。
 * respond(messages, requestNumber) 返回 { toolCall: { name, input } } 或 { text }。
 */
export async function startScriptedProvider({
  agentDir,
  respond,
  api = "openai-completions",
  model = {},
}) {
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (data) => { chunks.push(data); });
    req.on("end", () => {
      requests++;
      try {
        const encoded = Buffer.concat(chunks);
        const body = req.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(encoded).toString("utf8")
          : encoded.toString("utf8");
        const parsed = JSON.parse(body || "{}");
        const output = respond(parsed.messages ?? parsed.input ?? [], requests);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(api === "openai-codex-responses"
          ? codexBody(output, `resp_scripted_${requests}`)
          : completionBody(output));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" }).end(`scripted provider: ${error?.message || error}`);
      }
    });
  });
  // Codex transport may optimistically attempt WebSocket; closing it lets Pi use its SSE fallback.
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const apiKey = api === "openai-codex-responses"
    ? `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "scripted" },
      })).toString("base64url")}.signature`
    : "scripted";
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [SCRIPTED_PROVIDER]: {
        baseUrl,
        api,
        apiKey,
        models: [{ id: SCRIPTED_MODEL, ...model }],
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
