# Verification

## Simulated (CI gate)

```sh
pnpm test
```

No Tencent credentials. HTTP is mocked at the process boundary (`tests/mock/http.ts`); `defineTool`, Loader, SSE assembly, and credential error codes are real.

### P0

- [ ] `sim-sign` — TC3 canonical string differs after host/vendor switch (fixed payload)
- [ ] `sim-cred-missing` — no `sk-`: route remains, call is `MISSING_CREDENTIAL`
- [ ] `sim-cred-bad` — `INVALID_CREDENTIAL`; key not in the error
- [ ] `sim-llm-sse` — usage before finish; tool-call `arguments` is a JSON string
- [ ] `sim-web-sse` — last-frame `Answer`; `presentResult` is `card: 'web', kind: 'search'`
- [ ] `sim-plugin-list` — `PageNumber` starts at 0; second page kept
- [ ] `sim-plugin-filter` — list `AllowExternalAccess=false` but detail URL kept; no URL / empty header dropped
- [ ] `sim-plugin-api-sse` — canonical value is the last frame
- [ ] `sim-plugin-mcp-405` — wrong transport → 405, no silent retry
- [ ] `sim-media` — `saved_files` exists on disk
- [ ] `sim-hmr` — disposing the plugin fiber removes tools
- [ ] `sim-pack` — `node lib/` without tsx; invalid Config non-zero; `lib/client.js` is a ModuleLoader factory; `dsh.client` + `exports["./client"]`
- [ ] `sim-export` — function plugins including `adp-core` have no `default`; `unwrapExports` uses `apply`, not the `AdpService` class
- [ ] `sim-login-url-proxy` — GET/POST proxy returns JSON; empty/non-JSON client parse does not throw
- [ ] `sim-patch-ids` — `cordis.patch.yml` insert ids are unique; applying the layer twice is `duplicate loader entry id: adp-core`
- [ ] `sim-login-url` — `fetchLoginUrl` posts `{login_platform:"oneid"}` and unwraps `login_url`
- [ ] `sim-site-settings` — site section injects `['settings', 'adp']`; settings.update failure is JSON 500, not an empty 400
- [ ] `sim-plugin-item-slot-key` — client `settings.plugin.item` register uses `key: 'adp-core'` (DSH ≥ 0.1.0-rc.7 keyed slot); `lib/client.js` ships that key
- [ ] `normalizeModelList` — flat `ModelId` and nested `ModelBasic.ModelId` both yield ids; empty `ModelBasic` is skipped

### P1

- [ ] `sim-provision` — CreateApp → Agent → CreateRelease `ReleaseId` → DescribeReleaseSummary `{ AppId, ReleaseId }`; then FieldMask secret
- [ ] `sim-spaceid-scope` — cloud AKSK fills SpaceId on lists, not DescribeApp / DescribeAgentSummaryList
- [ ] `sim-adp-call-json-string` — stringified `payload` is parsed, not dropped as `{}`
- [ ] `sim-appkey-mask` — without FieldMask `SecretInfo` empty; with it, AppKey
- [ ] `sim-appkey-absent` — failure text is “cannot get AppKey”; no fake ask tool
- [ ] `sim-ask-sse` — interleaved thought+reply; model sees reply only
- [ ] `sim-ask-file` — Claw `Type=file` saved into workspace
- [ ] `sim-mutating-gate` — DeleteApp unapproved does not call the control plane
- [ ] `sim-skill-empty-url` — listed, `get` is not Description-as-body
- [ ] `sim-skill-md` — `SkillMarkdownUrl` becomes markdown content

Loader composition lives in `tests/composition/`. Product-visible plugins are started through Loader + mock hosts, not a hand-rolled `ctx.plugin` of the row under test alone (stubs for credentials / systemPrompt / llm / web / tools / skills are test infrastructure).

## with-key (optional)

```sh
pnpm test:live
```

Skips when env is missing. Does **not** replace the matching `sim-*`.

Suggested env: `ADP_API_KEY`, and for catalog tests `ADP_SECRET_ID` / `ADP_SECRET_KEY`. Public-cloud e2e (`tests/live/cloud-e2e.test.ts`) needs all three and sets `vendor: ChinaTencentCloud`.

Live checks (manual or `test:live`):

- [ ] `adp:Hunyuan/hy3` one tool-using turn
- [ ] `web_search` via Hunyuan; card replays
- [ ] public-cloud workspace picked (not `default_space`); `llm.models` ids match `DescribeModelList` / `ModelBasic`
- [ ] one API plugin and one MCP plugin; cancel stops the call
- [ ] generation tools return `saved_files` on disk
- [ ] no AKSK: model and search still work
- [ ] no `sk-`: catalog may load, calls are `MISSING_CREDENTIAL`
- [ ] unload the plugin row → tools / SkillProvider / MCP sessions gone
- [ ] `skills-adp` lists plaza entries (`DescribeSkillSummaryList` without Perspective)
- [ ] `control-adp` `adp_list_actions` + read `adp_call`; mutating stays gated
- [ ] `agents-adp` CreateApp → CreateAgent → CreateRelease → poll `ReleaseId` → SSE ask; delete throwaway `dsh-e2e-*` apps. If CreateApp is `4900001` (account quota), live-check `DescribeReleaseSummary` with a real `ReleaseId` on an existing running app, then SSE ask.
