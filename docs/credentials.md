# Credentials

Three keys, three planes. A value that works on one plane is rejected on the others.

Pick **独立站** (`ChinaTencentADP`) or **公有云** (`ChinaTencentCloud`) on the Settings → Plugins card (or `adp-core.config.vendor` in the patch). That switch is the control plane and the agent SSE host. The OpenAI-compatible model gateway stays `https://api.adp.cloud.tencent.com` for both — independent site has no separate `api.adp.tencent.com`.

Console paths (CAM vs ADP 密钥管理, workspace, AppKey) are in the README [Configure](../README.md#configure) / [配置：独立站 / 公有云](../README.zh-CN.md#配置独立站--公有云) section. Official: [API 概览](https://cloud.tencent.com/document/product/1759/133868), [工作空间](https://cloud.tencent.com/document/product/1759/122569), [CAM 密钥](https://cloud.tencent.com/document/product/598/40488).

| Site | Control host | Agent SSE | SecretId |
| --- | --- | --- | --- |
| 独立站 | `capi.adp.tencent.com` | `https://adp.tencent.com/adp/v2/chat` | ADP console key, ~26 chars, not `AKID` |
| 公有云 | `adp.tencentcloudapi.com` | `https://wss.lke.cloud.tencent.com/adp/v2/chat` | CAM `AKID…` (36 chars) |

`ADP_API_KEY` is a Tool Key, separate from the SecretId / SecretKey pair. Create it in the upper section of Key Management: [independent site](https://adp.tencent.com/adp#/key-manage) or [public cloud](https://adp.cloud.tencent.com/adp#/key-manage). Completions use it on `api.adp.cloud.tencent.com`; there is no `api.adp.tencent.com`. On the unprefixed path, HTTP 401 `AuthenticationError` means the Tool Key is invalid or expired; HTTP 401 `not_authorized` means the client posted `/v1/chat/completions`.

## Tool Key

- Env / credential-ref: `ADP_API_KEY` (`gatewayKeyEnv`)
- Completions URL: `POST https://api.adp.cloud.tencent.com/chat/completions` (same as adpworker). `POST …/v1/chat/completions` is a different route and returns 401 `not_authorized` even for a valid key.
- Used by: model completions, Hunyuan search, API plugin POST, MCP Bearer
- Missing: routes still register; `execute` / `stream` throw `MISSING_CREDENTIAL`
- Illegal (blank, control characters) or HTTP 401 AuthenticationError: `INVALID_CREDENTIAL`. The secret is never copied into the error message.
- HTTP 403 `AccountOverdueError` means the key authenticated; the model account needs credit. Search/plugins can still work.

`GET /models` on the gateway is 503; `GET /v1/models` is 404. Catalog comes from control-plane `DescribeModelList` (`ModelScene=3`) when AKSK is present. Public-cloud rows nest the id under `ModelList[].ModelBasic.ModelId`. Empty parse or missing AKSK falls back to the builtin matrix (`Hunyuan/hy3`, DeepSeek V4, GLM/Kimi/MiniMax), so the picker can look full without a live catalog. Completions still need the gateway key; see [docs/seams.md](seams.md#how-models-work-llm-adp).

## SecretId / SecretKey (TC3)

- Refs: `ADP_SECRET_ID`, `ADP_SECRET_KEY`
- Host:
  - `AKID…` (36-char cloud AKSK) → `adp.tencentcloudapi.com` unless `vendor` overrides
  - ADP console key → `capi.adp.tencent.com`
  - `vendor: International` → `adp.intl.tencentcloudapi.com`
  - `controlHost` for private / mock
- Cloud AKSK also needs `Region` (default `ap-guangzhou`) and a real `SpaceId`. The patch default `default_space` is not a workspace; public-cloud apps and plugins then fail with `4510004`. Pick a workspace on the Settings card (stored as `adp-core.spaceId`).
- `GetAppSecret` uses host `lke.tencentcloudapi.com`, version `2023-11-30`, service `lke`

## AppKey

- Per application, Bearer-equivalent for SSE chat
- `subagent-adp` keeps the legacy `dsh-plugin-subagent` default credential reference `TENCENT_ADP_APP_KEY`; override it with `subagent-adp.config.appKeyEnv` only when a different reference is intentional
- `agents-adp` accepts per-app references such as `ADP_APP_KEY_DEMO`
- Official fetch: `DescribeApp` with `FieldMask.Paths=["SecretInfo"]` → `App.SecretInfo.AppKey`
- Without FieldMask, `SecretInfo` is null (pinned in `tests/fixtures/control/describe-app-no-mask.json`)
- Fallback: LKE `GetAppSecret(AppBizId)`
- If both are empty after a successful release, `adp_provision_agent` returns `kind: "needs_appkey"` and does **not** register a fake ask tool. Paste the console value into a credential-ref and bind `agents-adp.agents[].appKeyEnv`.

AKSK cannot drive `/adp/v2/chat`. AppKey cannot sign the control plane. Paste keys on the card, store `TENCENT_ADP_APP_KEY` through the credentials service, or export it in the DSH process environment.

Do not put AppKey, Tool Key, or SecretKey samples in docs or fixtures.
