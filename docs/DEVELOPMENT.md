# 开发与协作规范

本文档说明 `dsh-external-agents` 的日常分支协作流程、本地验证打包命令与开源隐私提交自检清单。

## 1. Worktree + 分支 + PR 工作流

`main` 分支始终保持可构建、可发布状态。除用户明确指定在当前分支操作外，**所有新需求、Bug 修复、重构与文档变更均默认通过独立 Git Worktree + 功能分支开发，并通过 GitHub PR 合入 `main`**。

### 分支与目录命名

- **Worktree 路径**：统一放在仓库内 `.worktrees/<slug>`（已被 `.gitignore` 与 `vitest.config.ts` 忽略）。
- **分支前缀**：`feat/<slug>`、`fix/<slug>`、`refactor/<slug>`、`docs/<slug>`、`chore/<slug>`。

### 标准步骤

1. **同步远端主干并创建 Worktree 与分支**：
   ```bash
   git fetch origin
   git worktree add .worktrees/<slug> -b feat/<slug> origin/main
   cd .worktrees/<slug>
   pnpm install
   ```
2. **完成开发并运行全量验证门禁**：
   ```bash
   pnpm build && pnpm typecheck && pnpm test && pnpm run check:privacy
   ```
3. **按 Conventional Commits 提交并推送分支**：
   - 提交前核对 `git config user.name` 与 `git config user.email` 符合个人公开身份策略。
   - 提交信息使用 `feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`、`chore(scope): ...` 格式。
   ```bash
   git push -u origin feat/<slug>
   ```
4. **向 `main` 发起 Pull Request 并执行端到端真实验证**：
   - 使用 `gh pr create --base main` 或在 GitHub 页面创建 PR，简要说明变更动机、核心改动与本地验证结果。
   - 确保 CI（`check:privacy`、`build`、`typecheck`、`test`、`pack`）全部通过，并按第 2 节完成真实环境端到端验证（纯文档变更除外）。
5. **验证通过后自动合入 `main`、同步构建、清理 Worktree 并优雅重启服务**：
   - 当门禁、GitHub CI 与端到端真实验证全部通过后，无需等待二次确认，直接自动合入 `main` 并清理工作树：
   ```bash
   gh pr merge <pr-number> --squash --delete-branch
   cd <主仓库根目录>
   git fetch origin && git checkout main && git pull --ff-only origin main
   pnpm build
   git worktree remove .worktrees/<slug>
   git branch -d feat/<slug> 2>/dev/null || true
   git worktree prune
   ```
   - 涉及运行时代码变更时，将主干构建产物同步至本地 DSH 运行环境并执行优雅排空重启与健康自检（纯文档变更无需重启）。

## 2. 端到端真实验证与自动合入重启

除纯文档变更外，本地交付前须完成真实环境端到端验证，通过后自动完成合入与重启闭环：

- **飞书端到端实测**：当任务由飞书端发起时，默认在当前触发任务所在的飞书群/话题实测；若用户显式提供了验收群，则在提供的验收群实测。**严禁将任何真实群名称、群 ID 或消息 ID 写入文档、代码、测试夹具或 PR 描述**；非飞书发起且未指定验收群时，先向用户确认，严禁向非测试业务群发送测试消息。
- **真实浏览器验证**：使用真实浏览器（如无头 Chrome / CDP / Playwright）访问本地 DSH Web，核验外部运行时预设展示、会话交互/轨迹渲染正常，且无 `pageerror`、`console.error` 或接口 4xx/5xx 报错。
- **优雅排空重启**：合入 `main` 并重新执行 `pnpm build`（若本地 profile 以 `file:` 挂载，同步更新对应运行期 `dist/`）后，先执行 `lark-bridge lifecycle drain --wait --reason "<reason>"`（飞书会话内发起时通过 `.local/` 下的脱离进程组脚本在当前回复送达后使用 `--allow-in-session` 执行，避免中断当前回合），排空后重启本地 DSH 托管服务并运行 `lark-bridge doctor` 验证。任一验证或排空异常均须立即中止自动合入或重启并回报失败原因。

## 3. 常用命令与目录约定

| 命令 | 说明 |
| --- | --- |
| `pnpm build` | 构建各子包并生成根目录独立 DSH Bundle（`dist/index.js`） |
| `pnpm build:bundle` | 仅执行 `scripts/prepare.mjs` 重新打包根目录 Bundle |
| `pnpm typecheck` | 全仓库 TypeScript 类型检查 |
| `pnpm test` | 运行 Vitest 单元测试（自动排除 `.worktrees/**` 与 `.local/**`） |
| `pnpm run check:privacy` | 运行零依赖开源隐私与密钥扫描（CI 强制门禁） |
| `pnpm run pack:bundle` | 生成可发布 `.tgz` 安装包（默认输出至 `.local/`） |
| `pnpm clean` | 清理各子包与根包构建产物 |

- **本地研发产物**：临时脚本、测试日志、本地打包 `.tgz` 统一放入 `.local/`（已 gitignore），不得污染仓库根目录或提交进 Git。

## 4. 开源隐私与提交自检清单

本仓库面向 GitHub 公开发布，完整安全边界见 [SECURITY.md](../SECURITY.md)。提交代码、测试、文档或依赖变更前逐项确认：

1. **仅基于公开接口**：运行时集成只依赖官方公开文档化的 CLI 命令、协议与配置；严禁引入非公开命令、私有端点或内部镜像源，严禁在注释、测试或文档中提及或暗示任何非公开/内部版本。
2. **零凭据与隐私数据**：严禁提交任何 API Key、OAuth Token、Cookie、私钥、`.env`、真实个人姓名/邮箱、宿主机真实绝对路径（如 `/Users/<真实用户名>`）、真实业务日志或内部系统代号。
3. **测试夹具脱敏约定**：
   - 测试域名统一使用 RFC 2606 保留域名（`example.com`）；
   - 测试路径使用 `/Users/demo/...`、`/opt/...` 或系统临时目录；
   - 测试地址优先使用回环地址 `127.0.0.1` 或 RFC 5737 文档网段（`192.0.2.x`、`198.51.100.x`、`203.0.113.x`）。
4. **依赖与锁文件审查**：更新 `pnpm-lock.yaml` 时确保仅解析自公开官方 `registry.npmjs.org`，不得带入私有 registry URL 或内部包。
5. **本地叠加密词拦截与误提交应急**：
   - 个人开发机可在被 gitignore 的 `.local/privacy-denylist.txt` 中维护额外敏感词黑名单，由 `pnpm run check:privacy` 自动叠加校验（严禁将该文件提交到仓库）。
   - 若误提交敏感凭据，必须第一时间吊销并轮换凭据，再清理 Git 历史后推送。
