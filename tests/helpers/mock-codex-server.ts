import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export type MockScenario = "success" | "handshake-failure" | "upgrade-rejected" | "early-close";

export interface ObservedWebSocketRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const CERTIFICATE_URL = new URL("../fixtures/localhost-cert.pem", import.meta.url);
const PRIVATE_KEY_URL = new URL("../fixtures/localhost-key.pem", import.meta.url);
const RESPONSES_PATH = "/v1/responses";
const MAX_HTTP_BODY_BYTES = 1_048_576;

function decodeWebSocketData(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

const messageItem = {
  id: "msg_test_1",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [
    {
      type: "output_text",
      text: "hello from mock",
      annotations: [],
      logprobs: [],
    },
  ],
};

const successEvents = [
  {
    type: "response.created",
    response: {
      id: "resp_test_1",
      object: "response",
      status: "in_progress",
      output: [],
    },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: messageItem.id,
      type: "message",
      role: "assistant",
      status: "in_progress",
      phase: "final_answer",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: "hello from mock",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: messageItem,
  },
  {
    type: "response.completed",
    response: {
      id: "resp_test_1",
      object: "response",
      status: "completed",
      output: [messageItem],
      usage: {
        input_tokens: 7,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 10,
      },
    },
  },
] as const;

export class MockCodexServer {
  readonly observedWebSocketRequests: ObservedWebSocketRequest[] = [];
  readonly regularHttpRequests: Array<{ method: string; path: string }> = [];
  websocketUpgradeCount = 0;
  httpResponsesRequestCount = 0;

  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly rawSockets = new Set<Duplex>();
  private baseUrlValue = "";

  private constructor(
    private readonly scenario: MockScenario,
    private readonly httpsServer: HttpsServer,
  ) {}

  static async start(scenario: MockScenario): Promise<MockCodexServer> {
    const [cert, key] = await Promise.all([
      readFile(CERTIFICATE_URL),
      readFile(PRIVATE_KEY_URL),
    ]);
    let instance: MockCodexServer;
    const httpsServer = createServer({ cert, key }, (request, response) => {
      void instance.handleHttpRequest(request, response);
    });
    instance = new MockCodexServer(scenario, httpsServer);
    instance.bindHandlers();
    await instance.listen();
    return instance;
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  async close(): Promise<void> {
    for (const client of this.webSocketServer.clients) {
      client.terminate();
    }
    for (const socket of this.rawSockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.httpsServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.httpsServer.closeAllConnections();
    });
  }

  private bindHandlers(): void {
    this.httpsServer.on("connection", (socket) => {
      this.rawSockets.add(socket);
      socket.once("close", () => this.rawSockets.delete(socket));
    });
    this.httpsServer.on("upgrade", (request, socket, head) => {
      this.websocketUpgradeCount += 1;
      const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
      if (path !== RESPONSES_PATH) {
        this.rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      if (this.scenario === "handshake-failure") {
        socket.destroy();
        return;
      }
      if (this.scenario === "upgrade-rejected") {
        this.rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (webSocket, request) => {
      webSocket.on("error", () => {});
      webSocket.once("message", (data, isBinary) => {
        const body = JSON.parse(isBinary ? decodeWebSocketData(data) : data.toString()) as unknown;
        this.observedWebSocketRequests.push({
          path: new URL(request.url ?? "/", "https://127.0.0.1").pathname,
          headers: request.headers,
          body,
        });
        if (this.scenario === "early-close") {
          webSocket.close(1011, "closed before terminal event");
          return;
        }
        for (const event of successEvents) {
          if (webSocket.readyState !== WebSocket.OPEN) break;
          webSocket.send(JSON.stringify(event));
        }
      });
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
    const method = request.method ?? "GET";
    this.regularHttpRequests.push({ method, path });
    if (path === RESPONSES_PATH) this.httpResponsesRequestCount += 1;

    let bodyBytes = 0;
    for await (const chunk of request) {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > MAX_HTTP_BODY_BYTES) {
        response.writeHead(413).end();
        return;
      }
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "HTTP Responses fallback is forbidden in this test" }));
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
    );
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.httpsServer.once("error", onError);
      this.httpsServer.listen(0, "127.0.0.1", () => {
        this.httpsServer.off("error", onError);
        resolve();
      });
    });
    const address = this.httpsServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock Codex server did not bind a TCP port");
    }
    this.baseUrlValue = `https://127.0.0.1:${address.port}/v1`;
  }
}
