import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses";

interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  deferLoading?: boolean;
}

interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  deferredTools?: ReadonlyMap<string, Tool>;
  toolOptions?: ConvertResponsesToolsOptions;
}

interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

export interface PiAiResponsesRuntime {
  createGrammarToolInputProperties(
    tools: Tool[] | undefined,
    supportsOpenAIGrammarTools: boolean,
  ): ReadonlyMap<string, string>;
  clampOpenAIPromptCacheKey(key: string | undefined): string | undefined;
  convertResponsesMessages<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    allowedToolCallProviders: ReadonlySet<string>,
    options?: ConvertResponsesMessagesOptions,
  ): ResponseInput;
  convertResponsesTools(
    tools: readonly Tool[],
    options?: ConvertResponsesToolsOptions,
  ): OpenAITool[];
  processResponsesStream<TApi extends Api>(
    openaiStream: AsyncIterable<ResponseStreamEvent>,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    model: Model<TApi>,
    options?: OpenAIResponsesStreamOptions,
  ): Promise<void>;
}

let runtimePromise: Promise<PiAiResponsesRuntime> | undefined;

export function loadPiAiResponsesRuntime(): Promise<PiAiResponsesRuntime> {
  if (runtimePromise) return runtimePromise;

  // Pi 0.83's jiti aliases bare pi-ai imports before applying package exports.
  // A native .mjs bridge keeps those public subpath imports in Node's resolver.
  const bridgeUrl = new URL("./pi-ai-responses-bridge.mjs", import.meta.url);
  runtimePromise = import(bridgeUrl.href).then((module) => module as PiAiResponsesRuntime);
  return runtimePromise;
}
