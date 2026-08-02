import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { REMOTE_COMPACTION_KIND } from "./constants.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RemoteCompactionDetails {
  kind: typeof REMOTE_COMPACTION_KIND;
  version: 1;
  provider: string;
  model: string;
  responseId: string;
  marker: string;
  output: JsonObject[];
  outputHash: string;
}

export interface ActiveCheckpoint {
  details: RemoteCompactionDetails;
  projected: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

export function hashCompactionOutput(output: readonly JsonObject[]): string {
  const hash = createHash("sha256");
  hash.update("[");
  for (let index = 0; index < output.length; index += 1) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(output[index]));
  }
  hash.update("]");
  return hash.digest("hex");
}

export function parseRemoteCompactionDetails(value: unknown): RemoteCompactionDetails | undefined {
  if (!isObject(value) || value.kind !== REMOTE_COMPACTION_KIND) return undefined;
  if (
    value.version !== 1
    || typeof value.provider !== "string"
    || !value.provider
    || typeof value.model !== "string"
    || !value.model
    || typeof value.responseId !== "string"
    || !value.responseId
    || typeof value.marker !== "string"
    || !value.marker
    || typeof value.outputHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.outputHash)
    || !Array.isArray(value.output)
    || value.output.length === 0
    || !value.output.every((item) => isObject(item) && isJsonValue(item))
  ) {
    throw new Error("Invalid remote compaction checkpoint details");
  }

  const output = value.output as JsonObject[];
  if (hashCompactionOutput(output) !== value.outputHash) {
    throw new Error("Remote compaction checkpoint hash mismatch");
  }
  return {
    kind: REMOTE_COMPACTION_KIND,
    version: 1,
    provider: value.provider,
    model: value.model,
    responseId: value.responseId,
    marker: value.marker,
    output,
    outputHash: value.outputHash,
  };
}

export function findLatestRemoteCheckpoint(
  entries: readonly SessionEntry[],
): RemoteCompactionDetails | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    return parseRemoteCompactionDetails(entry.details);
  }
  return undefined;
}

class CheckpointStore {
  readonly #states = new Map<string, ActiveCheckpoint>();
  readonly #failures = new Map<string, string>();

  get(sessionId: string | undefined): ActiveCheckpoint | undefined {
    return sessionId ? this.#states.get(sessionId) : undefined;
  }

  getFailure(sessionId: string | undefined): string | undefined {
    return sessionId ? this.#failures.get(sessionId) : undefined;
  }

  set(sessionId: string, details: RemoteCompactionDetails, projected = false): void {
    this.#failures.delete(sessionId);
    this.#states.set(sessionId, { details, projected });
  }

  block(sessionId: string, error: string): void {
    this.#states.delete(sessionId);
    this.#failures.set(sessionId, error);
  }

  markProjected(sessionId: string, projected: boolean): void {
    const state = this.#states.get(sessionId);
    if (state) state.projected = projected;
  }

  delete(sessionId: string): void {
    this.#states.delete(sessionId);
    this.#failures.delete(sessionId);
  }

  clear(): void {
    this.#states.clear();
    this.#failures.clear();
  }
}

export const checkpointStore = new CheckpointStore();
