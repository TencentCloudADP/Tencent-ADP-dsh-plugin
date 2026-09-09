# @tencentcloudadp/dsh-adp

Tencent Cloud ADP as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![GitHub stars](https://img.shields.io/github/stars/TencentCloudADP/Tencent-ADP-dsh-plugin)](https://github.com/TencentCloudADP/Tencent-ADP-dsh-plugin)

[English](README.md) · [中文](README.zh-CN.md)

This plugin connects a DSH profile to Tencent Cloud ADP: gateway models (Hunyuan and friends), Hunyuan AI web search, the API/MCP plugin marketplace, the skill plaza, and ADP apps as ask tools. It is not ADP Worker.

## Install

```sh
dsh plugin --profile web add @tencentcloudadp/dsh-adp
dsh web
```

Then open Settings → Plugins → **Tencent Cloud ADP** and fill in credentials (next section). Install issues (stale plugin name, pnpm build approval): [docs/pitfalls.md](docs/pitfalls.md#install).

## Configure

ADP has three credential planes. The patch stores **reference names** (`ADP_API_KEY`, …); values live in `$DSH_HOME/.credentials.yaml` or the environment.

Official ADP API docs cover **control-plane AKSK** and **AppKey SSE chat**. They do not document the OpenAI-shaped model gateway this plugin also uses. Endpoints and key sources: [API overview](https://cloud.tencent.com/document/product/1759/133868). Planes and error codes: [docs/credentials.md](docs/credentials.md).

![Settings → Plugins → Tencent Cloud ADP card](assets/screenshot-settings.png)

| Plane | Reference | Official source | If missing |
| --- | --- | --- | --- |
| Tool Key | `ADP_API_KEY` | Create a Tool Key in the upper section of the site’s **Key Management** page | LLM / search / plugin **calls** fail with `MISSING_CREDENTIAL` |
| SecretId / SecretKey | `ADP_SECRET_ID` / `ADP_SECRET_KEY` | Public cloud: [CAM API keys](https://cloud.tencent.com/document/product/598/40488). Independent site: ADP console **Key Management** | Model / plugin / app **catalogs** stay empty |
| Per-app AppKey | `TENCENT_ADP_APP_KEY` (subagent default) or `ADP_APP_KEY_*` | [App publish → API management](https://cloud.tencent.com/document/product/1759/104209) or app **Invoke** ([SSE](https://cloud.tencent.com/document/product/1759/105561)) | Subagent / ask tools cannot call the published app |

### 1. Open ADP

Register and complete real-name verification, then open the product ([product overview](https://cloud.tencent.com/document/product/1759/104193)). First login creates one enterprise and a **default workspace**; that workspace is not the string `default_space` this plugin ships in the patch ([workspace overview](https://cloud.tencent.com/document/product/1759/122569)).

| Site | Console | Control host | Agent SSE |
| --- | --- | --- | --- |
| **Independent site** | [adp.tencent.com](https://adp.tencent.com) | `capi.adp.tencent.com` | `https://adp.tencent.com/adp/v2/chat` |
| **Public cloud** | [adp.cloud.tencent.com](https://adp.cloud.tencent.com) | `adp.tencentcloudapi.com` | `https://wss.lke.cloud.tencent.com/adp/v2/chat` |

Both sites complete against `https://api.adp.cloud.tencent.com/chat/completions` (no `/v1`). There is no `api.adp.tencent.com`.

### 2. Get SecretId / SecretKey

**Public cloud** — CAM `AKID…` key (36 characters):

1. Open [CAM → API Key Management](https://console.cloud.tencent.com/cam/capi).
2. Create a key if the list is empty ([root account access keys](https://cloud.tencent.com/document/product/598/40488)). Copy **SecretId** and **SecretKey** at creation time; SecretKey is shown only once after 2023-11-30.
3. Sub-accounts need ADP (formerly Large Model Knowledge Engine) read/write on the CAM role ([FAQ](https://cloud.tencent.com/document/product/1759/109469)). Collaborator accounts are not supported ([122569](https://cloud.tencent.com/document/product/1759/122569)).

**Independent site** — ADP console key (~26 characters, **not** `AKID`):

1. Sign in at [adp.tencent.com](https://adp.tencent.com).
2. Open **Key Management** and copy SecretId / SecretKey ([API overview · independent site](https://cloud.tencent.com/document/product/1759/133868)).

That pair signs control-plane calls (`DescribeModelList`, `DescribeSpaceList`, marketplace). It is not `ADP_API_KEY`.

### 3. Get the Tool Key (`ADP_API_KEY`)

- **Independent site**: open [Key Management](https://adp.tencent.com/adp#/key-manage) and create a Tool Key in the upper section.
- **Public cloud**: open [Key Management](https://adp.cloud.tencent.com/adp#/key-manage) and click **Create Tool Key** in the upper section.

The Tool Key is used for Hunyuan / DeepSeek completions, Hunyuan search, and API/MCP plugin calls.

### 4. Optional: AppKey

Used by `subagent_adp` and `adp_ask` / `adp_ask_<slug>` (SSE to a published app), not for picking `adp:Hunyuan/hy3`. The provider migrated from `dsh-plugin-subagent` keeps its original default reference name, `TENCENT_ADP_APP_KEY`.

1. Publish the app.
2. Open **App Publish → Service Status → API Management**, or **App Management → Invoke**, and copy AppKey ([104209](https://cloud.tencent.com/document/product/1759/104209), [105560](https://cloud.tencent.com/document/product/1759/105560)).

### 5. Fill the DSH card

1. Run `dsh web` on loopback (`127.0.0.1`). Credential writes are loopback-only.
2. Settings → Plugins → **Tencent Cloud ADP**.
3. Choose **Independent site** or **Public cloud**.
4. Paste the Tool Key, SecretId, and SecretKey. Save. Values go through `credentials.set` into `$DSH_HOME/.credentials.yaml`.
5. After AKSK is stored, the card lists workspaces from `DescribeSpaceList`. Pick one. Public-cloud app and plugin calls need a real **SpaceId**; the patch default `default_space` is not a workspace on most accounts (control-plane `4510004`). If the list is empty, paste a SpaceId from the ADP console ([workspaces](https://cloud.tencent.com/document/product/1759/122576)).
6. Paste AppKey if you will use ask tools. Save again.

A Claw-style “build the app entirely via API” walkthrough (CreateSpace → CreateApp → CreateAgent → CreateRelease → chat) is [133869](https://cloud.tencent.com/document/product/1759/133869). That path is AppKey SSE, not this plugin’s gateway adapter.

## What you get

`adp-core`, `llm-adp`, `web-adp`, `plugins-adp`, `skills-adp`, `control-adp`, `subagent-adp`, and `tool-subagent-adp` start with the plugin. `agents-adp` remains available from the package's `/agents` entry but is not loaded by the default bundle:

![Model picker — Tencent Cloud ADP group](assets/screenshot-models.png)

- Select `adp:Hunyuan/hy3` (or another gateway model) and complete a tool-using turn. How catalog vs completions are wired: [docs/seams.md](docs/seams.md#how-models-work-llm-adp).
- `web_search` through Hunyuan AI search when this provider is selected (China-centric index).
- Enable an API or MCP marketplace plugin via `adp_plugin_list` / `adp_plugin_enable`, or `enabledPluginIds`. Public-cloud plugin/app calls need the workspace chosen above.
- Generated media links (~24h COS) are saved into the workspace as `saved_files`.
- Skill plaza as a `ctx.skills` provider (entries without download URLs stay in `list` only).
- Optional `agents-adp` provides `adp_provision_agent` and `adp_ask` / `adp_ask_<slug>`; manually load `@tencentcloudadp/dsh-adp/agents` when the legacy plain-tool mode is needed.
- `subagent_adp` — run a published ADP app as a real DSH child Agent; reasoning, remote tool traces, and the final reply are projected into its native child session. Its AppKey defaults to `TENCENT_ADP_APP_KEY`; unless `endpoint` is explicit, every run follows the active `adp-core` site's SSE URL.
- `adp_list_actions` / `adp_call` with `allowMutating` for App/Agent/Release CRUD. Mutating calls require approval.

## Documentation

- [docs/credentials.md](docs/credentials.md) — where each key comes from and what breaks without it
- [docs/seams.md](docs/seams.md) — contracts between this plugin and DSH
- [docs/pitfalls.md](docs/pitfalls.md) — known traps
- [docs/verification.md](docs/verification.md) — manual checklist

## Verify

```sh
pnpm test         # simulated HTTP; no secrets; CI gate
pnpm test:live    # real account; skips when env is absent
```

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/TencentCloudADP/Tencent-ADP-dsh-plugin). Run `pnpm test` before opening a PR.

## License

MIT. Copyright (C) 2026 Tencent. See [LICENSE.txt](LICENSE.txt) for the text and third-party notices (`eventsource-parser`, `fflate`).
