import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_ID, PROVIDER_ID } from "./constants.js";
import { streamCodexWithApiKey } from "./adapter.js";
import { registerRemoteCompaction } from "./remote-compaction.js";
import { loadPiAiResponsesRuntime } from "./pi-ai-responses-runtime.js";
import { registerWebSearchTool } from "./web-search/index.js";

export { API_ID, PROVIDER_ID } from "./constants.js";
export { buildRequestBody, streamCodexWithApiKey } from "./adapter.js";
export { normalizeBaseUrl, responsesCompactUrl, responsesHttpUrl, responsesWebSocketUrl } from "./base-url.js";
export { requestRemoteCompaction } from "./remote-compaction.js";
export { parseRemoteCompactionDetails } from "./checkpoint-store.js";
export { registerWebSearchTool, WEB_SEARCH_MODEL_ID } from "./web-search/index.js";

export default async function piCodexProvider(pi: ExtensionAPI): Promise<void> {
  await loadPiAiResponsesRuntime();
  pi.registerProvider(PROVIDER_ID, {
    api: API_ID,
    streamSimple: streamCodexWithApiKey,
  });
  registerWebSearchTool(pi);
  registerRemoteCompaction(pi);
}
