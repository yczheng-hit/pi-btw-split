// Live-test-only provider: streams deterministic text locally. Never contacts a network model.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendFileSync } from "node:fs";

let calls = 0;
// BTW_FAKE_WINDOW: context window to simulate (and realistic input usage, so Pi's threshold
// compaction reacts as with a real provider). BTW_FAKE_LOG: JSONL of every request.
const fakeWindow = Number(process.env.BTW_FAKE_WINDOW ?? 1000000);
const realisticUsage = process.env.BTW_FAKE_WINDOW !== undefined;
export default function (pi: ExtensionAPI) {
  pi.registerProvider("btw-live-fake", {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "offline-fixture",
    api: "btw-live-fake-api" as never,
    models: [{ id: "fixture", name: "BTW live fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: fakeWindow, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = (context.messages ?? []).filter((message: any) => message.role === "user");
      const last = JSON.stringify(users.at(-1)?.content ?? "");
      const slow = last.includes("SLOW_MAIN");
      // STEER_ replies take ~2s so consecutive interjections overlap a running turn.
      const steer = last.includes("STEER_");
      const answer = slow ? "MAIN_SLOW_DONE" : `FAKE_REPLY_${++calls} 中文回复`;
      const chars = JSON.stringify(context.messages ?? []).length + (context.systemPrompt ?? "").length;
      const input = realisticUsage ? Math.ceil(chars / 4) : 1;
      if (process.env.BTW_FAKE_LOG) {
        appendFileSync(process.env.BTW_FAKE_LOG, JSON.stringify({
          at: Date.now(), chars, estTokens: Math.ceil(chars / 4),
          // Pi 1.2 carries the system prompt as a leading system message; match only that, not history.
          summarization: [context.systemPrompt ?? "", ...(context.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => JSON.stringify(m.content ?? ""))]
            .some((text) => text.includes("You are a context summarization assistant")),
          excerpt: JSON.stringify(users[0]?.content ?? "").includes("<main-session-excerpt"),
          probe: last.includes("CONTEXT_PROBE"),
          messages: (context.messages ?? []).length,
          systemHead: (context.systemPrompt ?? "").slice(0, 48),
          lastUserHead: last.slice(0, 48),
        }) + "\n");
      }
      const output: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      (async () => {
        await options?.onPayload?.({ fake: true }, model);
        stream.push({ type: "start", partial: output });
        let index = 0;
        if (process.env.BTW_FAKE_THINKING === "1") {
          // Mimic reasoning providers: an (often empty/encrypted) thinking block before text.
          output.content.push({ type: "thinking", thinking: "", thinkingSignature: "sig" });
          stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
          await new Promise((resolve) => setTimeout(resolve, 30));
          stream.push({ type: "thinking_end", contentIndex: 0, content: "", partial: output });
          index = 1;
        }
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: index, partial: output });
        for (const delta of answer.match(/.{1,4}/gu) ?? []) {
          await new Promise((resolve) => setTimeout(resolve, slow ? Number(process.env.BTW_FAKE_SLOW_MS ?? 4000) : steer ? 400 : 15));
          output.content[index].text += delta;
          stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
        }
        stream.push({ type: "text_end", contentIndex: index, content: output.content[index].text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
