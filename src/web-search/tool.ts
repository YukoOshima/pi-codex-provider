import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { responsesHttpUrl, normalizeBaseUrl } from "../base-url.js";
import { API_ID, PROVIDER_ID } from "../constants.js";
import { buildHttpHeaders } from "../headers.js";
import { parseWebSearchSse, readBoundedText } from "./sse.js";

export const WEB_SEARCH_MODEL_ID = "gpt-5.6-luna";

const MAX_ERROR_BYTES = 32 * 1024;
const DOMAIN = /^-?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const parameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2000, description: "单个非空搜索问题" }),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "期望来源数，1 到 20" })),
  recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  domainFilter: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
    maxItems: 100,
    description: "域名白名单；前缀 - 表示排除",
  })),
}, { additionalProperties: false });

function buildInstructions(
  recency: "day" | "week" | "month" | "year" | undefined,
  count: number | undefined,
): string {
  const lines = ["Search the web. Answer concisely using only search results and include clickable source citations."];
  if (recency) lines.push(`Prefer results from the past ${recency}.`);
  if (count) lines.push(`Use up to ${count} distinct sources.`);
  return lines.join(" ");
}

function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text;
  for (const secret of new Set(secrets)) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

async function resolveWebSearchAuth(context: ExtensionContext): Promise<{
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string> | undefined;
}> {
  const model = context.modelRegistry.find(PROVIDER_ID, WEB_SEARCH_MODEL_ID);
  if (!model) throw new Error(`web_search: ${PROVIDER_ID}/${WEB_SEARCH_MODEL_ID} is unavailable`);
  if (model.provider !== PROVIDER_ID || model.id !== WEB_SEARCH_MODEL_ID || model.api !== API_ID) {
    throw new Error("web_search: configured Luna model does not use the Codex Responses provider");
  }
  if (!model.baseUrl) throw new Error("web_search: configured Luna model has no baseUrl");
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`web_search: model authentication failed: ${auth.error}`);
  if (!auth.apiKey?.trim()) throw new Error("web_search: configured Luna model has no API key");
  return {
    apiKey: auth.apiKey,
    baseUrl: normalizeBaseUrl(model.baseUrl),
    headers: auth.headers,
  };
}

export function registerWebSearchTool(
  pi: ExtensionAPI,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): void {
  pi.registerTool({
    name: "web_search",
    label: "Codex Luna Web Search",
    description: "通过已配置的 Codex Luna Responses 网关流式搜索单个问题；任何异常立即失败。",
    parameters,
    async execute(_callId, params, signal, _onUpdate, context) {
      const query = params.query.trim();
      if (!query) throw new Error("web_search: query 不能为空");
      const domains = params.domainFilter?.map((domain) => domain.trim());
      if (domains?.some((domain) => !DOMAIN.test(domain))) {
        throw new Error("web_search: domainFilter 包含无效域名");
      }

      const timeoutSignal = AbortSignal.timeout(60_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const { apiKey, baseUrl, headers } = await resolveWebSearchAuth(context);
      const allowed = domains?.filter((domain) => !domain.startsWith("-"));
      const blocked = domains?.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1));
      const tool: Record<string, unknown> = { type: "web_search" };
      if (allowed?.length || blocked?.length) {
        tool.filters = {
          ...(allowed?.length ? { allowed_domains: allowed } : {}),
          ...(blocked?.length ? { blocked_domains: blocked } : {}),
        };
      }

      const response = await fetchImpl(responsesHttpUrl(baseUrl), {
        method: "POST",
        headers: buildHttpHeaders(apiKey, headers),
        body: JSON.stringify({
          model: WEB_SEARCH_MODEL_ID,
          instructions: buildInstructions(params.recencyFilter, params.numResults),
          input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
          tools: [tool],
          include: ["web_search_call.action.sources"],
          tool_choice: "required",
          parallel_tool_calls: false,
          store: false,
          stream: true,
        }),
        signal: requestSignal,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!response.ok) {
        const errorBody = redact(await readBoundedText(response.body, MAX_ERROR_BYTES), [apiKey, ...Object.values(headers ?? {})]);
        throw new Error(`web_search: Responses HTTP ${response.status}: ${errorBody.slice(0, 1000)}`);
      }
      if (!contentType.startsWith("text/event-stream")) {
        throw new Error("web_search: Responses Content-Type 不是 SSE");
      }
      const result = await parseWebSearchSse(response.body);
      const sources = result.sources.slice(0, params.numResults ?? 20);
      const sourceText = sources.map(({ title, url }) => `- [${title}](<${url}>)`).join("\n");
      return {
        content: [{ type: "text" as const, text: `${result.answer}\n\n## Sources\n${sourceText}` }],
        details: { provider: PROVIDER_ID, model: WEB_SEARCH_MODEL_ID, sourceCount: sources.length },
      };
    },
  });
}
