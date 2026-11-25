# dsh-external-agents

面向 DeepSeek Harness (DSH) Desktop 与 Web 的可插拔外部 CLI Agent 运行时插件（内置 Codex / Antigravity / Claude Code / TRAE CLI，支持任意 `codex-app-server` 或 ACP 协议运行时）。

## 开发工作流（默认规则）

- **Worktree + 分支 + PR**：新需求或修复默认基于最新 `origin/main` 在 `.worktrees/<slug>` 新建独立 worktree 与功能分支（如 `feat/<slug>`、`fix/<slug>`、`docs/<slug>`）开发，**禁止直接在 `main` 分支提交**（除非用户明确要求）。完成后推送分支并向 `main` 发起 GitHub PR，验证与 CI 通过后自动合入 `main`、清理 worktree 与已合并分支并按需优雅重启服务（详见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)）。
- **临时产物目录**：本地研发脚本、调试日志与打包 `.tgz` 统一输出至 `.local/`（已 gitignore），严禁污染仓库根目录。
- **合并前门禁**：提交与发起 PR 前必须全部通过：
  ```bash
  pnpm build && pnpm typecheck && pnpm test && pnpm run check:privacy
  ```
- **端到端真实验证与自动合入重启**：除纯文档修改外，每个 PR 合入 `main` 前优先在独立隔离的本地 E2E DSH Web 实例（独立 `DSH_HOME`、独立端口与专用测试机器人/测试群，直接挂载当前 PR worktree 产物，不干扰正式环境）完成真实浏览器与飞书双机器人端到端实测；未配置独立 E2E 实例时再回退至飞书触发群或用户显式指定的验收群（**严禁将任何真实群名称、群 ID、测试机器人 ID 或宿主机路径写入文档、代码、测试或 PR**）。全部门禁、CI 与端到端验收通过后自动将 PR 合入 `main`、同步构建并优雅排空重启正式本地 DSH 服务（详见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md#2-端到端真实验证与自动合入重启)）。

## 核心红线（每次必守）

- **防腐层边界**：`packages/runtime/*` 不得依赖任何 `@deepseek-ai/*` 包；所有纯协议运行时客户端统一归口 `packages/runtime/<protocol>`，禁止在 `packages/` 根目录平铺 `runtime-<protocol>`。
- **零运行期依赖根包**：根包 `package.json` 保持 `dependencies: {}` 且 `devDependencies` 不引入 `@deepseek-ai/*`；`cordis.patch.yml` 仅禁用并包装 `agent-loop` 及追加外部预设，不得覆盖用户默认模型、预设、标题模型与通用设置。
- **开源与隐私红线**：本仓库面向 GitHub 公开，仅集成官方公开文档化的 CLI 与协议；严禁提交任何凭据、非公开命令/端点、私有 registry URL、真实个人信息或宿主机真实绝对路径，提交前必过 `pnpm run check:privacy`（详见 [SECURITY.md](./SECURITY.md)）。

## 文档索引（按任务按需阅读）

| 涉及场景 | 文档 | 内容摘要 |
| --- | --- | --- |
| 新建 worktree / 提 PR / 打包发布 / 隐私自检 | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Worktree + 分支 + PR 标准步骤、Commit 约定、常用脚本与脱敏自检清单 |
| 改动架构 / 新增协议包 / 调整运行时行为 | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 仓库分层、`packages/runtime/<protocol>` 规范、`cordis.patch.yml` 与 Keychain / `thread/resume` 约束 |
| 涉及凭据、测试示例数据或安全边界 | [SECURITY.md](./SECURITY.md) | 运行期安全边界、开源防泄露基线与漏洞披露流程 |
