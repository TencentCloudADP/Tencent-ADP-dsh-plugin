# Credentials

Three keys, three planes. A value that works on one plane is rejected on the others.

Pick **独立站** (`ChinaTencentADP`) or **公有云** (`ChinaTencentCloud`) on the Settings → Plugins card (or `adp-core.config.vendor` in the patch). That switch is the control plane and the agent SSE host. The OpenAI-compatible model gateway stays `https://api.adp.cloud.tencent.com` for both — independent site has no separate `api.adp.tencent.com`.

| Site | Control host | Agent SSE | SecretId |
| --- | --- | --- | --- |
| 独立站 | `capi.adp.tencent.com` | `https://adp.tencent.com/adp/v2/chat` | ADP console key, ~26 chars, not `AKID` |
| 公有云 | `adp.tencentcloudapi.com` | `https://wss.lke.cloud.tencent.com/adp/v2/chat` | CAM `AKID…` (36 chars) |

Switching to 独立站 does not make that 26-character AKSK work as `ADP_API_KEY`. Completions still need a gateway key (usually `sk-`) on `api.adp.cloud.tencent.com`.

## Gateway `sk-`

- Env / credential-ref: `ADP_API_KEY` (`gatewayKeyEnv`)
- Used by: model completions, Hunyuan search, API plugin POST, MCP Bearer
- Missing: routes still register; `execute` / `stream` throw `MISSING_CREDENTIAL`
- Illegal (blank, control characters) or HTTP 401/403: `INVALID_CREDENTIAL`. The secret is never copied into the error message.

`GET /models` on the gateway is 503. Catalog comes from control-plane `DescribeModelList` when AKSK is present, otherwise the built-in matrix (`Hunyuan/hy3`, DeepSeek V4, GLM/Kimi/MiniMax).

## SecretId / SecretKey (TC3)

- Refs: `ADP_SECRET_ID`, `ADP_SECRET_KEY`
- Host:
  - `AKID…` (36-char cloud AKSK) → `adp.tencentcloudapi.com` unless `vendor` overrides
  - ADP console key → `capi.adp.tencent.com`
  - `vendor: International` → `adp.intl.tencentcloudapi.com`
  - `controlHost` for private / mock
- Cloud AKSK also needs `Region` (default `ap-guangzhou`) and `SpaceId` (default `default_space`)
- `GetAppSecret` uses host `lke.tencentcloudapi.com`, version `2023-11-30`, service `lke`

## AppKey

- Per application, Bearer-equivalent for SSE chat
- Official fetch: `DescribeApp` with `FieldMask.Paths=["SecretInfo"]` → `App.SecretInfo.AppKey`
- Without FieldMask, `SecretInfo` is null (pinned in `tests/fixtures/control/describe-app-no-mask.json`)
- Fallback: LKE `GetAppSecret(AppBizId)`
- If both are empty after a successful release, `adp_provision_agent` returns `kind: "needs_appkey"` and does **not** register a fake ask tool. Paste the console value into a credential-ref and bind `agents-adp.agents[].appKeyEnv`.

AKSK cannot drive `/adp/v2/chat`. AppKey cannot sign the control plane. OneID session tokens unlock none of the three. The Settings → Plugins card can open OneID in a browser tab; it still cannot write `ADP_API_KEY` / AKSK / AppKey from that session. Paste keys on the card (or into `$DSH_HOME/.credentials.yaml`).

Do not put AppKey, `sk-`, or SecretKey samples in docs or fixtures.
