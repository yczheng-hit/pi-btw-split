# pi-btw-split

[English](README.md) | **简体中文**

一个 [pi](https://github.com/earendil-works/pi-mono) 扩展，提供 `/btw` 旁路对话：主 agent 继续工作的同时，你可以另开一个对话。在 [Herdr](https://herdr.dev) 里它显示为右侧的原生 pane；在其他环境里显示为 Pi 内部的 60/40 分屏。

本项目在 [yczheng-hit/pi-btw-split](https://github.com/yczheng-hit/pi-btw-split) 独立维护，基于 Dan Bachelder 的 MIT 授权项目 pi-btw 0.7.1。版本：`0.7.1-split.9`。历史 Linux 验证覆盖 Pi 1.0.4、1.2.0 和 Herdr 0.9.3。原生 macOS 验证覆盖 arm64、Pi 1.2.0、Node 24.20 和 Herdr 客户端/服务端 0.9.1；这些结果不代表对所有主机或未来版本的保证。

支持和问题反馈使用[本仓库的 Issues](https://github.com/yczheng-hit/pi-btw-split/issues)，更新和回滚使用本项目自身历史。下方相关项目仅用于对比和致谢，不是维护入口。

## 用 AI agent 一键配置

把下面这段话发给你的编程 agent（pi、Claude Code、Codex 等）：

```text
Install the pi extension at https://github.com/yczheng-hit/pi-btw-split.
Follow the "Setup instructions for AI agents" section of its README exactly.
```

agent 会检查前置条件、安装扩展、在适用时注册 Herdr pane 插件，最后提示你执行 `/reload`。安装步骤见下方「AI agent 安装步骤」，与英文版一致。

## 与同类项目对比

| | [pi-btw](https://github.com/dbachelder/pi-btw)（上游） | [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) | **pi-btw-split**（本项目） |
|---|---|---|---|
| 旁路对话显示位置 | 主会话上方居中浮层 | 新的 Herdr pane | Herdr：右侧原生 pane；其他环境：Pi 内部 60/40 分屏 |
| 旁路对话进程 | 父 Pi 内的子会话 | 另起一个完整 Pi 进程（`herdr agent start --kind pi`） | 父 Pi 内的子会话；Herdr pane 只是一个通过本地 socket 连接的轻量 Node 前端 |
| 是否需要 Herdr | 否 | 是（v0.7.4+） | 否；原生 pane 需要 Linux 或 macOS 上的 Herdr 0.9.1+ |
| 旁路对话拿到的上下文 | 复制整个主分支 | 父上下文的静态快照；原样复用系统提示词以命中 provider 的 prompt cache | 每个问题都重新取一份有预算的主会话快照（当前任务及其工具进度、之前几轮、已有的压缩摘要；默认最多占空闲窗口 60%，上限等于主会话的上下文窗口，可在 `~/.pi/agent/btw.json` 的 `snapshot.share` / `snapshot.maxTokens` 调整），加主会话 transcript 路径。`PI_BTW_CONTEXT=full` 复制全部 |
| 旁路对话自动压缩 | 开启（遵循你的 Pi 设置） | Pi 默认设置（以普通 Pi 进程运行） | 开启（遵循你的 Pi 设置）。精简启动避免复制完整主上下文；BTW 长对话仍会压缩 |
| 模式 | `/btw`、`/btw:tangent`（无上下文）、`/btw:ask`（只读） | 单一模式；工具范围由配置决定（`inherit/all/read-only/none`） | 同上游 |
| 交回主 agent | `/btw:inject`、`/btw:summarize`：作为用户消息发送，主 agent 忙时排队到 follow-up | 在旁路 pane 中 `/btw merge <prompt>`；等父会话空闲后送达 | 带标签的 `BTW → main` 消息，主 agent 忙时在下一步插入（steer）。inject 确认送达前保留线程；summarize 总结生成后立即清空线程。未送达的内容保留以便重发 |
| 输入框辅助 | 斜杠菜单（0.8.0） | 预填问题草稿供编辑 | 实时命令提示、Tab 补全、短命令（`/ask`、`/summ`）；未知的 `/btw…` 文本不会发给模型 |
| 其他 | SSH 工作区（0.8.0） | 持久化配置（`/btw config`），可向右/向下分屏 | pane 内复制、点击切换焦点、中文输入法光标定位（均由 Herdr 提供） |

本项目的不足：它从 pi-btw 0.7.1 分出，所以上游 0.8.0 的功能（SSH 工作区、上下键斜杠菜单）没有包含。原生 pane 只支持 Linux 和 macOS；其他平台在 Herdr 内可设置 `PI_BTW_SURFACE=internal` 使用 Pi 内部分屏。

## 环境要求

- Node.js 22.19 或更新
- Pi 1.0.4 或更新（`pi --version`）
- 可选的原生 pane：Linux 或 macOS 上的 Herdr 0.9.1 或更新，**以及 Herdr 官方 Pi 集成**（`herdr integration install pi`）。官方集成是外部前置条件，不属于本包，仍负责父 agent 的身份和生命周期。

## AI agent 安装步骤

英文版的 "Setup instructions for AI agents" 是 agent 执行的权威版本，内容如下：

1. **检查前置条件。** 运行 `node --version` 和 `pi --version`。Node 低于 22.19 或 Pi 低于 1.0.4 时停止并报告。

2. **检查冲突的包。** 运行 `pi list`。如果有 `npm:pi-btw`、`pi-herdr-btw` 或其他注册了 `/btw` 的包，先询问用户是否用 `pi remove <source>` 移除。两个包同时注册 `/btw` 会冲突。

3. **安装。**
   ```sh
   pi install git:github.com/yczheng-hit/pi-btw-split
   ```
   Pi 会克隆到 `<agent-dir>/git/github.com/yczheng-hit/pi-btw-split`，其中 `<agent-dir>` 是 `$PI_CODING_AGENT_DIR`，未设置时为 `~/.pi/agent`。也可使用 `pi install /absolute/path/to/pi-btw-split`，以你的本地 checkout 作为包根目录。再运行一次 `pi list` 确认。

4. **注册 Herdr pane（仅限装有 Herdr 的 Linux 或 macOS）。** 没有安装 `herdr`，或系统既不是 Linux 也不是 macOS 时跳过。
   ```sh
   herdr --version                  # 需要 0.9.1+
   herdr integration install pi     # 尚未安装时，安装官方 Pi 集成
   herdr plugin list --json         # 查找插件 id "local.pi-btw-light"
   herdr plugin link "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/yczheng-hit/pi-btw-split"
   ```
   - 安装前先检查 `<agent-dir>/extensions/herdr-agent-state.ts` 中是否已有官方 Pi 集成；它始终是外部标准前置条件。
   - 如果是从本地 checkout 安装，改为链接该 checkout 的绝对路径。
   - 如果 `local.pi-btw-light` 已注册在其他路径，修改前先询问用户。不要替换不是自己创建的注册。
   - 插件根目录必须正好是已安装的包目录，否则 BTW 会拒绝打开 pane。

5. **在 Herdr 里使用其他平台。** 原生 pane 只支持 Linux 和 macOS，所以在其他平台上要在用户的 shell 配置里设置 `PI_BTW_SURFACE=internal`，否则 `/btw` 会报启动错误而不是打开。不在 Herdr 里时无需设置，会自动使用 Pi 内部分屏。

6. **完成。** 告诉用户在每个正在运行的 Pi 会话里执行 `/reload`（或新开一个会话），然后试试 `/btw hello`。agent 无法替别人的 Pi 会话执行 `/reload`。

**卸载：** 移除 `pi list` 显示的安装来源：本地安装用 `pi remove /absolute/path/to/pi-btw-split`，Git 安装用 `pi remove git:github.com/yczheng-hit/pi-btw-split`。如果注册过插件，再执行 `herdr plugin unlink local.pi-btw-light`。卸载 BTW 时不要移除 Herdr 官方 Pi 集成。

**更新：** `pi update git:github.com/yczheng-hit/pi-btw-split`，然后 `/reload`。本地安装从本项目自身历史更新 checkout，然后 `/reload`。要固定版本，安装 `git:github.com/yczheng-hit/pi-btw-split@<commit 或 tag>`。

## 手动安装

```sh
pi install git:github.com/yczheng-hit/pi-btw-split   # 或：pi install /absolute/path/to/pi-btw-split
```

然后按上面第 4–6 步操作。不安装、临时试用：`pi -e /path/to/pi-btw-split`。

## 使用

```text
/btw 这个路由是在哪个文件定义的？
/btw --save 用一句话总结最近的报错
/btw:tangent 不带当前对话上下文，从头想一想
/btw:ask 这个模块是做什么的？
/btw:summarize 整理成一段简短的交接
```

| 命令 | 作用 |
|---|---|
| `/btw [--save] <问题>`（别名 `/side`） | 在当前 BTW 线程里提问，主 agent 忙时也能用。`--save` 会把这次问答另存为主 transcript 里的可见笔记 |
| `/btw:new [问题]` | 清空线程，开一个带主上下文的新线程 |
| `/btw:tangent [--save] <问题>` | 不带主会话上下文的线程 |
| `/btw:ask [--save] <问题>` | 只读线程：只有 `read`、`grep`、`find`、`ls` 可用 |
| `/btw:inject [说明]` | 把整个线程发给主 agent。主会话收到前保留线程；送达失败时再执行一次即可重发 |
| `/btw:summarize [说明]` | 总结线程（关闭 thinking）并发送总结。总结生成后立即清空线程；送达失败时再执行一次即可重发已保存的总结，不会再次调用模型 |
| `/btw:clear` | 关闭 BTW 并清空线程 |
| `/btw:model [<provider> <model> <api> \| clear]` | 仅对 BTW 生效的模型 |
| `/btw:thinking [<level> \| clear]` | 仅对 BTW 生效的 thinking 级别 |
| `/btw:ui native\|internal` | 在当前 Pi 进程内切换 Herdr pane 和 Pi 内部分屏 |

在 BTW 输入框里可以用短命令（`/ask`、`/new`、`/summ`），Tab 补全命令，其他斜杠命令交给 BTW 子会话处理。

### 快捷键

| 按键 | 作用 |
|---|---|
| `Alt+/`、`Super+/`、`Ctrl+Alt+W` | 在主会话和 BTW 之间切换焦点。可用 `PI_BTW_FOCUS_KEYS="ctrl+/,ctrl+alt+b"` 重新映射 |
| `Alt+w` | Herdr：放大 BTW pane。Pi 内部分屏：切换全宽模式，便于复制 |
| `↑` / `↓` | 输入历史，和主会话编辑器一致：输入框为空（或光标在行首）时按 `↑` 调出之前的 BTW 问题，`↓` 回到正在写的草稿。历史包含本会话所有 BTW 问题，`/btw:new` 之前的也在 |
| `PgUp` / `PgDn`、鼠标滚轮 | 滚动 BTW 对话记录 |
| `Esc` | 输出中：中止（保留已输出部分）。空闲时：关闭 BTW。关闭会保留线程和草稿，`/btw` 重新打开 |

### 行为说明

- BTW 线程保存为会话里的隐藏条目，重载后仍在，且不会进入主 agent 的上下文。未提交的草稿不会写入磁盘。
- BTW 后端运行在父 Pi 里。父 Pi 退出时 Herdr pane 会断开；重新打开会话后线程会恢复。
- BTW 长对话会按你的 Pi 设置自动压缩。`/btw:inject` 和 `/btw:summarize` 仍使用完整的 BTW 问答，而不只是压缩摘要。
- 如果压缩后 BTW 线程仍超出模型上下文窗口，BTW 会报错，并提示使用 `/btw:summarize` 或 `/btw:new`。
- Pi 内部分屏需要全屏模式且终端至少 120 列、14 行；更小的终端使用居中窗口。

## 配置

| 设置 | 作用 |
|---|---|
| `PI_BTW_SURFACE=internal` | 即使在 Herdr 里也始终使用 Pi 内部分屏 |
| `PI_BTW_CONTEXT=full` | 把整个主上下文复制给 BTW（上游行为）。压缩仍遵循你的 Pi 设置 |
| `PI_BTW_FOCUS_KEYS` | 逗号分隔的焦点切换键，会替换默认值 |
| `~/.pi/agent/btw.json` | 为 `/btw` 和 `/btw:tangent` 按需启用扩展工具，例如 `{"extensions": ["npm:pi-web-access"]}`。受信任项目的 `.pi/btw.json` 会替换该列表。`/btw:ask` 不读取它 |

## 开发

在 checkout 根目录运行：

```sh
npm ci
npm test            # node --test test/*.test.mjs；使用离线 provider，不发起网络模型调用
npm run typecheck
```

这些命令使用固定的 Pi 1.2.0 开发依赖在本地运行，无需全局安装 Pi，也无需修改机器专属路径。`npm run typecheck` 使用本地类型。若要额外验证另一份已安装 Pi 的运行时兼容性，可将 `PI_HOST_DIR` 设为其 `@earendil-works/pi-coding-agent` 包目录。

Live 测试（`test/live-*.mjs`）需显式设置 `PI_BTW_LIVE_TEST=1`，并要求 Linux 或 macOS、Herdr 0.9.1 或更新，以及通过 `herdr integration install pi` 安装的官方 Herdr Pi 集成。默认加载 `<agent-dir>/extensions/herdr-agent-state.ts`，其中 `<agent-dir>` 是 `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`；可用 `PI_HERDR_EXTENSION` 覆盖集成路径。运行前阅读各脚本选项：测试会创建 Pi 父进程和 Herdr pane/tab，real-config 模式可能加载你的个人扩展。

`node test/perf.mjs` 测量离线渲染 fixture，不是物理终端延迟。可选的 `PI_STICKY_EXTENSION=/absolute/path/to/sticky-last-prompt.ts` 会加载你的个人 sticky-prompt 扩展做对比；默认 fixture 不需要它。

设计说明和测量数据：见 [LOCAL-CHANGES.md](LOCAL-CHANGES.md)（英文）。

## 致谢

- [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw)，作者 Dan Bachelder：本项目所基于的原始扩展（MIT）。
- [oscabriel/pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw)：另一个面向 Herdr 的 `/btw`，在独立 pane 中以单独的 Pi 进程运行旁路对话。
- [pi](https://github.com/earendil-works/pi-mono) 和 [Herdr](https://herdr.dev)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
