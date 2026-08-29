# openchiaro

![openchiaro —— Excalidraw 画布与原生 agent 终端并排协作](assets/cover.png)

[English](README.md)

openchiaro 是一个由设计对象驱动的画布工作台，让人和 AI agent 通过 Excalidraw
画布与嵌入式原生终端协作。

## 核心特性

- **每个 topic 一个本地 Hub。** 每间协作室都隔离在 `chiaro/<topic>/` 下。
- **原生 Agent 终端。** Claude Code 和 Codex 的真实 TUI 直接运行在浏览器右栏。
- **点选即 Focus。** 经项目审核的 hook 把当前画布选区注入下一轮 prompt。
- **真相在文件。** 画布、事件日志、运行时上下文、provider session 记录和 topic
  产物都是可检查的本地文件。
- **冷恢复。** Hub 重启后按需恢复已记录的 provider session；恢复失败时明确显示
  fresh start。

## 快速开始

需要 Node.js >= 22.12.0 和现代浏览器。

### 推荐：用 npx 一键安装

```text
npx openchiaro install --target both
npx openchiaro open <topic> --project <project-root>
```

只装一处时使用 `--target claude`、`--target codex` 或绝对路径。Linux 无桌面环境时
追加 `--no-browser`，再手动打开 CLI 打印的 URL。

### 开发者：从源码运行

```text
git clone https://github.com/chiaro2048/openchiaro.git openchiaro
cd openchiaro
node --version
npm ci
npm run build
node server/cli.mjs install --target both
node server/cli.mjs open <topic> --project <project-root>
```

源码 CLI 还支持：

```text
node server/cli.mjs restart <topic> --project <project-root> [--port <起始端口>]
```

默认 topic 是 `workbench`；省略 `--project` 时使用仓库根目录。

## 接入 AI agent

用户通过右栏的 `+ Agent` 菜单和 PetDock 创建、切换 agent。Chiaro 只启动服务端配置表
里的命令，并为每个 agent 保留独立终端画面。

Chiaro 内置 Claude Code 与 Codex 配置；可以在 `<project>/chiaro/agents.json` 中覆盖
或扩展：

```json
{
  "agents": {
    "codex": {
      "cmd": ["codex"],
      "resume": ["codex", "resume", "{sessionId}"],
      "label": "Codex"
    }
  }
}
```

命令必须写成 argv 数组。浏览器只提交 agent 名称，不能启动任意命令。

要注入画布 Focus，并把 prompt 与回合结束事件写入语义日志，请把示例配置合并到
provider 的项目级配置：

- Claude Code：`hooks/claude-settings.example.json` 合并到
  `<project>/.claude/settings.json`
- Codex：`hooks/codex-hooks.example.json` 合并到
  `<project>/.codex/hooks.json`

合并时保留已有 hook，不要整文件覆盖。通过 provider 正常的 trust 提示或 `/hooks`
界面审核命令，不要绕过 hook trust。

产品入口是 `npx openchiaro`。[`skill/`](skill/) 只是可选的上下文包：主文件供外部 agent
打开 topic，[`skill/references/terminal-agent.md`](skill/references/terminal-agent.md) 则供嵌入
终端里的 agent 查阅画布、冲突处理、产物与 Hub 接口协定。

## 平台支持

| 平台 | 架构 | 本地编译工具链 |
|---|---|---|
| Windows 10/11 | x64、arm64 | 不需要 |
| macOS | x64、arm64 | 不需要 |
| Linux | x64、arm64 | 不需要 |

`npm ci` 会按当前操作系统和 CPU 选择预编译 PTY 包。

## 许可证

openchiaro 使用 [MIT License](LICENSE)。
