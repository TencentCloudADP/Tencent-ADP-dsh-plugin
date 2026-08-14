# @tencent/dsh-adp

[English](README.md) · [中文](README.zh-CN.md)

把腾讯云 ADP 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的树外 Cordis 插件包。不是 ADP Worker。

## 安装

```sh
dsh plugin --profile web add .
# or: dsh plugin --profile web add ./tencent-dsh-adp-0.1.0.tgz
dsh --profile web --dump-config    # 应只出现一层 "# == @tencent/dsh-adp"
dsh web
```

`dsh plugin add` 按 **package.json 的 `name`**（`@tencent/dsh-adp`）记账，不是目录名，并把 `cordis.patch.yml` 注入为 **一层** profile bundle。不要再 `--patch ./cordis.patch.yml`，也不要把这些行抄进 profile 的 `cordis.patch.yml`。任一做法都会让 loader id `adp-core` 重复，`dsh web` 起不来。

如果这个目录曾经用别的名字链进过 profile（常见残留是目录别名 `adp-dsh-plugin`），先删旧名，再 add 一次：

```sh
dsh plugin --profile web remove adp-dsh-plugin
dsh plugin --profile web add .
```

`~/.dsh/profiles/web/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里都只应出现一次 `@tencent/dsh-adp`。若 profile 的 `cordis.patch.yml` 里还有 `name: adp-dsh-plugin` 的行（哪怕 id 是残留的 `mcp-tencent-cloud-docs`），删掉——那不是本 bundle，会再次注册 `ctx.adp`。

从 git 安装会拉源码并跑 `prepare`（tsdown）。pnpm ≥10 会拦住构建，直到在 profile 的 `pnpm-workspace.yaml` 里把本包装进 `allowBuilds`。`pnpm pack` 打出的 tarball 已经编译过，不需要这项许可。

## 三把钥匙

ADP 有三把钥匙，不能互相顶替。配置里只写**引用名**（`ADP_API_KEY` 等）；真正的值放在 `$DSH_HOME/.credentials.yaml` 或环境变量。

在 `dsh web` 里：设置 → 插件配置会出现「腾讯云 ADP」卡片。先选 **独立站** 或 **公有云**，再把钥匙贴进去。保存会经 `credentials.set` 写入 `$DSH_HOME/.credentials.yaml`。OneID 会在新标签页打开 ADP，**不会**填这三把钥匙。

| 平面 | 引用名 | 缺了会怎样 |
| --- | --- | --- |
| 网关 `sk-` | `ADP_API_KEY` | LLM 和插件路由仍会注册；真正调用时报 `MISSING_CREDENTIAL` |
| SecretId / SecretKey（AKSK） | `ADP_SECRET_ID` / `ADP_SECRET_KEY` | 目录为空；已经配好的 API/MCP URL 和搜索仍可用 |
| 按应用的 AppKey | 例如 `ADP_APP_KEY_DEMO` | 对应的 ask 工具不会注册 |

详见 [docs/credentials.md](docs/credentials.md)。

## 装上即用

`adp-core`、`llm-adp`、`web-adp`、`plugins-adp` 随插件启动：

- 选 `adp:Hunyuan/hy3`（或其他网关模型），完成一轮带工具调用的对话。
- 当前 provider 选中时，`web_search` 走混元 AI 搜索（偏国内索引）。
- 用 `adp_plugin_list` / `adp_plugin_enable` 或 `enabledPluginIds` 打开市场里的 API / MCP 插件。
- 生成类媒体链接（COS，约 24 小时过期）会落到工作区 `saved_files`。

## 默认关闭

`skills-adp`、`agents-adp`、`control-adp` 随包带 `disabled: true`。要打开某一行，把整行写进 profile 的 `cordis.patch.yml`，并去掉 `disabled: true`。补丁按行替换，不做深合并。会改控制面的调用需要审批。

打开后可用：

- `adp_provision_agent` — CreateApp → CreateAgent → CreateRelease → FieldMask 取 AppKey → `adp_ask_<slug>`
- `adp_ask` / `adp_ask_<slug>` — SSE 问答；不是 DSH 子 agent
- 技能广场作为 `ctx.skills` provider（没有下载 URL 的条目只出现在 `list`）
- `adp_list_actions` / `adp_call`，配合 `allowMutating` 做 App/Agent/Release 的增删改

## 本插件没有的

OneID 登录填不了这三把钥匙（设置卡片上写明了）。云端 agent 调不了本机 DSH 工具。Code 类插件不会在 DSH 里跑。

## 验证

```sh
pnpm test         # 模拟 HTTP；不需要密钥；CI 门禁
pnpm test:live    # 真实账号；环境变量缺失则跳过
```

清单：[docs/verification.md](docs/verification.md)。对接：[docs/seams.md](docs/seams.md)。踩坑：[docs/pitfalls.md](docs/pitfalls.md)。
