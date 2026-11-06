# magpie-our-free-model

[Our Free Model] 的 **Magpie 宿主插件**独立仓库。无需登录、注册或填 API Key，即可使用包括
DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型（登录、账号池、积分领取、本地 OpenAI 网关与
局域网转发、数据看板与运行日志）。

这是一个自包含的 Magpie 插件：宿主适配代码在本仓库根目录，OFM 运行时（`packages/standalone`
、`src/` 切片、`vendor/` 资源）已 vendor 进来，因此可直接以仓库根目录安装运行，无需依赖
其它仓库的目录。

## 安装

```sh
magpie plugin add github:ShuttleSpace/magpie-our-free-model
```

在 Magpie 的 **供应商 → Our Free Model** 里点“启用模型 / 打开账号管理控制台”，浏览器会
打开本机管理页。完成 EAC 授权或渠道登录后回到 Magpie 刷新模型，即可在 Agent 里选择
`our-free-model/<模型 id>`。

## 入口

Magpie 按 `exports["./server"]` → `main` → `exports["."]` 的顺序查找服务端入口。
`package.json` 因此声明：

```json
"exports": { ".": "./index.mjs", "./server": "./index.mjs" },
"main": "./index.mjs"
```

## 结构

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `index.mjs` | Magpie 的 Bun 宿主 | 插件入口，只导出一个函数 |
| `managed.mjs` | Bun | `config` / `auth` / `provider` 钩子、模型发现、请求转发 |
| `models.mjs` | 两端共用 | 目录行与 Magpie 模型之间的映射 |
| `runtime.mjs` | Bun | 启动并持有 Node 子进程 |
| `runner.mjs` | Node 子进程 | 调用 `startStandalone`，回答 `models` / `admit` / `console` |
| `handoff.mjs` | Node 子进程 | 一次性 `/open/…` 链接，用本机 API Key 换管理会话 Cookie |
| `installation-state.mjs` | Bun（插件宿主） | 安装登记、生命周期锁、卸载清理 |
| `uninstall.mjs` | Magpie 卸载入口 | `magpie.uninstall` 声明，只调用清理逻辑 |
| `node.mjs` | Bun | 选择系统 Node，缺失时下载并校验官方发行包 |

服务必须跑在 Node 而不是 Bun：渠道 Worker 需要 `node:sqlite`。子进程通过 stdin/stdout
上的逐行 JSON 通信，宿主退出时 stdin 关闭，子进程随之停止。

## 运行时

- 数据目录默认是 `<Magpie 配置目录>/our-free-model`。
- 服务只监听回环地址；管理页也只能在本机打开。远程/服务器场景请用 SSH 端口转发。
- 首次启动如果系统没有 Node 22.19+ / 24+，会从 nodejs.org 下载固定版本
  （24.21.0，SHA-256 已 pin），缓存到数据目录的 `runtime/` 下。
- `vendor/magpie/engine.json` 是引擎清单，引擎二进制按需在运行时下载（不随仓库分发）。

## 选项

Magpie 的插件 `options` 通过 `managed` 传入：

```json
{
  "managed": {
    "dataDir": "/absolute/path/our-free-model",
    "port": 0,
    "nodePath": "/usr/local/bin/node",
    "autoInstallNode": true,
    "refresh": true
  }
}
```

- `dataDir`：必须是专用子目录，不能是系统根目录、主目录、Magpie 配置目录或源码目录。
- `port`：推理监听端口，`0` 表示随机。
- `nodePath`：显式指定 Node；设置后不会自动下载。
- `autoInstallNode`：`false` 时缺少 Node 直接报错。
- `refresh`：`false` 时启动不做模型清单刷新，只用手动刷新。

## 卸载与清理

`package.json` 的 `magpie.uninstall` 指向 `./uninstall.mjs`。Magpie 卸载插件时会加载它，
即使供应商已停用；该入口不会启动服务、下载 Node 或读取凭据。卸载只清理登记过的数据目录，
且只删除本插件写入的条目；其它文件保留，目录非空时整个目录也保留。

## 上游与同步

本仓库的运行时 vendor 自
[ShuttleSpace/dsh-our-free-model](https://github.com/ShuttleSpace/dsh-our-free-model)
的 `magpie` 分支。运行时（`packages/standalone`、`src/`、`vendor/`）与宿主适配代码
（根目录 `.mjs`）都来自该仓库；上游更新后需手动同步本仓库。

## License

MIT
