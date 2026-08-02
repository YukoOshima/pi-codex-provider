import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { RESPONSES_WEBSOCKET_BETA } from "./constants.js";

export function buildWebSocketHeaders(
  apiKey: string,
  configured: ProviderHeaders | undefined,
): Record<string, string> {
  if (!apiKey.trim()) {
    throw new Error("Codex provider API key is required");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA,
  };

  for (const [name, value] of Object.entries(configured ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "authorization") {
      throw new Error("Codex provider headers must not override Authorization");
    }
    if (lower === "openai-beta") {
      throw new Error("Codex provider headers must not override OpenAI-Beta");
    }
    if (value === null) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }

  return headers;
}

export function buildHttpHeaders(
  apiKey: string,
  configured: ProviderHeaders | undefined,
): Record<string, string> {
  const headers = buildWebSocketHeaders(apiKey, configured);
  delete headers["OpenAI-Beta"];
  headers["Content-Type"] = "application/json";
  return headers;
}
