# pi-codex-provider

给 [Pi](https://pi.dev/) 提供一个严格的 `openai-codex-responses` 传输实现：使用普通 HTTPS `baseUrl` 和 opaque API key，通过标准 Responses WebSocket 调用模型、通过 `/responses/compact` 执行远程压缩，并注册内置 `web_search` 工具。

这个扩展不会创建新的 gateway，也不会内置模型目录。它只覆盖 `codex-cli` provider 的传输层；模型 metadata、`baseUrl` 和密钥仍由 Pi 的 `models.json` 管理。

## 行为边界

- 推理固定走 `wss://<baseUrl>/responses`。
- 压缩固定走 `https://<baseUrl>/responses/compact`。
- API key 只作为 `Authorization: Bearer ...` 使用，不解析 JWT，不需要 ChatGPT OAuth 或 account ID。
- 如果连接在尚未收到任何服务端事件时以 `1006` 异常关闭，扩展会立即新建一条 WSS 并完整重放请求一次；这是唯一的恢复路径。
- 收到任何服务端事件后都不会重放；第二次 `1006`、握手、协议、超时或其他上游错误都会立即失败。始终不回退 SSE/HTTP Responses。
- 远程压缩失败会取消本次压缩；不会回退到 Pi 的本地文本摘要。
- `web_search` 是本 package 注册的唯一搜索工具。它从 Pi `ModelRegistry` 精确解析 `codex-cli/gpt-5.6-luna` 的 `baseUrl`、command-backed key 和 headers，以 HTTPS `/responses` SSE 调用 OpenAI hosted web search；这是显式工具执行，不是推理的 HTTP fallback。
- 搜索 SSE 全程分块、有界解析；缺少 Luna 模型、认证、SSE Content-Type 或来源时直接失败。
- `baseUrl` 必须是 HTTPS API 根路径，不能包含 `/responses`、`/responses/compact` 或 `/codex`。
- 当前不支持 deferred tool search；启用 `compat.supportsToolSearch` 会在网络请求前失败。

当前版本精确针对 Pi `0.83.0`，要求 Node.js `22.19.0` 或更新版本。

## 安装

```bash
pi install https://github.com/YukoOshima/pi-codex-provider.git
```

开发时也可以直接加载本地入口：

```bash
pi -e /absolute/path/to/pi-codex-provider/src/index.ts
```

## Pi 配置

在 `~/.pi/agent/models.json` 中继续使用现有的 `codex-cli` provider，只修改传输 API、根地址和密钥来源；保留原有 `models` metadata：

```json
{
  "providers": {
    "codex-cli": {
      "api": "openai-codex-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "!/absolute/path/to/read-codex-api-key",
      "models": [
        {
          "id": "your-model-id",
          "name": "Your model",
          "reasoning": true,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

密钥建议由绝对路径命令读取，不要明文写入仓库或 shell history。`web_search` 不另设 JSON 配置或单独 credential file，它会复用这里的 `codex-cli/gpt-5.6-luna` 配置。

在 `~/.pi/agent/settings.json` 中显式强制 WebSocket：

```json
{
  "transport": "websocket",
  "compaction": {
    "enabled": true
  }
}
```

扩展只接受精确的 `transport: "websocket"`；`sse`、`auto`、`websocket-cached` 和未配置都会 fast-fail。

## 远程压缩

Pi 触发压缩时，扩展会把即将丢弃的上下文发送到 `/responses/compact`，并将服务端返回的原始 `output`（包括 `encrypted_content`）保存在 session compaction entry 的 `details` 中。后续请求会移除仅供 Pi UI 使用的 marker，并把原始 checkpoint 放回 Responses `input` 的最前面。

Checkpoint 与 provider/model 绑定。压缩后切换 provider 或 model 会直接报错，避免把密文状态发送给不匹配的模型。自定义 `/compact` 摘要指令当前不受支持，也会直接取消压缩。

## 验证

```bash
npm ci
npm run test:all
npm audit --omit=dev
npm run pack:check
```

在已执行 `npm ci` 的源码仓库中，真实网关 smoke test 从标准输入读取 API key，避免把密钥放进参数或环境变量：

```bash
credential-command | \
  PI_CODEX_LIVE_BASE_URL=https://gateway.example/v1 \
  PI_CODEX_LIVE_MODEL=your-model-id \
  node --import tsx scripts/live-smoke.ts
```

测试包含真实本地 TLS WebSocket server，验证精确路径和 header、Pi 文本事件、HTTP 503 升级拒绝、零事件 `1006` 仅重连一次、收到任何事件后禁止重放，以及所有失败场景都没有 HTTP/SSE inference fallback。`web_search` 测试验证 Luna 路由、ModelRegistry 认证复用、SSE 分块解析、来源去重和请求前 fast-fail。远程压缩测试验证单次 `/responses/compact` 请求、严格响应 schema、checkpoint 防篡改和上下文投影。

## License

MIT。依赖与上游说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
