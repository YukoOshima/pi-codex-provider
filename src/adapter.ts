import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { API_ID } from "./constants.js";
import { normalizeBaseUrl } from "./base-url.js";
import { buildWebSocketHeaders } from "./headers.js";
import { checkpointStore, hashCompactionOutput } from "./checkpoint-store.js";
import {
  responseWebSocketEvents,
  type ResponseClientEvent,
  type ResponseServerEvent,
} from "./ws-stream.js";
import { loadPiAiResponsesRuntime } from "./pi-ai-responses-runtime.js";

interface CodexStreamOptions extends SimpleStreamOptions {
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: "auto" | "default" | "flex" | "scale" | "priority";
  textVerbosity?: "low" | "medium" | "high";
  toolChoice?: "auto" | "none" | "required";
}

type RequestBody = Omit<ResponseClientEvent, "type">;
type OpenAICompat = {
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsToolSearch?: boolean;
};

function containsMarker(context: Context, marker: string): boolean {
  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string" && message.content.includes(marker)) return true;
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === "text" && item.text.includes(marker)) return true;
        }
      }
    }
  }
  return false;
}

function assertCheckpointPrefix(
  body: RequestBody,
  sessionId: string | undefined,
  model: Model<Api>,
): void {
  const state = checkpointStore.get(sessionId);
  if (!state) return;
  if (
    state.details.provider !== model.provider
    || state.details.model !== model.id
    || body.model !== state.details.model
  ) {
    throw new Error("Remote compaction checkpoint belongs to a different provider or model");
  }
  if (!state.projected) {
    throw new Error("Remote compaction checkpoint was not projected into the active Pi context");
  }
  if (!Array.isArray(body.input) || body.input.length < state.details.output.length) {
    throw new Error("Responses input is missing the remote compaction checkpoint");
  }
  const prefix = body.input.slice(0, state.details.output.length);
  if (hashCompactionOutput(prefix as unknown as typeof state.details.output) !== state.details.outputHash) {
    throw new Error("Responses input remote compaction checkpoint does not match persisted state");
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function cleanPartialState(output: AssistantMessage): void {
  for (const block of output.content) {
    if ("partialJson" in block) delete block.partialJson;
    if ("customInput" in block) delete block.customInput;
  }
}

function assertRequestBody(value: unknown): asserts value is RequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("before_provider_request must return a Responses request object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new Error("Responses request model must be a non-empty string");
  }
  if (!Array.isArray(body.input)) {
    throw new Error("Responses request input must be an array");
  }
  if ("type" in body || "stream" in body || "background" in body) {
    throw new Error("Responses WebSocket request body must not contain type, stream, or background");
  }
}

export async function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options: CodexStreamOptions,
): Promise<{ body: RequestBody; grammarToolInputProperties: ReadonlyMap<string, string> }> {
  const {
    clampOpenAIPromptCacheKey,
    convertResponsesMessages,
    convertResponsesTools,
    createGrammarToolInputProperties,
  } = await loadPiAiResponsesRuntime();
  const compat = model.compat as OpenAICompat | undefined;
  if (compat?.supportsToolSearch) {
    throw new Error("Deferred tool search is not supported by this provider");
  }
  const supportsStrictMode = compat?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false;
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    supportsOpenAIGrammarTools,
  );
  const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode", model.provider]);
  const input = convertResponsesMessages(model, context, allowedToolCallProviders, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
    toolOptions: {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    },
  });
  const checkpoint = checkpointStore.get(options.sessionId);
  if (checkpoint) {
    if (!checkpoint.projected || containsMarker(context, checkpoint.details.marker)) {
      throw new Error("Remote compaction context projection failed closed");
    }
    input.unshift(...structuredClone(checkpoint.details.output) as unknown as typeof input);
  }

  const body: RequestBody = {
    model: model.id,
    store: false,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input,
    text: { verbosity: options.textVerbosity ?? "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: true,
  };

  const promptCacheKey = clampOpenAIPromptCacheKey(options.sessionId);
  if (promptCacheKey !== undefined) body.prompt_cache_key = promptCacheKey;

  if (context.tools && context.tools.length > 0) {
    body.tools = convertResponsesTools(context.tools, {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    });
  }
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (options.reasoning !== undefined) {
    const level = clampThinkingLevel(model, options.reasoning);
    const effort = model.thinkingLevelMap?.[level] ?? level;
    if (effort !== null) {
      const summary = options.reasoningSummary === "off"
        ? null
        : options.reasoningSummary === "on"
          ? "auto"
          : (options.reasoningSummary ?? "auto");
      body.reasoning = {
        effort,
        summary,
      } as NonNullable<RequestBody["reasoning"]>;
    }
  }

  assertRequestBody(body);
  return { body, grammarToolInputProperties };
}

async function* emitStartOnFirstEvent(
  events: AsyncIterable<ResponseServerEvent>,
  onStart: () => void,
): AsyncGenerator<ResponseServerEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      onStart();
    }
    yield event;
  }
}

export function streamCodexWithApiKey(
  model: Model<Api>,
  context: Context,
  rawOptions: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createOutput(model);
  const options = rawOptions as CodexStreamOptions;

  void (async () => {
    try {
      if (model.api !== API_ID) {
        throw new Error(`Expected api ${API_ID}, received ${model.api}`);
      }
      if (!options.apiKey?.trim()) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      if (options.transport !== "websocket") {
        throw new Error("This provider requires transport=websocket");
      }
      const checkpointFailure = checkpointStore.getFailure(options.sessionId);
      if (checkpointFailure) {
        throw new Error(`Remote compaction checkpoint is invalid: ${checkpointFailure}`);
      }

      const baseUrl = normalizeBaseUrl(model.baseUrl);
      const { body: initialBody, grammarToolInputProperties } = await buildRequestBody(model, context, options);
      const replaced = await options.onPayload?.(initialBody, model);
      const body = replaced === undefined ? initialBody : replaced;
      assertRequestBody(body);
      if (body.model !== model.id) {
        throw new Error("before_provider_request must not change the configured model");
      }
      assertCheckpointPrefix(body, options.sessionId, model);

      const events = responseWebSocketEvents({
        apiKey: options.apiKey,
        baseUrl,
        event: { type: "response.create", ...body },
        headers: buildWebSocketHeaders(options.apiKey, options.headers),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.websocketConnectTimeoutMs !== undefined
          ? { connectTimeoutMs: options.websocketConnectTimeoutMs }
          : {}),
        ...(options.timeoutMs !== undefined ? { idleTimeoutMs: options.timeoutMs } : {}),
        ...(options.onResponse
          ? {
              onHandshake: async (status, headers) => {
                await options.onResponse?.({ status, headers }, model);
              },
            }
          : {}),
      });

      let startEmitted = false;
      const { processResponsesStream } = await loadPiAiResponsesRuntime();
      await processResponsesStream(
        emitStartOnFirstEvent(events, () => {
          if (!startEmitted) {
            startEmitted = true;
            stream.push({ type: "start", partial: output });
          }
        }),
        output,
        stream,
        model,
        { grammarToolInputProperties },
      );

      if (options.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "pending" || output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage ?? `Unexpected final stop reason: ${output.stopReason}`);
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      cleanPartialState(output);
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
