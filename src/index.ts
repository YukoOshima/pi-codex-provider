import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_ID, PROVIDER_ID } from "./constants.js";
import { streamCodexWithApiKey } from "./adapter.js";
import { registerRemoteCompaction } from "./remote-compaction.js";
import { loadPiAiResponsesRuntime } from "./pi-ai-responses-runtime.js";

export { API_ID, PROVIDER_ID } from "./constants.js";
export { buildRequestBody, streamCodexWithApiKey } from "./adapter.js";
export { normalizeBaseUrl, responsesCompactUrl, responsesWebSocketUrl } from "./base-url.js";
export { requestRemoteCompaction } from "./remote-compaction.js";
export { parseRemoteCompactionDetails } from "./checkpoint-store.js";

export default async function piCodexProvider(pi: ExtensionAPI): Promise<void> {
  await loadPiAiResponsesRuntime();
  pi.registerProvider(PROVIDER_ID, {
    api: API_ID,
    streamSimple: streamCodexWithApiKey,
  });
  registerRemoteCompaction(pi);
}
