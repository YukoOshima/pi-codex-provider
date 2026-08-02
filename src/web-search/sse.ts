export interface WebSearchSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_ANSWER_CHARS = 32 * 1024;
const MAX_SOURCE_CANDIDATES = 100;

function recordOf(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!body) throw new Error("web_search: 响应体缺失");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("web_search: 响应体超限");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function sourceFrom(rawUrl: unknown, rawTitle: unknown): WebSearchSource | undefined {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_search: 来源 URL 无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("web_search: 来源 URL 协议无效");
  }
  if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
  const title = typeof rawTitle === "string"
    ? rawTitle.replace(/[\0-\x1f\x7f<>[\]()*_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
    : "";
  return { title: title || url.toString(), url: url.toString() };
}

function addSource(
  source: WebSearchSource,
  sources: Map<string, WebSearchSource>,
  counter: { value: number },
): void {
  if (sources.has(source.url)) return;
  counter.value += 1;
  if (counter.value > MAX_SOURCE_CANDIDATES) throw new Error("web_search: 来源数量超限");
  sources.set(source.url, source);
}

function collectItem(
  item: unknown,
  answers: string[],
  answerCounter: { value: number },
  sources: Map<string, WebSearchSource>,
  sourceCounter: { value: number },
): void {
  const record = recordOf(item, "web_search: 输出项无效");
  if (record.type === "message") {
    if (!Array.isArray(record.content)) throw new Error("web_search: message content 无效");
    for (const part of record.content) {
      const piece = recordOf(part, "web_search: message part 无效");
      if (typeof piece.text === "string" && piece.text.trim()) {
        const text = piece.text.trim();
        answerCounter.value += text.length;
        if (answerCounter.value > MAX_ANSWER_CHARS) throw new Error("web_search: 答案超限");
        answers.push(text);
      }
      if (!Array.isArray(piece.annotations)) continue;
      for (const annotation of piece.annotations) {
        const citation = recordOf(annotation, "web_search: citation 无效");
        if (citation.type !== "url_citation") continue;
        const source = sourceFrom(citation.url, citation.title);
        if (source) addSource(source, sources, sourceCounter);
      }
    }
    return;
  }

  if (record.type !== "web_search_call") return;
  const action = record.action && typeof record.action === "object" && !Array.isArray(record.action)
    ? record.action as Record<string, unknown>
    : undefined;
  for (const group of [action?.sources, record.sources, record.results]) {
    if (group === undefined) continue;
    if (!Array.isArray(group)) throw new Error("web_search: sources 无效");
    for (const entry of group) {
      const sourceRecord = recordOf(entry, "web_search: source 无效");
      const source = sourceFrom(
        sourceRecord.url ?? sourceRecord.source_website_url,
        sourceRecord.title ?? sourceRecord.caption,
      );
      if (source) addSource(source, sources, sourceCounter);
    }
  }
}

function collectAnswerLinks(
  answer: string,
  sources: Map<string, WebSearchSource>,
  counter: { value: number },
): void {
  for (const match of answer.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = match[2];
    if (url === undefined) continue;
    const source = sourceFrom(url, match[1] ?? "");
    if (source) addSource(source, sources, counter);
  }
}

export async function parseWebSearchSse(
  body: ReadableStream<Uint8Array> | null,
): Promise<WebSearchResult> {
  if (!body) throw new Error("web_search: 响应体缺失");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const answers: string[] = [];
  const finalAnswers: string[] = [];
  const sources = new Map<string, WebSearchSource>();
  const sourceCounter = { value: 0 };
  const preliminaryAnswerCounter = { value: 0 };
  const finalAnswerCounter = { value: 0 };
  let buffer = "";
  let bytes = 0;
  let events = 0;
  let completed = false;

  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;
    events += 1;
    if (events > MAX_EVENTS || data.length > MAX_LINE_CHARS) {
      throw new Error("web_search: SSE 事件超限");
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error("web_search: SSE JSON 无效");
    }
    if (typeof event.type !== "string") throw new Error("web_search: SSE 事件类型缺失");
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      throw new Error("web_search: Responses 流失败");
    }
    if (event.type === "response.output_item.done") {
      collectItem(event.item, answers, preliminaryAnswerCounter, sources, sourceCounter);
    }
    if (event.type !== "response.completed" && event.type !== "response.done") return;
    if (completed) throw new Error("web_search: 重复完成事件");
    const response = recordOf(event.response, "web_search: 完成事件缺少 response");
    if (response.status !== "completed") throw new Error("web_search: Responses 状态不是 completed");
    if (!Array.isArray(response.output)) throw new Error("web_search: 完成事件 output 无效");
    for (const item of response.output) {
      collectItem(item, finalAnswers, finalAnswerCounter, sources, sourceCounter);
    }
    completed = true;
  };

  const consumeCompleteLines = () => {
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      consume(line);
    }
    if (buffer.length > MAX_LINE_CHARS) throw new Error("web_search: SSE 行长度超限");
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("web_search: SSE 总大小超限");
      buffer += decoder.decode(value, { stream: true });
      consumeCompleteLines();
    }
    buffer += decoder.decode();
    if (buffer.length > MAX_LINE_CHARS) throw new Error("web_search: SSE 行长度超限");
    if (buffer) consume(buffer.replace(/\r$/, ""));
    if (!completed) throw new Error("web_search: Responses 流未正常完成");
    const answer = (finalAnswers.length ? finalAnswers : answers).join("\n").trim();
    if (!answer) throw new Error("web_search: 答案缺失");
    collectAnswerLinks(answer, sources, sourceCounter);
    if (!sources.size) throw new Error("web_search: 搜索结果缺少来源");
    return { answer, sources: [...sources.values()] };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}
