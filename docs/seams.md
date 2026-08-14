# Seams: ADP capability → DeepSeek Harness

DSH’s rule is: hang a capability on an existing seam, do not start a second runtime.

| Goal | Seam | This bundle |
| --- | --- | --- |
| New model vendor | `ctx.llm.registerAdapter` | `llm-adp` — OpenAI-compatible `https://api.adp.cloud.tencent.com` |
| Replaceable search backend | `ctx.web` provider (existing `tool-web`) | `web-adp` — Hunyuan AI search plugin endpoint |
| Model-callable tools | `ctx.tools.register` | `plugins-adp` API/MCP tools, `adp_plugin_list` / `adp_plugin_enable` |
| Loadable instructions | `ctx.skills.registerProvider` | `skills-adp` (P1, disabled) |
| Secrets | `ctx.credentials` **references** | three planes; never plaintext in patch |
| Credentials settings card | `settings.plugin.item` + `credentials.set` | client half of `@tencent/dsh-adp`; OneID login-url proxy does not fill keys |
| Long poll | `ctx.jobs.start` | release polling / generate Submit→Query |
| Remote agent that calls local tools | `ctx.subagents` | **not used** |

## Why cloud agents are not subagents

`POST /adp/v2/chat` does not accept `Tools` and does not return `tool_call` (adpworker requirement ④). The cloud agent runs whatever plugins/skills are bound on ADP. DSH local bash/fs cannot be inserted into that loop. `adp_ask_*` is one-way delivery: question in, finished reply out.

## Control vs chat vs gateway

```
sk-  → api.adp.cloud.tencent.com/v1          llm-adp (both sites)
sk-  → adp.cloud.tencent.com/plugin/api/v1   web-adp, plugins-adp API (公有云 plugin host)
sk-  → adp.tencent.com/plugin/api/v1         plugins-adp API (独立站 plugin host)
sk-  → ExternalMCPServerUrl                  plugins-adp MCP
AKSK → capi.adp.tencent.com (独立站) or adp.tencentcloudapi.com (公有云)
AppKey in body → adp.tencent.com/adp/v2/chat (独立站) or wss.lke…/adp/v2/chat (公有云)
```

`ctx.adp` is a class `Service` (definition + the only provider). Other rows `inject: ['adp']` and do not depend on each other.
