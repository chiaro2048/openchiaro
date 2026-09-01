# dsh-openchiaro

把 OpenChiaro 画布接入 DeepSeek Harness：在 dsh 里使用 Excalidraw、Focus、DeepSeek 画布工具，以及 Claude/Codex 原生终端。

## 环境要求

- Node.js 22.12 或更高版本
- DeepSeek Harness 0.1.1-rc.2
- 一个已登记到 dsh 的 workspace

插件依赖同版本的 `openchiaro@0.1.0` 作为共享运行时核心，安装时由包管理器一并解析。

## 安装

正式包发布后：

```powershell
dsh plugin --profile web add dsh-openchiaro
```

从源码做本地验收：

```powershell
cd <openchiaro 源码目录>
npm ci
npm run build
dsh plugin --profile web add link:<openchiaro 源码目录>\dsh
```

然后启动 dsh web，在侧栏点击「Chiaro」。插件会从当前 dsh workspace 的 `<workspace>/chiaro/<topic>/` 读取画布和上下文；没有 topic 时可让 DeepSeek 调用 `chiaro_topic_list` 创建。

## 能力

- DeepSeek 每轮都能看到当前 topic、画布概况和能力提示；Focus 与上一轮尚未消费的画布变更会自动搭车注入一次。
- `chiaro_scene_read` 在需要具体元素与关系时读取画布与 Focus。
- `chiaro_log_read` 回顾最近的对话、画布操作和已落账结论。
- `chiaro_conclusion_write` 写入紫色结论卡。
- `chiaro_topic_list` 列出或创建 topic。
- 画布页内置受控 PTY 面板，可启动服务端配置的 Claude/Codex；浏览器不能提交任意命令。
- DeepSeek 与 PTY agent 都按同一 schema 追加到 topic 的 `log.jsonl`。

## 数据与安全边界

- 画布、Focus 和日志以 workspace 文件为真相源，不上传到插件自己的服务。
- 修改接口校验同源请求，终端 WebSocket 使用逐实例 capability，hook 上报只接受 loopback 并校验逐终端 secret。
- 同一个 topic 暂不支持 standalone Hub 与 dsh 插件同时写入；使用时只打开其中一边。

## 本地打包检查

```powershell
cd dsh
npm pack --dry-run
```

产物应包含 `lib/`、`client/`、`cordis.patch.yml`、`README.md` 和 `package.json`。本仓库不会自动执行 `npm publish`。
