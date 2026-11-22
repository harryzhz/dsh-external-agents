# 安全与隐私规范（Security & Privacy Policy）

本文档说明 `dsh-external-agents` 的运行期安全边界、本地数据隐私原则、开源仓库防泄露规范及安全漏洞响应流程。

## 1. 运行期数据隐私与安全架构

`dsh-external-agents` 是运行在用户本地宿主机的 DeepSeek Harness（DSH）外部运行时插件，遵循**本地执行、凭据解耦与零遥测**原则：

- **零遥测与本地通道**：本插件不收集遥测数据，也不直接发起远程网络请求；所有推理与工具调用均通过本机标准输入输出（`stdio` JSON-RPC）交由用户本地安装的外部 CLI 进程（`codex`、`agy`、`claude-agent-acp`、`traecli` 或自定义 ACP CLI）执行。
- **凭据不落盘于本插件**：模型 API Key、登录态及钥匙串凭据完全由对应外部 CLI 工具自身管理；本插件仅向 DSH 会话持久化外部线程/会话 ID 映射（用于断线续接），不保存或回传任何外部凭据。
- **子进程环境与权限边界**：
  - 支持对依赖 macOS Keychain 的子进程启用 `stripSshEnv: true`，在保留 `SSH_AUTH_SOCK` 的前提下剥离 `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY`。
  - 默认内置的 `codex-app-server` 运行时预设采用 `approvalPolicy: 'never'` 与 `sandbox: 'danger-full-access'` 以匹配自动化协作体验；如在受限或高敏环境部署，建议通过 `cordis.patch.yml` 显式收紧各运行时的 `approvalPolicy`、`sandbox`、`args` 或禁用不需要的运行时。
  - 自定义 `runtimes` 中的 `command`、`args` 与 `env` 将直接在本地宿主机启动子进程，请仅配置您信任的可执行文件与参数。

## 2. 开源仓库防泄露规范（面向贡献者）

在向本仓库提交代码、测试、文档或配置时，必须遵守以下隐私基线：

| 类别 | 严禁提交 | 合规替代方式 |
| --- | --- | --- |
| 密钥与凭据 | API Key、OAuth Token、Cookie、Bearer Token、私钥（`.pem`/`.key`）、`.env` | 通过运行期环境变量或测试桩传入 |
| 非公开运行时与配置 | 非公开 CLI 命令名、私有网关/代理端点、未公开模型或内部配置 | 仅集成官方公开文档化的 CLI 与协议 |
| 个人隐私信息 | 宿主机真实路径（`/Users/<真实名>`）、未授权个人邮箱、真实用户名或个人日志 | 使用 `/Users/demo/...`、`/opt/...`、`example.com` 或系统临时目录 |
| 组织/公司非公开信息 | 内部系统代号、内部域名、私有 npm registry 镜像源、真实生产故障日志 | 使用虚构测试数据与官方公开 `registry.npmjs.org` |
| 构建与临时产物 | 本地打包 `.tgz`、运行日志、调试抓包与 `.local/` 内容 | 仅输出至已被忽略的 `.local/` 目录 |

### 自动化检查

仓库内置零依赖隐私与密钥扫描脚本，所有 PR 与 `main` 分支推送均由 CI 自动执行：

```bash
pnpm run check:privacy
```

贡献者可在本地（已被 `.gitignore` 忽略）创建 `.local/privacy-denylist.txt`，每行填写需要额外拦截的个人姓名、组织内部域名或内部代号（支持 `#` 注释行与 `/regex/flags` 语法）。脚本会自动加载该本地文件进行叠加检查，从而在不向公开仓库暴露任何敏感词的前提下实现强拦截。

## 3. 安全漏洞与敏感信息披露

如果您发现了本项目的安全漏洞，或发现仓库中意外包含敏感信息：

1. **请勿在公开 GitHub Issue 或 Pull Request 中直接披露细节。**
2. 请优先通过本仓库 GitHub 页面 **Security → Advisories → Report a vulnerability** 提交私密安全报告，说明受影响版本、复现步骤与潜在影响。
3. 如维护者不慎向公开历史提交了凭据，请第一时间在对应平台**吊销并轮换凭据**（不可仅依赖覆盖提交），随后再清理 Git 历史并通知受影响方。
