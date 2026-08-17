# @tencent/dsh-adp

[English](README.md) · [中文](README.zh-CN.md)

Tencent Cloud ADP as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) out-of-tree Cordis plugin bundle. It is not ADP Worker.

## Install

```sh
dsh plugin --profile web add .
# or: dsh plugin --profile web add ./tencent-dsh-adp-0.1.0.tgz
dsh --profile web --dump-config    # look for one "# == @tencent/dsh-adp" layer
dsh web
```

`dsh plugin add` records the **package.json name** (`@tencent/dsh-adp`), not the folder name, and injects `cordis.patch.yml` as one profile bundle layer. Do not also pass `--patch ./cordis.patch.yml`, and do not copy those rows into the profile’s `cordis.patch.yml`. Either duplicates loader id `adp-core` and `dsh web` fails.

If this checkout was already linked under another name (the folder alias `adp-dsh-plugin` is the usual leftover), remove the old name, then add once:

```sh
dsh plugin --profile web remove adp-dsh-plugin
dsh plugin --profile web add .
```

`~/.dsh/profiles/web/package.json` must list `@tencent/dsh-adp` once under both `dependencies` and `dsh.profile.bundles`. If a profile `cordis.patch.yml` row still says `name: adp-dsh-plugin` (even under a leftover id such as `mcp-tencent-cloud-docs`), delete that row — it is not this bundle, and it re-registers `ctx.adp`.

Git installs fetch source and run `prepare` (tsdown). pnpm ≥10 blocks that until the package is listed under `allowBuilds` in the profile’s `pnpm-workspace.yaml`. A `pnpm pack` tarball is already compiled and does not need that allowance. After editing this checkout, run `pnpm run prepare` (or `pnpm test`) and restart `dsh web`; the profile link loads `lib/`, not `src/`.

## Credentials

ADP has three credential planes. They are not interchangeable. The patch stores **reference names** (`ADP_API_KEY`, …); values live in `$DSH_HOME/.credentials.yaml` or the environment.

In `dsh web`, Settings → Plugins shows a 腾讯云 ADP card. Choose **独立站** or **公有云**, pick a workspace, then paste keys. Save writes keys through `credentials.set` into `$DSH_HOME/.credentials.yaml`. OneID opens ADP in a new tab. It does not fill the keys.

| Plane | Reference | If missing |
| --- | --- | --- |
| Gateway `sk-` | `ADP_API_KEY` | LLM and plugin routes still register; a call fails with `MISSING_CREDENTIAL` |
| SecretId / SecretKey (AKSK) | `ADP_SECRET_ID` / `ADP_SECRET_KEY` | Catalogs are empty; already-configured API/MCP URLs and search still work |
| Per-app AppKey | e.g. `ADP_APP_KEY_DEMO` | The corresponding ask tool is not registered |

See [docs/credentials.md](docs/credentials.md).

## Out of the box

`adp-core`, `llm-adp`, `web-adp`, and `plugins-adp` start with the plugin:

- Select `adp:Hunyuan/hy3` (or another gateway model) and complete a tool-using turn. How catalog vs completions are wired: [docs/seams.md](docs/seams.md#how-models-work-llm-adp).
- `web_search` through Hunyuan AI search when this provider is selected (China-centric index).
- Enable an API or MCP marketplace plugin via `adp_plugin_list` / `adp_plugin_enable`, or `enabledPluginIds`. Public-cloud plugin/app calls need the workspace chosen above.
- Generated media links (~24h COS) are saved into the workspace as `saved_files`.

## Disabled by default

`skills-adp`, `agents-adp`, and `control-adp` ship `disabled: true`. To enable a row, put the full row in your profile `cordis.patch.yml` without `disabled: true`. Patches replace the row; they do not deep-merge. Mutating control-plane calls require approval.

Once enabled:

- `adp_provision_agent` — CreateApp → CreateAgent → CreateRelease → FieldMask AppKey → `adp_ask_<slug>`
- `adp_ask` / `adp_ask_<slug>` — SSE ask; not a DSH subagent
- Skill plaza as a `ctx.skills` provider (entries without download URLs stay in `list` only)
- `adp_list_actions` / `adp_call` with `allowMutating` for App/Agent/Release CRUD

## Not in this plugin

OneID login does not fill these credentials (the settings card says so). A cloud agent cannot call local DSH tools. Code-class plugins do not run inside DSH.

## Verify

```sh
pnpm test         # simulated HTTP; no secrets; CI gate
pnpm test:live    # real account; skips when env is absent
```

Checklist: [docs/verification.md](docs/verification.md). Contracts: [docs/seams.md](docs/seams.md). Pitfalls: [docs/pitfalls.md](docs/pitfalls.md).
