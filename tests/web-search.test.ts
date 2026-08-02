import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_ID, PROVIDER_ID } from "../src/constants.js";
import {
  registerWebSearchTool,
  WEB_SEARCH_MODEL_ID,
} from "../src/web-search/index.js";

interface WebSearchParams {
  query: string;
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
}

interface CapturedTool {
  name: string;
  execute(
    callId: string,
    params: WebSearchParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  }>;
}

function lunaModel(): Model<Api> {
  return {
    id: WEB_SEARCH_MODEL_ID,
    name: "Luna web search fixture",
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "https://api.example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 372_000,
    maxTokens: 128_000,
  };
}

function sseResponse(events: unknown[]): Response {
  const encoded = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  const split = Math.max(1, Math.floor(encoded.byteLength / 3));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(encoded.byteLength, offset + split);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function captureTool(fetchImpl: typeof fetch): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(tool: CapturedTool) {
      assert.equal(captured, undefined);
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  registerWebSearchTool(pi, fetchImpl);
  assert.ok(captured);
  return captured;
}

test("web_search resolves codex-cli/gpt-5.6-luna from ModelRegistry and streams bounded SSE", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return sseResponse([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "web_search_call",
              action: {
                sources: [
                  { title: "Primary source", url: "https://example.test/article?utm_source=openai" },
                ],
              },
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Luna answer",
                  annotations: [
                    { type: "url_citation", title: "Primary source", url: "https://example.test/article" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
  };
  const tool = captureTool(fetchImpl);
  const model = lunaModel();
  const registryCalls: string[] = [];
  const context = {
    modelRegistry: {
      find(provider: string, modelId: string) {
        registryCalls.push(`find:${provider}/${modelId}`);
        return provider === PROVIDER_ID && modelId === WEB_SEARCH_MODEL_ID ? model : undefined;
      },
      async getApiKeyAndHeaders(resolvedModel: Model<Api>) {
        registryCalls.push(`auth:${resolvedModel.provider}/${resolvedModel.id}`);
        return { ok: true as const, apiKey: "test-api-key", headers: { "X-Gateway-Test": "yes" } };
      },
    },
  };

  const result = await tool.execute(
    "call-1",
    {
      query: " latest protocol update ",
      numResults: 5,
      recencyFilter: "week",
      domainFilter: ["example.test", "-blocked.test"],
    },
    undefined,
    undefined,
    context,
  );

  assert.equal(tool.name, "web_search");
  assert.deepEqual(registryCalls, [
    "find:codex-cli/gpt-5.6-luna",
    "auth:codex-cli/gpt-5.6-luna",
  ]);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://api.example.test/v1/responses");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-api-key");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-gateway-test"), "yes");
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.tools, [
    {
      type: "web_search",
      filters: {
        allowed_domains: ["example.test"],
        blocked_domains: ["blocked.test"],
      },
    },
  ]);
  assert.deepEqual(result.details, {
    provider: "codex-cli",
    model: "gpt-5.6-luna",
    sourceCount: 1,
  });
  assert.equal(
    result.content[0]?.text,
    "Luna answer\n\n## Sources\n- [Primary source](<https://example.test/article>)",
  );
});

test("web_search fails before fetch when the configured Luna model is unavailable", async () => {
  let fetchCalled = false;
  const tool = captureTool(async () => {
    fetchCalled = true;
    throw new Error("fetch must not run");
  });
  const context = {
    modelRegistry: {
      find() {
        return undefined;
      },
    },
  };

  await assert.rejects(
    tool.execute("call-2", { query: "query" }, undefined, undefined, context),
    /codex-cli\/gpt-5\.6-luna is unavailable/,
  );
  assert.equal(fetchCalled, false);
});

test("web_search rejects an auth-header override before fetch", async () => {
  let fetchCalled = false;
  const tool = captureTool(async () => {
    fetchCalled = true;
    throw new Error("fetch must not run");
  });
  const model = lunaModel();
  const context = {
    modelRegistry: {
      find() {
        return model;
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "test-api-key", headers: { Authorization: "unexpected" } };
      },
    },
  };

  await assert.rejects(
    tool.execute("call-3", { query: "query" }, undefined, undefined, context),
    /must not override Authorization/,
  );
  assert.equal(fetchCalled, false);
});
