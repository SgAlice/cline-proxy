# cline-proxy

把 Cline（`api.cline.bot`）包装成标准 OpenAI 接口的转发服务，放在 Aether 网关和 Cline 之间使用。零依赖，Node.js ≥ 22。

## 为什么需要它

- Cline 的非流式 `/chat/completions` 响应外面包了一层 `{"data": {...}, "success": true}`，标准 OpenAI 客户端读不到 `choices` 和 `usage`，表现为**空回复**，Aether 记账为 0/0 tokens。
- Cline 的流式响应默认不带 usage。
- Cline 没有 `/responses` 接口，Codex 这类用 Responses API 的客户端没法直接接入。

## 接口

| 路径 | 行为 |
|---|---|
| `POST /v1/chat/completions` | 流式：透传 SSE，自动加 `stream_options.include_usage`，去掉 `provider_metadata`；非流式：拆掉 `data` 外壳。Cline 的错误统一转成 OpenAI 格式 |
| `POST /v1/responses` | Responses → Chat 转换后调用 Cline（上游始终流式），再转回 Responses（支持流式 SSE 事件和非流式） |
| `GET /v1/models` | 透传并拆壳 |
| `GET /health` | 健康检查 |

### Responses 转换支持的内容

- 文本、图片输入；`instructions` / system / developer 消息
- 推理：输出为 `reasoning` item（摘要 + `encrypted_content` 中保存完整推理，回传时还原为 `reasoning_content`）
- 函数工具 `function`
- 自定义 freeform 工具 `custom`（如 Codex 的 `apply_patch`）：转成只有一个 `input` 字符串参数的函数，输出时还原为 `custom_tool_call`
- 命名空间工具 `namespace`：支持 function 和 custom；采用请求级、抗碰撞别名，输出还原原始名称、namespace 和工具类型。
- `local_shell`
- 多轮历史中的 `function_call` / `custom_tool_call` / `*_output`，并自动补齐或清理不成对的工具结果
- `reasoning.effort`、`max_output_tokens`、`temperature`、`top_p`、`text.format`（json_schema / json_object）
- usage 映射（含 cached tokens、reasoning tokens）

不支持：`previous_response_id`（无状态服务）、`web_search` 等需要服务端执行的工具（会被忽略）。

## 鉴权

本服务**不保存任何 API Key**：直接把调用方请求里的 `Authorization`（或 `x-api-key`）转发给 Cline。在 Aether 中，Key 仍然配置在 cline 供应商里。

## 部署（与 Aether 同一 docker 网络）

```bash
docker compose -f compose.yml up -d --build
```

然后在 Aether 后台把 cline 供应商的 `openai:chat` 和 `openai:responses` 两个端点的 Base URL 改为：

```
http://cline-proxy:3060/v1
```

Key 和模型映射（如 `cline-pass/deepseek-v4.1-flash`）保持不变，不需要开启 Aether 的格式转换。

### Aether 使用 host 网络模式时

如果 Aether 容器是 `network_mode: host`（不在 `aether_default` 网络里），改用：

```bash
docker compose -f compose.local.yml up -d --build
```

本服务同样使用 host 网络，只监听 `127.0.0.1:3060`，不对外暴露。Aether 端点 Base URL 填：

```
http://127.0.0.1:3060/v1
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3060` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `UPSTREAM_BASE_URL` | `https://api.cline.bot/api/v1` | 上游地址 |
| `MODEL_PREFIX` | `cline-pass/` | 模型名不含 `/` 时自动补的前缀；设为空字符串可关闭 |
| `IDLE_TIMEOUT_MS` | `300000` | 上游流式空闲超时 |
| `MAX_BODY_BYTES` | `67108864` | 请求体上限（支持 gzip / br / deflate / zstd 压缩的请求体） |
| `LOG_LEVEL` | `info` | `debug` 时会记录每个 Responses 请求的工具类型和 item 类型 |

## 日志

```bash
docker logs -f cline-proxy
```

每个请求一行 JSON：`chat done` / `responses done`，包含耗时、token 数、输出 item 类型和结束原因。


## Codex 子代理适配（2026-10-07）

复用 commandcode-proxy 的 `responses-compat.mjs`，保留 MIT 许可于
`LICENSE.commandcode`。Cline 的鉴权、模型前缀与 Chat 接口保持原样。

- 接入 `additional_tools` 动态工具目录，保留 `strict` 与自定义 grammar 描述。
- 将 `agent_message` 的明文任务送入用户消息，兼容把明文放进
  `encrypted_content` 的第三方载体；这**不是解密**。可识别 Fernet 密文返回 400，
  其他密码格式也不具备解密能力，必须由父侧保证明文。
- `namespace` 内的 freeform/custom 工具以 `{input: string}` 传输，支持 Unicode、
  原始文本、JSON 字符串、并行交错分片；恢复原始 call ID、命名空间和 custom SSE 事件。
- 历史工具及结果采用相同映射；未知或歧义工具报错，不猜测名称、不执行 DSML 文本。
- 可选 hosted web search 省略时明确告知模型能力边界；强制 search 返回 400。
- 未结束的上游流和还原失败不伪造 `response.completed`，工具输入缓冲上限 16 MiB。
- 保留原来的 `clinepx1:` 推理状态往返。它是 base64 兼容载体，不是真正加密。

### 父代理前提

跨服务商真实密文不能由子代理中转解密。父侧需要在生成派发工具调用前去掉
`message.encrypted` 并适配 collaboration 命名空间。机器上已有独立服务
`commandcode-parent-compat`（loopback 3051），但迁移本服务不会自动修改其他
供应商路由。若父代理仍产出密文，需为其当前上游单独配置父侧兼容链路，然后重新派发。
不要把 DeepSeek 子代理流量转入 native Responses 父侧代理。

### 无网络回归测试

```sh
# tests 通过只读挂载；mock fetch 不调用 Cline、不使用真实密钥。
docker run --rm --network none --read-only --user node \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$PWD/tests:/app/tests:ro" --entrypoint node cline-proxy:local \
  tests/responses-codex.mjs
```

### 本次部署验收

- 2026-10-07：本机与服务器 Node 22 禁网 mock 均通过 42/42 项回归。
- Cline `cline-pass/deepseek-v4.1-flash`：候选端口与正式端口各 4 次真实请求，
  JSON/SSE 的 namespaced custom echo 及工具结果续接全部通过；没有执行模型生成代码。
- 等待原端口零连接窗口后切换，健康检查通过；未变更网关端点、凭证、模型映射或父侧路由。
- 原源码：`/opt/cline-proxy-backup-20261007-codex`；
  原镜像：`cline-proxy:rollback-20261007-codex`。
- 临时候选容器已停止。当前验证是协议层真实模型往返，不是完整 Codex 原生子代理会话验收。
