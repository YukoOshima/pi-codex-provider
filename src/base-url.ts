export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error("Codex provider baseUrl is required");
  }

  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`Codex provider baseUrl must use https, received ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Codex provider baseUrl must not contain credentials, query parameters, or fragments");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  if (/(?:^|\/)responses(?:\/compact)?$/.test(url.pathname)) {
    throw new Error("Codex provider baseUrl must be the API root, not a /responses endpoint");
  }
  if (/(?:^|\/)codex$/.test(url.pathname)) {
    throw new Error("Codex provider baseUrl must not use the ChatGPT /codex namespace");
  }
  if (!url.pathname.endsWith("/v1")) {
    throw new Error("Codex provider baseUrl path must end with /v1");
  }

  return url.toString().replace(/\/$/, "");
}

export function responsesWebSocketUrl(baseUrl: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/responses`);
  url.protocol = "wss:";
  return url.toString();
}

export function responsesHttpUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/responses`;
}

export function responsesCompactUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/responses/compact`;
}
