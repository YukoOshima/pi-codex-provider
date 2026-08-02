import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCodexProvider, {
  API_ID,
  PROVIDER_ID,
  normalizeBaseUrl,
  responsesCompactUrl,
  responsesWebSocketUrl,
  streamCodexWithApiKey,
} from "../src/index.js";
import { MockCodexServer, type MockScenario } from "./helpers/mock-codex-server.js";
import { checkpointStore } from "../src/checkpoint-store.js";

const DUMMY_API_KEY = "dummy-api-key-for-local-tests";
const originalDefaultCertificateAuthorities = getCACertificates("default");
const localTestCertificate = readFileSync(
  new URL("./fixtures/localhost-cert.pem", import.meta.url),
  "utf8",
);

before(() => {
  setDefaultCACertificates([
    ...originalDefaultCertificateAuthorities,
    localTestCertificate,
  ]);
});

after(() => {
  setDefaultCACertificates(originalDefaultCertificateAuthorities);
});

function createModel(baseUrl: string): Model<Api> {
  return {
    id: "gpt-5.2-codex",
    name: "Codex contract fixture",
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

const context: Context = {
  systemPrompt: "Answer with the mock response.",
  messages: [
    {
      role: "user",
      content: "Say hello.",
      timestamp: 1_700_000_000_000,
    },
  ],
};

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function runScenario(
  scenario: MockScenario,
): Promise<{ server: MockCodexServer; events: AssistantMessageEvent[] }> {
  const server = await MockCodexServer.start(scenario);
  try {
    const events = await collectEvents(
      streamCodexWithApiKey(createModel(server.baseUrl), context, {
        apiKey: DUMMY_API_KEY,
        transport: "websocket",
        websocketConnectTimeoutMs: 1_000,
        timeoutMs: 1_000,
      }),
    );
    return { server, events };
  } catch (error) {
    await server.close();
    throw error;
  }
}

test("base URL is an HTTPS API root and derives only the two canonical Responses endpoints", () => {
  const baseUrl = "https://api.example.test/v1";
  assert.equal(normalizeBaseUrl("  https://api.example.test/v1/  "), baseUrl);
  assert.equal(responsesWebSocketUrl(baseUrl), "wss://api.example.test/v1/responses");
  assert.equal(responsesCompactUrl(baseUrl), "https://api.example.test/v1/responses/compact");
  assert.throws(() => normalizeBaseUrl("http://api.example.test/v1"), /must use https/);
  assert.throws(() => normalizeBaseUrl("https://api.example.test"), /must end with \/v1/);
  assert.throws(() => normalizeBaseUrl("https://chatgpt.com/backend-api"), /must end with \/v1/);
  assert.throws(() => normalizeBaseUrl("https://api.example.test/v1/responses"), /API root/);
});

test("default factory registers exactly the Codex WebSocket provider", async () => {
  let registration: { provider: string; config: unknown } | undefined;
  const pi = {
    registerProvider(provider: string, config: unknown) {
      assert.equal(registration, undefined);
      registration = { provider, config };
    },
    on() {},
  } as unknown as ExtensionAPI;

  await piCodexProvider(pi);

  assert.ok(registration);
  assert.equal(registration.provider, PROVIDER_ID);
  assert.deepEqual(registration.config, {
    api: API_ID,
    streamSimple: streamCodexWithApiKey,
  });
});

test("provider requires an explicit websocket transport before any network request", async () => {
  for (const transport of [undefined, "sse", "auto", "websocket-cached"] as const) {
    const events = await collectEvents(
      streamCodexWithApiKey(createModel("https://unreachable.example.test/v1"), context, {
        apiKey: DUMMY_API_KEY,
        ...(transport === undefined ? {} : { transport }),
      }),
    );
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const error = events[0];
    assert.ok(error && error.type === "error");
    assert.match(error.error.errorMessage ?? "", /requires transport=websocket/);
  }
});

test("provider fails before network when the persisted remote checkpoint is invalid", async () => {
  const sessionId = "invalid-checkpoint-session";
  checkpointStore.block(sessionId, "checkpoint hash mismatch");
  try {
    const events = await collectEvents(
      streamCodexWithApiKey(createModel("https://unreachable.example.test/v1"), context, {
        apiKey: DUMMY_API_KEY,
        transport: "websocket",
        sessionId,
      }),
    );
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const error = events[0];
    assert.ok(error && error.type === "error");
    assert.match(error.error.errorMessage ?? "", /checkpoint is invalid: checkpoint hash mismatch/);
  } finally {
    checkpointStore.delete(sessionId);
  }
});

test("provider rejects deferred tool search before any network request", async () => {
  const model = {
    ...createModel("https://unreachable.example.test/v1"),
    compat: { supportsToolSearch: true },
  } as Model<Api>;
  const events = await collectEvents(
    streamCodexWithApiKey(model, context, {
      apiKey: DUMMY_API_KEY,
      transport: "websocket",
    }),
  );
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const error = events[0];
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /Deferred tool search is not supported/);
});

test("real WSS request uses /v1/responses, required headers, response.create, and emits Pi text events", async () => {
  const { server, events } = await runScenario("success");
  try {
    assert.equal(server.websocketUpgradeCount, 1);
    assert.equal(server.httpResponsesRequestCount, 0);
    assert.deepEqual(server.regularHttpRequests, []);
    assert.equal(server.observedWebSocketRequests.length, 1);

    const observed = server.observedWebSocketRequests[0];
    assert.ok(observed);
    assert.equal(observed.path, "/v1/responses");
    assert.equal(observed.headers.authorization, `Bearer ${DUMMY_API_KEY}`);
    assert.equal(observed.headers["openai-beta"], "responses_websockets=2026-02-06");

    assert.ok(observed.body && typeof observed.body === "object" && !Array.isArray(observed.body));
    const body = observed.body as Record<string, unknown>;
    assert.equal(body.type, "response.create");
    assert.equal(body.model, "gpt-5.2-codex");
    assert.equal(body.instructions, "Answer with the mock response.");
    assert.equal(Object.hasOwn(body, "stream"), false);
    assert.equal(Object.hasOwn(body, "background"), false);
    assert.deepEqual(body.input, [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say hello." }],
      },
    ]);

    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const textDelta = events.find((event) => event.type === "text_delta");
    assert.ok(textDelta && textDelta.type === "text_delta");
    assert.equal(textDelta.delta, "hello from mock");
    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.reason, "stop");
    assert.deepEqual(done.message.content, [
      {
        type: "text",
        text: "hello from mock",
        textSignature: '{"v":1,"id":"msg_test_1","phase":"final_answer"}',
      },
    ]);
    assert.deepEqual(done.message.usage, {
      input: 5,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  } finally {
    await server.close();
  }
});

test("WSS handshake failure fails fast without an HTTP /responses fallback", async () => {
  const { server, events } = await runScenario("handshake-failure");
  try {
    assert.equal(server.websocketUpgradeCount, 1);
    assert.equal(server.httpResponsesRequestCount, 0);
    assert.deepEqual(server.regularHttpRequests, []);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const error = events[0];
    assert.ok(error && error.type === "error");
    assert.match(error.error.errorMessage ?? "", /socket|hang up|closed|ECONNRESET/i);
  } finally {
    await server.close();
  }
});

test("HTTP upgrade rejection fails fast without an HTTP /responses fallback", async () => {
  const { server, events } = await runScenario("upgrade-rejected");
  try {
    assert.equal(server.websocketUpgradeCount, 1);
    assert.equal(server.httpResponsesRequestCount, 0);
    assert.deepEqual(server.regularHttpRequests, []);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const error = events[0];
    assert.ok(error && error.type === "error");
    assert.match(error.error.errorMessage ?? "", /handshake failed with HTTP 503/i);
  } finally {
    await server.close();
  }
});

test("WSS close before a terminal event fails fast without an HTTP /responses fallback", async () => {
  const { server, events } = await runScenario("early-close");
  try {
    assert.equal(server.websocketUpgradeCount, 1);
    assert.equal(server.observedWebSocketRequests.length, 1);
    assert.equal(server.httpResponsesRequestCount, 0);
    assert.deepEqual(server.regularHttpRequests, []);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const error = events[0];
    assert.ok(error && error.type === "error");
    assert.match(error.error.errorMessage ?? "", /closed before a terminal event|1011/i);
  } finally {
    await server.close();
  }
});
