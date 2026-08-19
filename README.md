# dsh-win-gitbash

> 🏅 已收录于 [Awesome DeepSeek Harness (DSH) Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表（🛠️ 工具与能力）
> [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**面向 Windows 的 Git Bash 工具插件**（DSH / DeepSeek Harness tool plugin）

> Model-facing Git Bash tool for Windows — replaces pwsh / WSL-only bash.
>
> 🎯 **用于替代原生 pwsh 的 gitbash**：Git for Windows 自带的 bash，快、原生、免 WSL。

## 理念

DSH（DeepSeek Harness）在 Windows 上有两个原生命令工具的痛点：

- ⚠️ 原生的 **pwsh** 工具：Windows 上启动慢、执行卡顿，日常命令体验差
- ⚠️ 原生的 **bash** 工具：依赖 WSL，Windows 端没有 WSL 环境就用不了

本项目为 DSH 提供一个第三个选项：直接依赖 **Git for Windows 自带的 bash**
（`C:\Program Files\Git\bin\bash.exe`），以 DSH 工具插件形式注册为 `gitbash`
工具。**唯一的前置依赖就是装一个 Git for Windows**，装完即得一个原生、快速、
可用的 bash 环境，供 AI 模型（Agent）在 Windows 上执行 shell 命令。

- 🚀 **快**：Git Bash 启动远快于 PowerShell，无 WSL 层开销
- 🪟 **原生**：不需要 WSL，直接跑在 Windows 上，路径同时支持 `C:\...` 与 `/c/...`
- 🔌 **插件化**：以 DSH 工具插件形式注册为 `gitbash` 工具，与 `pwsh`、`bash` 平级
- 🧯 **安全**：支持文件沙箱模式、超时控制、输出截断与后台任务

## 与原生 pwsh / bash 对齐

本工具在**行为上**向 DSH 原生 `pwsh`、`bash` 工具看齐，替代切换几乎无感：

- `run_in_background` 参数仅在 `enableRunInBackground` 开启时暴露；关闭时描述提示"后台执行不可用"，与原生一致
- 沙箱受限时的升级提示 + 权限提问（`sandbox_permissions` + `justification` 双条件触发，经由 `approveEscalation` + `ctx.approval`）与原生完全一致
- 工作目录解析与原生 `bash` 一致：沙箱根优先，否则会话 cwd 经 `canonicalPath` 规范化

> 差异仅在**实现层**：原生依赖 `ctx.shell` 执行器；本工具作为 `ctx.subprocess` 消费者直接调用 Git for Windows 自带 bash，并额外提供原生所没有的调用卡片 UI。

## 依赖

**必须安装 Git for Windows**（提供 `bash.exe`）：

- 下载：https://git-scm.com/download/win
- 安装后请确认以下任一路径存在（工具会自动探测）：
  - `C:\Program Files\Git\bin\bash.exe`
  - `C:\Program Files\Git\usr\bin\bash.exe`
  - scoop 安装的 Git（跟随 `SCOOP` 环境变量定位，默认 `C:\Users\<用户名>\scoop\apps\git\current\bin\bash.exe`）
  - 任意 PATH 目录下的 `bash.exe`（如自定义盘符安装、便携版等；`System32` 下的 WSL 启动器会被跳过）

## 安装

本插件以 npm 包 **`dsh-tool-gitbash`** 发布，声明了 `dsh.bundle` manifest，可直接通过 DSH 插件系统安装。

**方式一：命令行安装（推荐）**

```sh
dsh plugin add dsh-tool-gitbash
```

> 安装命令会自动处理 `@deepseek-ai/*` peer 依赖；装完在 DSH 组合（composition）/ profile 中启用该 bundle，重启后模型即可获得 `gitbash` 工具。

**方式二：dsh-market 图形界面**

在 DSH Web 设置 → 插件市场（dsh-market）中搜索 `dsh-tool-gitbash`，一键安装。

**方式三：手动放入 node_modules**

1. 将本包放入 DSH 的 `node_modules`（如
   `%APPDATA%\npm\node_modules\dsh-tool-gitbash`）或作为本地依赖引用。
2. 确保 peer 依赖可用（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
   `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-shell`、
   `@deepseek-ai/dsh-timeout`）。
3. 在 DSH 组合（composition）中启用该插件，重启后模型即获得 `gitbash` 工具。

## 配置

自动探测找不到 bash 时，可通过插件 `bashPath` 显式配置路径，例如在 cordis.patch.yml 的插件行中：

```yaml
- insert:
    - id: tool-gitbash
      name: 'dsh-tool-gitbash'
      config:
        bashPath: 'C:\Users\me\scoop\apps\git\current\bin\bash.exe'
```

## 工具参数

| 参数 | 说明 |
| --- | --- |
| `command` | 要执行的 Git Bash 命令（`bash -c`） |
| `description` | 命令用途的一句话描述（界面展示用） |
| `timeoutMs` | 超时（默认 120s，上限 600s） |
| `workdir` | 工作目录，默认会话目录 |
| `run_in_background` | 后台运行，立即返回 jobId |
| `sandbox_permissions` / `justification` | 沙箱升级（配置了沙箱时可用） |

## 项目结构

```
dsh-win-gitbash
├── index.js        # 兼容入口（重新导出 lib/index.js）
├── lib/
│   ├── index.js    # Host 端插件：Git Bash 探测、命令执行、超时/沙箱/后台
│   └── client.js   # Client 端：Git Bash 调用卡片 UI（tool.call.toolview）
└── package.json
```

## 许可证

[MIT](./LICENSE)
