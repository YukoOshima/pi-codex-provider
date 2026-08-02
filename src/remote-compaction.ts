import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type Context,
  type Model,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID, REMOTE_COMPACTION_KIND } from "./constants.js";
import { normalizeBaseUrl, responsesCompactUrl } from "./base-url.js";
import { buildHttpHeaders } from "./headers.js";
import {
  checkpointStore,
  findLatestRemoteCheckpoint,
  hashCompactionOutput,
  parseRemoteCompactionDetails,
  type JsonObject,
  type RemoteCompactionDetails,
} from "./checkpoint-store.js";
import { loadPiAiResponsesRuntime } from "./pi-ai-responses-runtime.js";

const MAX_COMPACTION_RESPONSE_BYTES = 32 * 1024 * 1024;
const COMPACTION_TIMEOUT_MS = 60_000;

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactionRequestBody(options: {
  model: string;
  input: readonly JsonObject[];
  instructions: string;
  promptCacheKey: string;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = -1;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === -1) {
        index = 0;
        controller.enqueue(encoder.encode(`{"model":${JSON.stringify(options.model)},"input":[`));
        return;
      }
      if (index < options.input.length) {
        const separator = index === 0 ? "" : ",";
        controller.enqueue(encoder.encode(`${separator}${JSON.stringify(options.input[index])}`));
        index += 1;
        return;
      }
      controller.enqueue(encoder.encode(
        `],"instructions":${JSON.stringify(options.instructions)},"prompt_cache_key":${JSON.stringify(options.promptCacheKey)}}`,
      ));
      controller.close();
    },
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Remote compaction response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_COMPACTION_RESPONSE_BYTES) {
        throw new Error(`Remote compaction response exceeded ${MAX_COMPACTION_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original protocol/read failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validateCompactionResponse(
  value: unknown,
  provider: string,
  model: string,
): RemoteCompactionDetails {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || !Array.isArray(value.output)) {
    throw new Error("Remote compaction response must contain a non-empty id and output array");
  }
  if (value.output.length === 0 || !value.output.every(isObject)) {
    throw new Error("Remote compaction output must contain JSON objects");
  }

  const summaries = value.output.filter((item) => item.type === "compaction_summary" || item.type === "compaction");
  if (summaries.length !== 1) {
    throw new Error(`Remote compaction output must contain exactly one compaction item, received ${summaries.length}`);
  }
  const summary = summaries[0];
  if (!summary || typeof summary.encrypted_content !== "string" || !summary.encrypted_content) {
    throw new Error("Remote compaction item must contain encrypted_content");
  }

  const output = value.output as JsonObject[];
  const marker = `[pi-codex-provider remote-compaction ${value.id} ${randomUUID()}]`;
  return {
    kind: REMOTE_COMPACTION_KIND,
    version: 1,
    provider,
    model,
    responseId: value.id,
    marker,
    output,
    outputHash: hashCompactionOutput(output),
  };
}

function compactableMessages(event: SessionBeforeCompactEvent) {
  return convertToLlm([
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ]).filter((message) => {
    return message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted");
  });
}

async function buildCompactInput(
  model: Model<Api>,
  event: SessionBeforeCompactEvent,
  previous: RemoteCompactionDetails | undefined,
): Promise<JsonObject[]> {
  const { convertResponsesMessages } = await loadPiAiResponsesRuntime();
  const messages = compactableMessages(event);
  const converted = convertResponsesMessages(
    model,
    { messages } satisfies Context,
    new Set(["openai", "openai-codex", "opencode", model.provider]),
    { includeSystemPrompt: false },
  ) as unknown as JsonObject[];
  return [...(previous?.output ?? []), ...converted];
}

export async function requestRemoteCompaction(options: {
  model: Model<Api>;
  input: JsonObject[];
  apiKey: string;
  headers?: ProviderHeaders;
  instructions: string;
  sessionId: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<RemoteCompactionDetails> {
  if (options.input.length === 0) throw new Error("Remote compaction input is empty");
  const baseUrl = normalizeBaseUrl(options.model.baseUrl);
  const timeoutSignal = AbortSignal.timeout(COMPACTION_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeoutSignal]);
  const requestInit: StreamingRequestInit = {
    method: "POST",
    headers: buildHttpHeaders(options.apiKey, options.headers),
    body: compactionRequestBody({
      model: options.model.id,
      input: options.input,
      instructions: options.instructions,
      promptCacheKey: options.sessionId,
    }),
    signal,
    duplex: "half",
  };
  const response = await (options.fetch ?? globalThis.fetch)(responsesCompactUrl(baseUrl), requestInit);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Remote compaction failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    await response.body?.cancel();
    throw new Error(`Remote compaction returned unsupported content type: ${contentType || "missing"}`);
  }
  return validateCompactionResponse(await readBoundedJson(response), options.model.provider, options.model.id);
}

function loadCheckpoint(ctx: ExtensionContext): RemoteCompactionDetails | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  checkpointStore.delete(sessionId);
  try {
    const details = findLatestRemoteCheckpoint(ctx.sessionManager.getBranch());
    if (details) checkpointStore.set(sessionId, details, false);
    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checkpointStore.block(sessionId, message);
    throw error;
  }
}

function messageSummary(value: unknown): string | undefined {
  return isObject(value) && value.role === "compactionSummary" && typeof value.summary === "string"
    ? value.summary
    : undefined;
}

export function registerRemoteCompaction(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    loadCheckpoint(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    loadCheckpoint(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    checkpointStore.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    checkpointStore.delete(sessionId);
    try {
      const details = parseRemoteCompactionDetails(event.compactionEntry.details);
      if (details) checkpointStore.set(sessionId, details, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checkpointStore.block(sessionId, message);
      throw error;
    }
  });

  pi.on("context", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const details = loadCheckpoint(ctx);
    if (!details) return;
    if (
      model.provider !== details.provider
      || model.id !== details.model
      || model.api !== API_ID
    ) {
      checkpointStore.markProjected(sessionId, false);
      ctx.ui.notify("Active remote compaction checkpoint belongs to a different provider or model", "error");
      ctx.abort();
      return;
    }
    const markerIndex = event.messages.findIndex((message) => messageSummary(message) === details.marker);
    if (markerIndex < 0) {
      checkpointStore.markProjected(sessionId, false);
      return;
    }
    checkpointStore.markProjected(sessionId, true);
    return { messages: event.messages.slice(markerIndex + 1) };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    try {
      const previous = findLatestRemoteCheckpoint(event.branchEntries);
      if (previous && (
        !model
        || previous.provider !== model.provider
        || previous.model !== model.id
        || model.api !== API_ID
      )) {
        throw new Error("Remote compaction checkpoint belongs to a different provider or model");
      }
      if (!model || model.provider !== PROVIDER_ID || model.api !== API_ID) return;
      if (event.customInstructions?.trim()) {
        throw new Error("Remote compaction does not support custom summary instructions");
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? "Remote compaction API key is missing" : auth.error);
      }
      const input = await buildCompactInput(model, event, previous);
      const details = await requestRemoteCompaction({
        model,
        input,
        apiKey: auth.apiKey,
        ...(auth.headers ? { headers: auth.headers } : {}),
        instructions: ctx.getSystemPrompt(),
        sessionId: ctx.sessionManager.getSessionId(),
        signal: event.signal,
      });
      return {
        compaction: {
          summary: details.marker,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Remote compaction failed: ${message}`, "error");
      return { cancel: true };
    }
  });
}
