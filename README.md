# claude-code-traceparent PoC

Claude Code が MCP Server へのリクエストに W3C Trace Context を付与するのか検証

## セットアップ

```bash
bun install
```

## 起動

```bash
bun run src/server.ts                  # http（デフォルト）
```

| 環境変数    | デフォルト          | 説明                           |
| ----------- | ------------------- | ------------------------------ |
| `TRANSPORT` | `http`              | `stdio` / `http` を切替        |
| `PORT`      | `3456`              | HTTP モードの待受ポート        |
| `LOG_FILE`  | `debug.log`         | 受信内容を追記するログファイル |

## `echo` ツール

引数: `message: string`

処理: message をエコーバック。\_meta / HTTP ヘッダーを解析して traceparent を抽出しデバッグログに残す

---

## 確認手順

### 1. MCP Server の起動

```bash
bun run src/server.ts
```

### 2. Grafana の起動

OpenTelemetry のトレースを可視化するために Grafana を起動する。

```bash
docker run -p 3000:3000 -p 4317:4317 -p 4318:4318 --name lgtm grafana/otel-lgtm
```

### 3. Claude Code を起動

```bash
claude
```

```
# Claude Code 内で確認
> /mcp
> use the echo tool with message "hello"
```

補足：以下のファイルで OpenTelemetry の有効設定と MCP の登録を行っている

- [.claude/settings.json](.claude/settings.json) — MCP 登録の有無や traceparent の伝播設定
- [.mcp.json](.mcp.json) — MCP サーバの登録内容

### 4. 結果の見方

ツール実行後、debug.log / Claude Code のセッション履歴 / Claude Code OTel Traces の突合を確認する

1. debug.log から trace_id を確認
2. grafana の Web UI から trace_id で Log や Trace を検索する
3. grep で Claude Code のセッション履歴ファイルを特定する

```bash
trace_id=<YOUR_TRACE_ID>
grep -r $trace_id ~/.claude
```

### 5. CLI 単体での疎通確認

サーバ単体の動作だけ確かめたい場合:

```bash
# stdio
TP="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"},"_meta":{"traceparent":"'"$TP"'"}}}' \
  | TRANSPORT=stdio bun run src/server.ts

# HTTP（サーバ起動後）
curl -s -X POST http://localhost:3456/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"},"_meta":{"traceparent":"'"$TP"'"}}}'
```
