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
5. **验证通过后合入 `main` 并清理 Worktree（不直接替换正式服务）**：
   - 当门禁、GitHub CI 与端到端真实验证全部通过后，直接合入 `main` 并清理工作树：
   ```bash
   gh pr merge <pr-number> --squash --delete-branch
   cd <主仓库根目录>
   git fetch origin && git checkout main && git pull --ff-only origin main
   git worktree remove .worktrees/<slug>
   git branch -d feat/<slug> 2>/dev/null || true
   git worktree prune
   ```
   - 日常迭代合入后**不再直接替换或重启正式本地 DSH Web 服务**；正式环境统一通过 GitHub Release `.tgz` 安装，待发版后于凌晨低峰或按负责人明确要求执行免重启热更新。

## 2. 端到端真实验证与发布更新规范

除纯文档变更外，所有 PR 合入 `main` 前须完成真实环境端到端验证，通过后合入 `main`：

- **优先使用独立隔离的本地 E2E 实例**：推荐在本机维护与正式实例隔离的独立 E2E DSH Web 环境（独立 `DSH_HOME`、独立监听端口、独立测试机器人与专用测试群），直接挂载当前 PR worktree 的构建产物完成真实浏览器与飞书端到端实测，全程零干扰正式服务；多个并行 worktree 同时进入验收阶段时，通过本机互斥租约锁排队串行占用 E2E 实例，避免相互抢占与覆盖。
- **飞书端到端实测**：已配置独立 E2E 环境时，在专用测试群通过双机器人（或用户态驱动）向挂载 PR 产物的测试机器人发消息并核验完整入站、运行时调度与回复闭环；未配置独立 E2E 环境时，若任务由飞书端发起则默认在当前触发任务所在的飞书群/话题实测，或使用用户显式提供的验收群。**严禁将任何真实群名称、群 ID、消息 ID、测试机器人 ID 或宿主机路径写入文档、代码、测试夹具或 PR 描述**；非飞书发起且未配置 E2E/验收群时须先向用户确认，严禁向非测试业务群发消息。
- **真实浏览器验证**：使用真实浏览器（如无头 Chrome / CDP / Playwright）访问挂载当前 PR 产物的本地 DSH Web，核验外部运行时预设展示、会话交互/轨迹渲染正常，且无 `pageerror`、`console.error` 或接口 4xx/5xx 报错。
- **正式环境发布与免重启热更新**：正式 DSH Web 统一通过 GitHub Release `.tgz` 安装 `@harryzhz/dsh-external-agents`（启用 DSH 原生 HMR）；发布新版本（推送 `vX.Y.Z` tag）后，在凌晨低峰自动检查或按需通过「飞书桥接」插件 UI 或 `lark-bridge plugin update external-agents`（会话内加 `--detached`）完成免重启热更新，不干扰日常迭代期间的正式服务稳定性。

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
