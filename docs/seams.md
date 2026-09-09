# Seams: ADP capability → DeepSeek Harness

DSH’s rule is: hang a capability on an existing seam, do not start a second runtime.

| Goal | Seam | This bundle |
| --- | --- | --- |
| New model vendor | `ctx.llm.registerAdapter` | `llm-adp` — see [How models work](#how-models-work-llm-adp) |
| Replaceable search backend | `ctx.web` provider (existing `tool-web`) | `web-adp` — Hunyuan AI search plugin endpoint |
| Model-callable tools | `ctx.tools.register` | `plugins-adp` API/MCP tools, `adp_plugin_list` / `adp_plugin_enable` |
| Loadable instructions | `ctx.skills.registerProvider` | `skills-adp` |
| Secrets | `ctx.credentials` **references** | three planes; never plaintext in patch |
| Credentials settings card | `settings.plugin.item` (`key: adp-core`) + `credentials.set` | client half of `@tencentcloudadp/dsh-adp`; OneID login-url proxy does not fill keys |
| Long poll | `ctx.jobs.start` | release polling / generate Submit→Query |
| Published ADP app as a child Agent | `ctx.subagents.registerProvider` | `subagent-adp`; native child session and lineage, remote tools only |

## How models work (`llm-adp`)

Selecting `adp:Hunyuan/hy3` (or another `adp:…` id) uses DSH’s LLM adapter. It is not AppKey SSE chat and not the official ADP “build a Claw app” path in [133869](https://cloud.tencent.com/document/product/1759/133869). Catalog and completions are different planes and different keys.

`llm-adp` registers `AdpAdapter` as provider `adp`. The patch default model is `Hunyuan/hy3`. Independent site vs public cloud switches control-plane and AppKey SSE hosts only; both sites complete against `https://api.adp.cloud.tencent.com`.

### Catalog (the picker)

Control-plane AKSK (`ADP_SECRET_ID` / `ADP_SECRET_KEY`) signs `DescribeModelList` with `ModelScene=3` (Agent thinking; Claw is `18`). `normalizeModelList` reads `ModelList[].ModelBasic.ModelId` on public cloud and flat `ModelId` on independent site. The gateway has no usable list: `GET /models` is 503, `GET /v1/models` is 404.

Missing AKSK, an empty parse, or a swallowed control-plane error falls back to the builtin six (`Hunyuan/hy3`, DeepSeek V4, GLM / Kimi / MiniMax). A populated picker does not prove the live catalog loaded.

### Completions (a turn)

`ADP_API_KEY` is sent as `Authorization: Bearer`. `AdpAdapter` serializes DSH messages and tools to OpenAI-shaped JSON and `POST`s `https://api.adp.cloud.tencent.com/chat/completions` (adpworker `base_url`, **no** `/v1`). SSE frames become DSH `StreamChunk`. `/v1/chat/completions` is a different route and returns 401 `not_authorized` for a key that works (or 403s `AccountOverdueError`) on the unprefixed path.

After editing this repo, run `pnpm run prepare` (or `pnpm test`) and restart `dsh web`. The linked package loads `lib/`, not `src/`.

`web_search` and marketplace API/MCP plugins use the same gateway key on the plugin host, not `chat/completions`.

### Gateway completions vs AppKey SSE

| | Gateway (`llm-adp`) | App SSE (`agents-adp`) |
| --- | --- | --- |
| Key | `ADP_API_KEY` | Published app AppKey |
| URL | `api.adp.cloud.tencent.com/chat/completions` | `wss.lke…/adp/v2/chat` or `adp.tencent.com/adp/v2/chat` |
| Role | DSH Agent calls Hunyuan / DeepSeek / … | Talk to a published ADP app |
| Tools | DSH local tools (search, plugins) | Plugins bound on the cloud app; no local DSH tools |

## ADP subagent boundary

`subagent-adp` registers a one-shot provider on `ctx.subagents`. Each delegation creates a real DSH child Agent/session and projects ADP reasoning, remote tool traces, and the final reply into standard session events. The model-facing `subagent_adp` tool reuses `@deepseek-ai/dsh-tool-subagent`.

The cloud application still runs its own ADP-bound plugins and skills. The `/adp/v2/chat` request cannot inject DSH-local bash/filesystem tools, so the child is native in DSH lifecycle and display but remote in execution. `adp_ask_*` remains the lighter question-in/reply-out path.

## Control vs chat vs gateway

```
ADP_API_KEY → api.adp.cloud.tencent.com/chat/completions   llm-adp (both sites; no /v1)
ADP_API_KEY → adp.cloud.tencent.com/plugin/api/v1   web-adp, plugins-adp API (公有云 plugin host)
ADP_API_KEY → adp.tencent.com/plugin/api/v1         plugins-adp API (独立站 plugin host)
ADP_API_KEY → ExternalMCPServerUrl                  plugins-adp MCP
AKSK → capi.adp.tencent.com (独立站) or adp.tencentcloudapi.com (公有云)
AppKey in body → adp.tencent.com/adp/v2/chat (独立站) or wss.lke…/adp/v2/chat (公有云), used by agents-adp and subagent-adp
```

`ctx.adp` is a class `Service` (definition + the only provider). Other rows `inject: ['adp']` and do not depend on each other.
