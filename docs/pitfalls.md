# Pitfalls (must stay in code)

Ported from adpworker `CONTRIBUTING-ADP.md` and `docs/ADP-接口盘点与需求.md`. Each item names the fixture that pins it.

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
