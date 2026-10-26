# Agent 文件来源与许可

本目录的 `.claude/agents/` 下共 11 个 subagent 文件，全部下载自同一个开源仓库，供 Claude Code / 兼容 AGENTS 规范的编码 Agent 使用。

| 项目 | 说明 |
|---|---|
| 仓库 | [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) |
| 星标 | 约 25.7k |
| 许可证 | MIT |
| 分支 | `main` |
| 下载方式 | 从 `categories/<分类>/<文件名>.md` 原样下载，未做内容修改 |

## 文件清单

| 本地文件 | 角色定位 | 上游路径 |
|---|---|---|
| `code-reviewer.md` | 代码质量 / 安全 / 可维护性评审 | `categories/04-quality-security/code-reviewer.md` |
| `security-auditor.md` | 安全审计、漏洞与合规检查 | `categories/04-quality-security/security-auditor.md` |
| `performance-engineer.md` | 性能分析与优化 | `categories/04-quality-security/performance-engineer.md` |
| `test-automator.md` | 测试自动化与覆盖率 | `categories/04-quality-security/test-automator.md` |
| `debugger.md` | 缺陷定位与根因分析 | `categories/04-quality-security/debugger.md` |
| `backend-developer.md` | 后端服务与 API 实现 | `categories/01-core-development/backend-developer.md` |
| `frontend-developer.md` | 前端界面与交互实现 | `categories/01-core-development/frontend-developer.md` |
| `fullstack-developer.md` | 端到端全栈实现 | `categories/01-core-development/fullstack-developer.md` |
| `api-designer.md` | API 契约与接口设计 | `categories/01-core-development/api-designer.md` |
| `refactoring-specialist.md` | 重构与技术债清理 | `categories/06-developer-experience/refactoring-specialist.md` |
| `documentation-engineer.md` | 文档工程与可维护文档 | `categories/06-developer-experience/documentation-engineer.md` |

原始链接格式：`https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/<上游路径>`

## 使用说明

- **Claude Code**：放在项目的 `.claude/agents/` 即自动识别，可用 `@code-reviewer` 之类显式点名，或由主 Agent 按 description 自动委派。
- **其他 Agent**：这些文件是带 YAML frontmatter（`name` / `description` / `tools` / `model`）的 Markdown 提示词，本质是可移植的角色说明，其他工具可直接读取正文。
- **改名或删除**：按需保留，不影响其他文件。若想扩展到语言/框架专家（如 `python-pro`、`typescript-pro`、`rust-engineer`），同一仓库 `categories/02-language-specialists/` 下还有 30 余个可选。

## 许可证提醒

上游为 MIT 许可证，再分发时请保留其版权与许可声明：<https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/LICENSE>
