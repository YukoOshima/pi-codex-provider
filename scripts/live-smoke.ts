import { randomUUID } from "node:crypto";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  API_ID,
  PROVIDER_ID,
  requestRemoteCompaction,
  streamCodexWithApiKey,
} from "../src/index.js";
import type { JsonObject } from "../src/checkpoint-store.js";

const MAX_API_KEY_BYTES = 16 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
let secretForRedaction = "";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readApiKey(): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let value = "";
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_API_KEY_BYTES) {
      throw new Error(`API key input exceeded ${MAX_API_KEY_BYTES} bytes`);
    }
    value += decoder.decode(bytes, { stream: true });
  }
  value += decoder.decode();
  const apiKey = value.trim();
  if (!apiKey) throw new Error("API key stdin is empty");
  return apiKey;
}

function createModel(baseUrl: string, id: string): Model<Api> {
  return {
    id,
    name: "Live smoke model",
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

async function main(): Promise<void> {
  const [apiKey, baseUrl, modelId] = await Promise.all([
    readApiKey(),
    Promise.resolve(requiredEnvironment("PI_CODEX_LIVE_BASE_URL")),
    Promise.resolve(requiredEnvironment("PI_CODEX_LIVE_MODEL")),
  ]);
  secretForRedaction = apiKey;
  const model = createModel(baseUrl, modelId);
  const sentinel = `PI_CODEX_WSS_${randomUUID()}`;
  const context: Context = {
    systemPrompt: `Return exactly ${sentinel} and nothing else.`,
    messages: [{ role: "user", content: sentinel, timestamp: Date.now() }],
  };
  const signal = AbortSignal.timeout(120_000);
  let answer = "";
  let completed = false;

  for await (const event of streamCodexWithApiKey(model, context, {
    apiKey,
    transport: "websocket",
    signal,
    websocketConnectTimeoutMs: 15_000,
    timeoutMs: 60_000,
  })) {
    if (event.type === "text_delta") {
      answer += event.delta;
      if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) {
        throw new Error(`Live answer exceeded ${MAX_ANSWER_BYTES} bytes`);
      }
    } else if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "WebSocket provider returned an error");
    } else if (event.type === "done") {
      completed = true;
    }
  }
  if (!completed || answer.trim() !== sentinel) {
    throw new Error("WebSocket response did not complete with the exact sentinel");
  }

  const compactInput = [
    {
      role: "user",
      content: [{ type: "input_text", text: `Retain this checkpoint: ${sentinel}` }],
    },
  ] satisfies JsonObject[];
  const checkpoint = await requestRemoteCompaction({
    model,
    input: compactInput,
    apiKey,
    instructions: "Preserve the supplied checkpoint faithfully.",
    sessionId: `live-smoke-${randomUUID()}`,
    signal,
  });

  process.stdout.write(`${JSON.stringify({
    websocket: {
      endpoint: "/responses",
      completed: true,
      exactSentinel: true,
    },
    remoteCompaction: {
      endpoint: "/responses/compact",
      validCheckpoint: true,
      outputItems: checkpoint.output.length,
    },
  }, null, 2)}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = secretForRedaction ? message.replaceAll(secretForRedaction, "[REDACTED]") : message;
  process.stderr.write(`Live smoke failed: ${safeMessage}\n`);
  process.exitCode = 1;
});
