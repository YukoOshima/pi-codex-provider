export const API_ID = "openai-codex-responses" as const;
export const PROVIDER_ID = "codex-cli";
export const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
export const MAX_BUFFERED_EVENTS = 2_048;
export const MAX_BUFFERED_EVENT_BYTES = 32 * 1024 * 1024;
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const REMOTE_COMPACTION_KIND = "pi-codex-provider.remote-compaction.v1";
