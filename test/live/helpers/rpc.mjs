/** live 专用：以 RPC 模式驱动真实 Pi 的最小客户端。JSONL 帧，命令按序发送，事件按谓词等待。 */
import { spawn } from "node:child_process";

const PI_BIN = new URL("../../../node_modules/.bin/pi", import.meta.url);

export function runRpc({ args = [], env = {}, commands, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN.pathname, ["--mode", "rpc", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    const stderrChunks = [];
    let buffer = "";
    const waiters = [];

    child.on("error", (err) => reject(new Error(`spawn pi 失败: ${err.message}`)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        events.push(event);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(event)) {
            waiters[i].resolve(event);
            waiters.splice(i, 1);
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    // fromIndex：只匹配命令发出之后到达的事件，避免命中上一条命令的同名历史事件。
    const waitFor = (predicate, description, fromIndex) =>
      new Promise((res, rej) => {
        const found = events.slice(fromIndex).find(predicate);
        if (found) return res(found);
        waiters.push({ predicate, resolve: res });
        setTimeout(() => rej(new Error(`等待超时: ${description}`)), timeoutMs);
      });

    const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);

    (async () => {
      for (const step of commands) {
        // command 可以是已收事件的函数：fork/switch_session 等需要先拿到运行期值（entryId、sessionFile）。
        const command = typeof step.command === "function" ? step.command(events) : step.command;
        const fromIndex = events.length;
        send(command);
        if (step.until) await waitFor(step.until, step.description ?? JSON.stringify(command), fromIndex);
      }
    })()
      .then(() => {
        child.stdin.end();
        child.on("close", (code) =>
          resolve({ code, events, stderr: Buffer.concat(stderrChunks).toString("utf8") }),
        );
      })
      .catch((err) => {
        child.kill("SIGTERM");
        reject(err);
      });
  });
}
