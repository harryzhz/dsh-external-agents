# dsh-external-agents

面向 DeepSeek Harness (DSH) Desktop 与 Web 的可插拔外部 CLI Agent 运行时插件（内置 Codex / Antigravity / Claude Code / TRAE CLI，支持声明任意 `codex-app-server` 或 ACP 协议运行时）。

## 仓库分层（防腐层架构）

- `packages/runtime/codex`（`@dsh-external-agents/runtime-codex`）— 纯 TS `codex app-server` JSON-RPC 客户端（零 DSH 依赖）
- `packages/runtime/acp`（`@dsh-external-agents/runtime-acp`）— 纯 TS 通用 ACP（Agent Client Protocol）stdio JSON-RPC 客户端，支持能力协商与 `session/resume` → `session/load` → `session/new` 自动回退（零 DSH 依赖）
- `packages/plugin`（`@dsh-external-agents/plugin`）— 薄 DSH Host 插件：包装 `AgentLoop`、通过 `ExternalRuntimeRegistry` 统一管理可插拔外部运行时、映射流式事件/工具调用/审批/提问并发布 `ctx.externalRuntimes`
- 根包 `@harryzhz/dsh-external-agents`（`package.json` + `cordis.patch.yml` + `scripts/prepare.mjs`）— 面向 DSH Desktop / Web「添加插件」发布的零运行期依赖独立 Bundle（支持 GitHub 仓库直装 / Release `.tgz` / 本地目录安装）

## 目录组织规范

- **运行时协议目录统一归口至 `packages/runtime/<protocol>`**：所有纯协议/传输层运行时客户端（当前为 `packages/runtime/codex`、`packages/runtime/acp`，以及后续新增的其他协议）一律放在 `packages/runtime/<protocol>/` 下，**禁止**以 `packages/runtime-<protocol>` 平铺在 `packages/` 根目录。
  - 包名统一为 `@dsh-external-agents/runtime-<protocol>`（`private: true`）。
  - `tsconfig.json` 统一继承 `../../../tsconfig.base.json`。
  - `pnpm-workspace.yaml` 保持 `packages/*` + `!packages/runtime` + `packages/runtime/*` 匹配规则。
  - 新增协议包时，同步在 `packages/plugin/package.json`（`file:../runtime/<protocol>`）与 `scripts/prepare.mjs` 的 `workspaceAliasPlugin` 中登记别名映射。

## 工程约束

- 核心协议层（`packages/runtime/*`）不得反向依赖任何 `@deepseek-ai/*` 包。
- 根包 `cordis.patch.yml` 仅禁用并包装 `agent-loop` 及追加外部运行时预设，禁止覆盖用户默认的 `agent-default-model`、`agent-preset-registry.default`、`session-title-llm` 或 `ui-settings-general`。
- 根包 `package.json` 必须保持 `dependencies: {}`（零运行期外部依赖），且 `devDependencies` 不引入 `@deepseek-ai/*`，确保 Git 仓库直装时 `prepare` 脚本极速构建。
- 启动依赖 macOS Keychain 的子进程（如 `agy acp`）时启用 `stripSshEnv: true`，剥离 `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY`（保留 `SSH_AUTH_SOCK`）。
- 启动 `codex app-server` 冷恢复 `thread/resume` 时，除非用户显式切换模型，不得重传 model/reasoning_effort 覆盖参数。
- 本地研发临时产物与打包 tarball 统一输出至 `.local/`（已被 gitignore）。

## 安全与开源隐私规范

本仓库面向 GitHub 公开发布，所有代码、测试、文档与提交说明须严格遵守 [SECURITY.md](./SECURITY.md) 与以下红线：

1. **禁止提交任何非公开信息**：
   - 运行时集成仅依赖公开文档化的官方 CLI 命令、协议与配置，严禁引入任何非公开命令、私有端点、公司内部镜像源或未公开配置。
   - 严禁提交任何 API Key、OAuth Token、Cookie、私钥、`.env`、真实个人姓名/邮箱、宿主机真实绝对路径（如 `/Users/<真实用户名>`）以及真实业务日志或内部系统代号。
   - 严禁在注释、测试或文档中提及或暗示任何非公开/内部版本的存在；所有集成均仅基于公开文档化接口表述。
2. **测试夹具与示例脱敏约定**：
   - 测试域名统一使用 RFC 2606 保留域名（`example.com`），测试路径使用 `/Users/demo/...`、`/opt/...` 或系统临时目录，测试地址优先使用回环地址 `127.0.0.1` 或 RFC 5737 文档网段（`192.0.2.x`、`198.51.100.x`、`203.0.113.x`）。
3. **依赖与锁文件审查**：
   - 更新 `pnpm-lock.yaml` 时确保仅解析自公开官方 `registry.npmjs.org`，不得引入私有 registry URL 或内部包。
4. **提交与发布门禁**：
   - 任何提交或 PR 合并前必须通过 `pnpm run check:privacy`（CI 强制执行）；个人开发机可在被 gitignore 的 `.local/privacy-denylist.txt` 中维护本地敏感词黑名单，由脚本自动叠加校验，严禁将私有词表提交到仓库。
   - 提交前核对 `git config user.name` 与 `git config user.email` 符合个人公开身份策略；若误提交敏感信息，立即轮换/吊销凭据并清理 Git 历史后再推送。
