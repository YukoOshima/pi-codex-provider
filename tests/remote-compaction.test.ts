import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  checkpointStore,
  findLatestRemoteCheckpoint,
  hashCompactionOutput,
  parseRemoteCompactionDetails,
  type JsonObject,
  type RemoteCompactionDetails,
} from "../src/checkpoint-store.js";
import { API_ID, PROVIDER_ID, REMOTE_COMPACTION_KIND } from "../src/constants.js";
import {
  registerRemoteCompaction,
  requestRemoteCompaction,
} from "../src/remote-compaction.js";

const DUMMY_API_KEY = "dummy-remote-compaction-key";
const BASE_URL = "https://gateway.example.test/v1";
const COMPACT_URL = `${BASE_URL}/responses/compact`;

const compactOutput = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "retained user context" }],
  },
  {
    id: "cmp_test_1",
    type: "compaction_summary",
    encrypted_content: "opaque-encrypted-checkpoint",
  },
] satisfies JsonObject[];

function createModel(): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "Remote compaction fixture",
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function validCompactionResponse(): unknown {
  return {
    id: "resp_compact_test_1",
    object: "response.compaction",
    output: structuredClone(compactOutput),
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
    },
  };
}

async function readRequestBody(body: BodyInit | null | undefined): Promise<string> {
  assert.ok(body instanceof ReadableStream);
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

test("requestRemoteCompaction sends exactly one canonical /responses/compact request", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(validCompactionResponse());
  }) as typeof globalThis.fetch;
  const input = [
    {
      role: "user",
      content: [{ type: "input_text", text: "compact this" }],
    },
  ] satisfies JsonObject[];

  const details = await requestRemoteCompaction({
    model: createModel(),
    input,
    apiKey: DUMMY_API_KEY,
    headers: { "X-Test-Trace": "remote-compaction" },
    instructions: "Preserve the useful context.",
    sessionId: "session-test-1",
    signal: new AbortController().signal,
    fetch: fakeFetch,
  });

  assert.equal(calls.length, 1, "remote compaction must not retry or fall back");
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, COMPACT_URL);
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${DUMMY_API_KEY}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-test-trace"), "remote-compaction");
  assert.equal(headers.has("openai-beta"), false);
  assert.deepEqual(JSON.parse(await readRequestBody(call.init?.body)), {
    model: "gpt-5.6-sol",
    input,
    instructions: "Preserve the useful context.",
    prompt_cache_key: "session-test-1",
  });
  assert.deepEqual(details.output, compactOutput);
  assert.equal(details.responseId, "resp_compact_test_1");
  assert.equal(details.outputHash, hashCompactionOutput(compactOutput));
  assert.match(
    details.marker,
    /^\[pi-codex-provider remote-compaction resp_compact_test_1 [0-9a-f-]{36}\]$/,
  );
});

test("requestRemoteCompaction fails fast on HTTP errors without another endpoint or attempt", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse({ error: "upstream failed" }, 503);
  }) as typeof globalThis.fetch;

  await assert.rejects(
    requestRemoteCompaction({
      model: createModel(),
      input: [{ role: "user", content: "context" }],
      apiKey: DUMMY_API_KEY,
      instructions: "Compact.",
      sessionId: "session-http-error",
      signal: new AbortController().signal,
      fetch: fakeFetch,
    }),
    /Remote compaction failed with HTTP 503/,
  );
  assert.deepEqual(urls, [COMPACT_URL]);
});

test("requestRemoteCompaction rejects malformed 200 responses without retrying", async (t) => {
  const cases: Array<{ name: string; body: unknown; pattern: RegExp }> = [
    {
      name: "missing response id",
      body: { output: compactOutput },
      pattern: /non-empty id and output array/,
    },
    {
      name: "empty output",
      body: { id: "resp_empty", output: [] },
      pattern: /must contain JSON objects/,
    },
    {
      name: "missing compaction item",
      body: { id: "resp_no_summary", output: [{ type: "message", role: "user" }] },
      pattern: /exactly one compaction item, received 0/,
    },
    {
      name: "multiple compaction items",
      body: {
        id: "resp_two_summaries",
        output: [
          { type: "compaction_summary", encrypted_content: "one" },
          { type: "compaction", encrypted_content: "two" },
        ],
      },
      pattern: /exactly one compaction item, received 2/,
    },
    {
      name: "missing encrypted content",
      body: { id: "resp_no_ciphertext", output: [{ type: "compaction_summary" }] },
      pattern: /must contain encrypted_content/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let callCount = 0;
      const fakeFetch = (async () => {
        callCount += 1;
        return jsonResponse(fixture.body);
      }) as typeof globalThis.fetch;
      await assert.rejects(
        requestRemoteCompaction({
          model: createModel(),
          input: [{ role: "user", content: "context" }],
          apiKey: DUMMY_API_KEY,
          instructions: "Compact.",
          sessionId: "session-invalid-shape",
          signal: new AbortController().signal,
          fetch: fakeFetch,
        }),
        fixture.pattern,
      );
      assert.equal(callCount, 1);
    });
  }
});

test("requestRemoteCompaction rejects invalid JSON with one request", async () => {
  let callCount = 0;
  const fakeFetch = (async () => {
    callCount += 1;
    return new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  await assert.rejects(
    requestRemoteCompaction({
      model: createModel(),
      input: [{ role: "user", content: "context" }],
      apiKey: DUMMY_API_KEY,
      instructions: "Compact.",
      sessionId: "session-invalid-json",
      signal: new AbortController().signal,
      fetch: fakeFetch,
    }),
    SyntaxError,
  );
  assert.equal(callCount, 1);
});

test("parseRemoteCompactionDetails verifies the persisted output hash and detects tampering", () => {
  const details: RemoteCompactionDetails = {
    kind: REMOTE_COMPACTION_KIND,
    version: 1,
    provider: PROVIDER_ID,
    model: "gpt-5.6-sol",
    responseId: "resp_compact_hash",
    marker: "[pi-codex-provider remote-compaction resp_compact_hash fixture]",
    output: structuredClone(compactOutput),
    outputHash: hashCompactionOutput(compactOutput),
  };

  assert.deepEqual(parseRemoteCompactionDetails(structuredClone(details)), details);
  assert.equal(parseRemoteCompactionDetails({ kind: "another-extension" }), undefined);

  const tampered = structuredClone(details);
  const compactionItem = tampered.output[1];
  assert.ok(compactionItem);
  compactionItem.encrypted_content = "tampered-ciphertext";
  assert.throws(() => parseRemoteCompactionDetails(tampered), /checkpoint hash mismatch/);

  const forgedHash = { ...structuredClone(details), outputHash: "0".repeat(64) };
  assert.throws(() => parseRemoteCompactionDetails(forgedHash), /checkpoint hash mismatch/);
});

test("a newer non-extension compaction prevents stale remote checkpoint reuse", () => {
  const details: RemoteCompactionDetails = {
    kind: REMOTE_COMPACTION_KIND,
    version: 1,
    provider: PROVIDER_ID,
    model: "gpt-5.6-sol",
    responseId: "resp_old_remote",
    marker: "[pi-codex-provider remote-compaction old fixture]",
    output: structuredClone(compactOutput),
    outputHash: hashCompactionOutput(compactOutput),
  };
  const oldRemote = {
    type: "compaction",
    id: "entry-old-remote",
    parentId: "entry-before-old",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    summary: details.marker,
    firstKeptEntryId: "entry-kept-old",
    tokensBefore: 10_000,
    details,
    fromHook: true,
  } satisfies SessionEntry;
  const newerLocal = {
    type: "compaction",
    id: "entry-new-local",
    parentId: oldRemote.id,
    timestamp: new Date(1_700_000_001_000).toISOString(),
    summary: "plain local summary",
    firstKeptEntryId: "entry-kept-new",
    tokensBefore: 20_000,
  } satisfies SessionEntry;

  assert.equal(findLatestRemoteCheckpoint([oldRemote, newerLocal]), undefined);
});

test("invalid persisted extension details poison the session checkpoint", async () => {
  checkpointStore.clear();
  const { pi, hooks } = captureExtensionHooks();
  registerRemoteCompaction(pi);
  const sessionStart = onlyHook(hooks, "session_start");
  const sessionId = "session-invalid-persisted-checkpoint";
  const invalidEntry = {
    type: "compaction",
    id: "entry-invalid-checkpoint",
    parentId: "entry-before-invalid",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    summary: "invalid remote marker",
    firstKeptEntryId: "entry-kept-invalid",
    tokensBefore: 10_000,
    details: {
      kind: REMOTE_COMPACTION_KIND,
      version: 1,
      provider: PROVIDER_ID,
      model: "gpt-5.6-sol",
      responseId: "resp_invalid",
      marker: "[pi-codex-provider invalid]",
      output: structuredClone(compactOutput),
      outputHash: "0".repeat(64),
    },
    fromHook: true,
  } satisfies SessionEntry;
  const context = {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [invalidEntry],
    },
  } as unknown as ExtensionContext;

  try {
    assert.throws(
      () => sessionStart({ type: "session_start", reason: "resume" }, context),
      /checkpoint hash mismatch/,
    );
    assert.match(checkpointStore.getFailure(sessionId) ?? "", /checkpoint hash mismatch/);
    assert.equal(checkpointStore.get(sessionId), undefined);
  } finally {
    checkpointStore.clear();
  }
});

type CapturedHook = (event: any, context: ExtensionContext) => unknown | Promise<unknown>;

function captureExtensionHooks(): {
  pi: ExtensionAPI;
  hooks: Map<string, CapturedHook[]>;
} {
  const hooks = new Map<string, CapturedHook[]>();
  const pi = {
    on(event: string, handler: CapturedHook) {
      const registered = hooks.get(event) ?? [];
      registered.push(handler);
      hooks.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  return { pi, hooks };
}

function onlyHook(hooks: Map<string, CapturedHook[]>, event: string): CapturedHook {
  const registered = hooks.get(event);
  assert.ok(registered);
  assert.equal(registered.length, 1);
  const handler = registered[0];
  assert.ok(handler);
  return handler;
}

test("extension compaction hook cancels on failure and persists/project markers on success", async () => {
  checkpointStore.clear();
  const { pi, hooks } = captureExtensionHooks();
  registerRemoteCompaction(pi);
  const beforeCompact = onlyHook(hooks, "session_before_compact");
  const sessionCompact = onlyHook(hooks, "session_compact");
  const contextHook = onlyHook(hooks, "context");
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let branchEntries: SessionEntry[] = [];
  const context = {
    model: createModel(),
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: DUMMY_API_KEY };
      },
    },
    sessionManager: {
      getSessionId: () => "session-extension-hook",
      getBranch: () => branchEntries,
    },
    getSystemPrompt: () => "System prompt for compact endpoint.",
  } as unknown as ExtensionContext;
  const event = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-keep-1",
      messagesToSummarize: [
        { role: "user", content: "old context", timestamp: 1_700_000_000_000 },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 42_000,
      fileOps: { read: new Set(), written: new Set() },
      settings: { enabled: true, reserveTokens: 32_768, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse({ error: "unavailable" }, 503);
    }) as typeof globalThis.fetch;
    const cancelled = await beforeCompact(event, context);
    assert.deepEqual(cancelled, { cancel: true });
    assert.equal(fetchCalls, 1);
    assert.match(notifications.at(-1)?.message ?? "", /Remote compaction failed:.*HTTP 503/);

    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      assert.equal(String(input), COMPACT_URL);
      return jsonResponse(validCompactionResponse());
    }) as typeof globalThis.fetch;
    const succeeded = await beforeCompact(event, context) as {
      compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details: RemoteCompactionDetails;
      };
    };
    assert.equal(fetchCalls, 2);
    assert.equal(succeeded.compaction.firstKeptEntryId, "entry-keep-1");
    assert.equal(succeeded.compaction.tokensBefore, 42_000);
    assert.equal(succeeded.compaction.summary, succeeded.compaction.details.marker);
    assert.deepEqual(succeeded.compaction.details.output, compactOutput);

    const mismatchedDetails = { ...structuredClone(succeeded.compaction.details), model: "another-model" };
    const mismatchedEntry = {
      type: "compaction",
      id: "entry-mismatched-model",
      parentId: "entry-before-mismatch",
      timestamp: new Date(1_700_000_000_000).toISOString(),
      summary: mismatchedDetails.marker,
      firstKeptEntryId: "entry-keep-mismatch",
      tokensBefore: 40_000,
      details: mismatchedDetails,
      fromHook: true,
    } satisfies SessionEntry;
    const fetchCallsBeforeMismatch = fetchCalls;
    const mismatchCancelled = await beforeCompact({ ...event, branchEntries: [mismatchedEntry] }, context);
    assert.deepEqual(mismatchCancelled, { cancel: true });
    assert.equal(fetchCalls, fetchCallsBeforeMismatch);
    assert.match(notifications.at(-1)?.message ?? "", /different provider or model/);

    const compactionEntry = {
      type: "compaction",
      id: "entry-compaction-1",
      parentId: "entry-before-compaction",
      timestamp: new Date(1_700_000_000_000).toISOString(),
      summary: succeeded.compaction.summary,
      firstKeptEntryId: succeeded.compaction.firstKeptEntryId,
      tokensBefore: succeeded.compaction.tokensBefore,
      details: succeeded.compaction.details,
      fromHook: true,
    } satisfies SessionEntry;
    branchEntries = [compactionEntry];
    await sessionCompact({
      type: "session_compact",
      compactionEntry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, context);

    const newMessage = { role: "user", content: "new work", timestamp: 1_700_000_001_000 };
    const keptSuffix = { role: "user", content: "kept suffix", timestamp: 1_700_000_000_500 };
    const projected = await contextHook({
      type: "context",
      messages: [
        {
          role: "compactionSummary",
          summary: succeeded.compaction.details.marker,
          tokensBefore: 42_000,
          timestamp: 1_700_000_000_750,
        },
        keptSuffix,
        newMessage,
      ],
    }, context) as { messages: unknown[] };
    assert.deepEqual(projected, { messages: [keptSuffix, newMessage] });

    let abortCalls = 0;
    const mismatchedContext = {
      ...context,
      model: { ...createModel(), provider: "another-provider", api: "anthropic-messages" },
      abort() {
        abortCalls += 1;
      },
    } as unknown as ExtensionContext;
    const mismatchProjection = await contextHook({
      type: "context",
      messages: [
        {
          role: "compactionSummary",
          summary: succeeded.compaction.details.marker,
          tokensBefore: 42_000,
          timestamp: 1_700_000_000_750,
        },
        keptSuffix,
      ],
    }, mismatchedContext);
    assert.equal(mismatchProjection, undefined);
    assert.equal(abortCalls, 1);
    assert.match(notifications.at(-1)?.message ?? "", /different provider or model/);
  } finally {
    globalThis.fetch = originalFetch;
    checkpointStore.clear();
  }
});
