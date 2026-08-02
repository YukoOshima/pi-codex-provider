import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_BUFFERED_EVENT_BYTES,
  MAX_BUFFERED_EVENTS,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
} from "./constants.js";
import { responsesWebSocketUrl } from "./base-url.js";

export type ResponseServerEvent = ResponseStreamEvent;
export type ResponseClientEvent = Parameters<ResponsesWS["send"]>[0];

export interface WebSocketRequestOptions {
  apiKey: string;
  baseUrl: string;
  event: ResponseClientEvent;
  headers: Record<string, string>;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
  onHandshake?: (status: number, headers: Record<string, string>) => void | Promise<void>;
}

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

function headersToRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function eventType(value: unknown): string {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
    throw new Error("Responses WebSocket returned an event without a string type");
  }
  return value.type;
}

function validateTerminalEvent(event: ResponseServerEvent): void {
  if (event.type === "response.completed" && event.response.status !== "completed") {
    throw new Error(`Invalid response.completed status: ${String(event.response.status)}`);
  }
  if (event.type === "response.incomplete" && event.response.status !== "incomplete") {
    throw new Error(`Invalid response.incomplete status: ${String(event.response.status)}`);
  }
  if (event.type === "response.failed" && event.response.status !== "failed") {
    throw new Error(`Invalid response.failed status: ${String(event.response.status)}`);
  }
}

export async function* responseWebSocketEvents(
  options: WebSocketRequestOptions,
): AsyncGenerator<ResponseServerEvent> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? MAX_BUFFERED_EVENTS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_EVENT_BYTES;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("connectTimeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error("idleTimeoutMs must be a positive finite number");
  }
  if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
    throw new Error("maxBufferedEvents must be a positive integer");
  }
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new Error("maxBufferedBytes must be a positive integer");
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 0,
    timeout: idleTimeoutMs,
  });
  const connection = new ResponsesWS(client, {
    headers: options.headers,
    handshakeTimeout: connectTimeoutMs,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: true,
  });
  const socket = connection.socket;
  const expectedUrl = responsesWebSocketUrl(options.baseUrl);
  if (connection.url.toString() !== expectedUrl) {
    connection.close({ code: 1002, reason: "unexpected_url" });
    throw new Error(`Unexpected Responses WebSocket URL: ${connection.url.toString()}`);
  }

  const queue: Array<{ event: ResponseServerEvent; bytes: number }> = [];
  let bufferedBytes = 0;
  let terminalSeen = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let rejectOpen: ((error: Error) => void) | undefined;
  let upgradeResponse: IncomingMessage | undefined;
  let opened = false;

  const notify = () => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  const fail = (error: unknown) => {
    if (!failure) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    rejectOpen?.(failure);
    notify();
  };
  const onEvent = (event: ResponseServerEvent) => {
    try {
      const type = eventType(event);
      if (terminalSeen) {
        throw new Error(`Responses WebSocket emitted ${type} after a terminal event`);
      }
      if (queue.length >= maxBufferedEvents) {
        throw new Error(`Responses WebSocket event buffer exceeded ${maxBufferedEvents} events`);
      }
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bufferedBytes + bytes > maxBufferedBytes) {
        throw new Error(`Responses WebSocket event buffer exceeded ${maxBufferedBytes} bytes`);
      }
      validateTerminalEvent(event);
      queue.push({ event, bytes });
      bufferedBytes += bytes;
      if (TERMINAL_EVENTS.has(type)) terminalSeen = true;
      notify();
    } catch (error) {
      fail(error);
    }
  };
  const onSdkError = (error: Error) => fail(error);
  const onUpgrade = (response: IncomingMessage) => {
    upgradeResponse = response;
  };
  const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
    response.resume();
    fail(new Error(`Responses WebSocket handshake failed with HTTP ${response.statusCode ?? "unknown"}`));
  };
  const onClose = (code: number, reason: Buffer) => {
    if (!terminalSeen) {
      const suffix = reason.length > 0 ? `: ${reason.toString("utf8").slice(0, 256)}` : "";
      fail(new Error(`Responses WebSocket closed before a terminal event (${code})${suffix}`));
    }
  };
  const onAbort = () => {
    fail(new Error("Request was aborted"));
    connection.close({ code: 1000, reason: "aborted" });
  };

  connection.on("event", onEvent);
  connection.on("error", onSdkError);
  socket.on("upgrade", onUpgrade);
  socket.on("unexpected-response", onUnexpectedResponse);
  socket.on("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (options.signal?.aborted) throw new Error("Request was aborted");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => complete(() => reject(new Error(`Responses WebSocket connect timeout after ${connectTimeoutMs}ms`))),
        connectTimeoutMs,
      );
      const complete = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onOpenError);
        rejectOpen = undefined;
        callback();
      };
      const onOpen = () => complete(() => {
        opened = true;
        resolve();
      });
      const onOpenError = (error: Error) => complete(() => reject(error));
      rejectOpen = (error) => complete(() => reject(error));
      socket.once("open", onOpen);
      socket.once("error", onOpenError);
    });

    if (!opened) throw new Error("Responses WebSocket did not open");
    if (upgradeResponse && options.onHandshake) {
      await options.onHandshake(upgradeResponse.statusCode ?? 101, headersToRecord(upgradeResponse.headers));
    }
    connection.send(options.event);

    while (true) {
      if (failure) throw failure;
      const next = queue.shift();
      if (next) {
        bufferedBytes -= next.bytes;
        yield next.event;
        continue;
      }
      if (terminalSeen) break;

      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        const timer = setTimeout(() => {
          wake = undefined;
          reject(new Error(`Responses WebSocket idle timeout after ${idleTimeoutMs}ms`));
        }, idleTimeoutMs);
        const originalWake = wake;
        wake = () => {
          clearTimeout(timer);
          originalWake();
        };
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    const suppressLateError = () => {};
    connection.on("error", suppressLateError);
    if (socket.readyState === 0) socket.terminate();
    else connection.close({ code: 1000, reason: terminalSeen ? "completed" : "failed" });
    connection.off("event", onEvent);
    connection.off("error", onSdkError);
    socket.off("upgrade", onUpgrade);
    socket.off("unexpected-response", onUnexpectedResponse);
    socket.off("close", onClose);
  }
}
