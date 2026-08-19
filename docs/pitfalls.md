# Pitfalls (must stay in code)

Ported from adpworker `CONTRIBUTING-ADP.md` and `docs/ADP-接口盘点与需求.md`. Each item names the fixture that pins it.

## Install

- `dsh plugin add` records the **package.json name** (`@tencent/dsh-adp`), not the folder name, and injects `cordis.patch.yml` as one profile bundle layer. Do not also pass `--patch ./cordis.patch.yml`, and do not copy those rows into the profile's `cordis.patch.yml` — either duplicates loader id `adp-core` and `dsh web` fails.
- If this checkout was already linked under another name (the folder alias `adp-dsh-plugin` is the usual leftover), remove the old name, then add once: `dsh plugin --profile web remove adp-dsh-plugin`.
- `~/.dsh/profiles/web/package.json` must list `@tencent/dsh-adp` once under both `dependencies` and `dsh.profile.bundles`. A profile `cordis.patch.yml` row that still says `name: adp-dsh-plugin` (even under a leftover id such as `mcp-tencent-cloud-docs`) is not this bundle — delete it; it re-registers `ctx.adp`.
- Git installs fetch source and run `prepare` (tsdown). pnpm ≥10 blocks that until the package is listed under `allowBuilds` in the profile's `pnpm-workspace.yaml`. A `pnpm pack` tarball is already compiled and does not need that allowance.
- After editing this checkout, run `pnpm run prepare` (or `pnpm test`) and restart `dsh web`; the profile link loads `lib/`, not `src/`.

1. **Plugins are MCP *and* API.** Only wiring MCP drops half the marketplace. API tools live at `ToolConfig.ApiToolConfig.ExternalApiUrl`. Fixture: `tests/fixtures/control/plugin-detail-api.json`.

2. **`MCPTransport` 0 = SSE, 1 = streamable-http.** POST to an SSE endpoint is 405. Never silently retry the other transport. Fixture / sim: `sim-plugin-mcp-405`.

3. **Availability is `DescribePlugin` only.** Catalogue `AllowExternalAccess` is `false` even for working plugins. Fixture: `tests/fixtures/control/plugin-summary-page0.json` (false) vs `plugin-detail-usable.json` (URL present). Sim: `sim-plugin-filter`.

4. **API responses may be cumulative SSE.** `Accept: application/json` is ignored. Last `Data.Answer` wins; concatenating repeats the text. Fixture: `tests/fixtures/plugin/api-cumulative.sse`, `search-cumulative.sse`.

5. **Plugin catalogue `PageNumber` is 0-based.** Sending `1` as the first page looks like “no results” next to a non-zero `TotalCount`. Fixture: page0 + page1 JSON. Sim: `sim-plugin-list`.

6. **Account envelope is `reqId/code/data`, not PascalCase.** Fixture: `tests/fixtures/account/lowercase.json`. OneID login-url is proxied at `/adp/account/login-url` for the settings card; it does not fill the three keys. Fixture: `tests/fixtures/account/login-url.json`. Do not `export default AdpService` from the package entry: `Loader.unwrapExports` would load the class and skip `apply`, so the proxy never registers and `dsh web` answers POST with 405 empty. Sim: `sim-export`.

7. **MCP idle ~600s, no ping.** Reconnect on idle. Fast fail (&lt;3s, request likely never arrived) may retry; a call that ran for a while must not auto-retry (may already be billed).

8. **Generation COS links expire ~24h.** Harvest into the workspace; canonical value carries `saved_files`. Sim: `sim-media`.

9. **Three keys do not substitute.** SSE chat still needs AppKey. Sim: `sim-cred-missing`, `sim-appkey-absent`.

10. **Skill detail examples often omit `SkillUrl` / `SkillMarkdownUrl`.** Empty URL → `list` only, never use `Profile.Description` as the body. Fixtures: `skill-detail-empty.json`, `skill-detail-md.json`. Sim: `sim-skill-empty-url`, `sim-skill-md`.

11. **`DescribeApp.SecretInfo` needs `FieldMask.Paths=["SecretInfo"]`.** Without it, null. May also be empty before release finishes. Fixtures: `describe-app-no-mask.json`, `describe-app-with-mask.json`. Sim: `sim-appkey-mask`.

12. **Agent/App edits do not take effect until `CreateRelease`.** Release is async (Status 3 success / 4 fail). Poll via `ctx.jobs` (or inside the provision tool), never ask the model to sleep. Sim: `sim-provision`.

13. **Claw models are `ModelScene=18`, not Agent thinking `3`.**

14. **`adp-core` is a function plugin (`name` / `inject` / `apply`), same as `llm-adp`.** A class default export is eaten by the loader. Sim: `sim-export`.

15. **独立站 / 公有云 switches control + SSE, not the model gateway.** Completions stay on `api.adp.cloud.tencent.com` and still need a gateway `sk-`. Independent-site console SecretId/SecretKey is not `ADP_API_KEY`. Sim: `adp site proxy`.

16. **Site settings wait for `adp`, not only `settings`.** `ctx.inject(['settings'])` can run before `AdpService` provides `adp`. Then `registerSiteSettings` no-ops, `settings.update('adp-core')` throws, and `dsh-host-webserver` answers POST `/adp/site` with an empty 400. Inject `['settings', 'adp']`. Sim: `sim-site-settings`.

17. **Public-cloud `DescribeSkillSummaryList` rejects `FilterList.Perspective`.** Official body is `{ SpaceId, PageNumber, PageSize }`. Perspective defaults to USER and is only legal with custom ProviderType. `DescribeSpaceList` has no `PageNumber`. Live: `tests/live/cloud-e2e.test.ts`.

18. **Model gateway path is `/chat/completions`, not `/v1/chat/completions`.** Official ADP docs only cover CAM control + AppKey SSE (`wss.lke…/adp/v2/chat`). The OpenAI-shaped host is `api.adp.cloud.tencent.com` with **no** `/v1` prefix (adpworker `OpenAIProvider` base_url). `/v1/chat/completions` returns 401 `not_authorized` for a key that 403s `AccountOverdueError` on the unprefixed path. Live: `tests/live/cloud-e2e.test.ts`.

19. **Public-cloud `SpaceId` is a real workspace, not `default_space`.** `cordis.patch.yml` still defaults `spaceId: default_space`. Cloud AKSK injects that value into space-scoped list/create calls, and `DescribeAppSummaryList` / `DescribePluginSummaryList` then return `4510004 空间信息不存在` if it is wrong. Pick a workspace on the Settings card (stored as `adp-core.spaceId`). Completions do not use SpaceId; apps and plugins do. **Do not send SpaceId on AppId-scoped actions** (`DescribeApp`, `DeleteApp`, `CreateAgent`, `DescribeAgentSummaryList`, `CreateRelease`, `DescribeReleaseSummary`, …) — they return `UnknownParameter`. Sim: `sim-spaceid-scope`. Live: `tests/live/cloud-e2e.test.ts`.

20. **`DescribeModelList` ids live under `ModelBasic`.** Public-cloud **and independent-site** `DescribeModelList` rows are `{ ModelBasic: { ModelId, ModelName, … } }`. Reading only top-level `ModelId` yields an empty list and `listModels` silently returns builtins. Independent-site `ListModel` uses `ModelName` (no `ModelId`). Fixture: nested rows in `tests/unit/sim.test.ts` `normalizeModelList`. Live: `tests/live/cloud-e2e.test.ts`, `tests/live/standalone-e2e.test.ts`.

21. **Independent-site completions use the same cloud gateway.** There is no `api.adp.tencent.com`. A 401 `AuthenticationError`（凭证无效或已过期）on `POST /chat/completions` means that API key is dead; 401 `not_authorized` is the `/v1` path bug. A valid gateway `ADP_API_KEY` completes independent-site catalog ids (`Deepseek/deepseek-v4-flash`, `Hunyuan/hy3`, …) on `api.adp.cloud.tencent.com`. Live: `tests/live/standalone-e2e.test.ts`.

22. **`CreateAgent` takes nested `Agent`, not top-level `Name`.** Official body is `{ AppId, Kind, Agent: { Profile: { Name, Role }, Instructions, Model: { ModelId }, PluginList: [{ PluginId }], SkillList: [{ SkillId }] } }`. A flat `Name` returns `UnknownParameter`. Claw models come from `DescribeModelList` `ModelScene=18`. Sim: `sim-provision`. Live: `tests/live/cloud-e2e.test.ts`.

23. **`DescribeReleaseSummary` requires `ReleaseId`.** Official body is `{ AppId, ReleaseId }`. `CreateRelease` returns `ReleaseId`; polling with only `AppId` is `MissingParameter`. Status is `ReleaseSummary.Status` (`3` published, `4` failed). Sim: `sim-provision`. Live: `tests/live/cloud-e2e.test.ts`.

24. **`adp_call` payload must be an object.** Models often stringify `type: json` args. A string body used to become `{}` and then `MissingParameter`. Parse JSON strings; keep objects. Sim: `sim-adp-call-json-string`.

25. **App lists paginate with `PageNumber` / `PageSize`, 0-based.** `Offset` / `Limit` are ignored. `TotalCount` of hundreds with 15 rows means the first page only. Same for `DescribePluginSummaryList` (pitfall 5). `DescribeAgentSummaryList` is AppId-scoped and rejects `SpaceId`.
