# Fusion Office

面向 Fusion 生态的本地优先办公套件。

五个浏览器应用共享一套存储层和一个 AI 客户端，全部在本机运行，并通过
`fusion-gateway` 挂载到 Fusion 联合 Web Shell。

## 包含内容

| 应用 | 用途 | 来源 |
| --- | --- | --- |
| `apps/documents` | 文字处理，支持 `.docx` 打开保存、修订、批注、拼写检查 | MIT，迁移自 HeyPuter/everything |
| `apps/spreadsheet` | 电子表格，支持公式、图表、透视表、`.xlsx` | AGPL-3.0-only，迁移自 HeyPuter/everything |
| `apps/presentation` | 幻灯片编辑，支持 `.pptx` 和 AI 生成演示文稿 | MIT，迁移自 HeyPuter/everything |
| `apps/pdf` | PDF 阅读、批注、表单填写、OCR、AI 助手 | MIT，迁移自 HeyPuter/everything |
| `apps/pm` | 本地项目管理，包含任务、看板、时间线 | MIT，迁移自 HeyPuter/everything |
| `packages/storage` | 本地优先文件存储：File System Access API、OPFS 回退、IndexedDB 索引 | 本项目 |
| `packages/ai-client` | 面向 `fusion-gateway` 的 OpenAI 兼容客户端，支持流式、工具调用、JSON、共享 agent 循环 | 本项目 |

每个应用都是纯静态 Vite 构建产物。没有服务端组件，没有账号系统，也不依赖云服务。
文件保存在用户选择的目录或浏览器的源私有文件系统中。

## 架构

```text
apps/documents  apps/spreadsheet  apps/presentation  apps/pdf  apps/pm
        |                |                |             |         |
        +----------------+----------------+-------------+---------+
                                   |
                         packages/storage   packages/ai-client
                                   |                |
                        FSA / OPFS / IndexedDB     |
                                                   |
                                          fusion-gateway :11432
                                                   |
                                            fusion-mlx :11434
```

- 每个应用是独立的 Vite 入口。Vite 使用相对 `base`，因此同一份构建既能独立运行，
  也能挂在网关的 `/shell/<id>/` 前缀下。
- `packages/storage` 每个会话只解析一次可写根目录：浏览器支持时使用 File System
  Access API 目录选择器，否则使用 OPFS。用户关闭选择器，或浏览器在没有用户手势时
  直接中止选择器，同样回退到 OPFS，应用不会因此不可用。IndexedDB 中维护尽力而为的
  路径、大小、修改时间索引，用于列表展示。
- `packages/ai-client` 是访问模型的唯一通道。它调用 OpenAI 兼容的
  `/v1/chat/completions`，默认地址为 `http://127.0.0.1:11432`，不在应用内嵌入模型逻辑。
  同包的 `createAgent` 提供文档、PDF、项目三个助手共用的工具循环。
- AI 请求由网关 API Key 管控。浏览器构建在编译期读取 `VITE_FUSION_GATEWAY_KEY`。
  PDF 和项目 AI 入口会先检查 `isConfigured()` 并在缺少配置时明确说明，不会发送请求；
  其余应用则把网关错误显示在各自的界面中。

## 环境要求

- Node.js 22.18 及以上，npm 10 及以上。
- 使用 File System Access API 需要现代 Chromium 内核浏览器；Safari 和 Firefox 会回退到 OPFS。
- 可选：本机 `127.0.0.1:11432` 上运行 `fusion-gateway`，并加载对话模型，用于 AI 功能。

## 快速开始

```bash
npm install
npm run build
npm run dev:documents
```

`dev:documents` 可以换成 `dev:spreadsheet`、`dev:presentation`、`dev:pdf` 或 `dev:pm`。
每个开发服务器会打印自己的地址。数据保留在打开该地址的浏览器配置中。

生产构建挂到联合 Shell 的方法见下一节。

## 通过 fusion-gateway 使用 AI

AI 调用统一走 `@fusion-office/ai-client`。启动开发服务器或构建前设置环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `VITE_FUSION_GATEWAY_URL` | `http://127.0.0.1:11432` | 网关地址 |
| `VITE_FUSION_GATEWAY_KEY` | 空 | 以 `Authorization: Bearer` 发送的 API Key |
| `VITE_FUSION_MODEL` | `mlx-community/Qwen3.5-9B-4bit` | 默认对话模型 |

将 `.env.example` 复制为应用目录下的 `.env.local`（或在 Shell 中导出变量），把网关
API Key 填入 `VITE_FUSION_GATEWAY_KEY`。Key 会被编译进浏览器产物，因此必须使用受限
Key，禁止使用 master key，禁止提交 `.env.local`。

`npm run dev` 期间，`@fusion-office/ai-client` 请求同源的 `/__fusion_gateway`，由各
Vite 配置把它代理到网关（`dev/gateway-proxy.mjs`）。网关的 CORS 白名单不包含任意本地
开发端口，直连会因预检被拒而表现为 `Failed to fetch`。生产构建仍直接访问
`VITE_FUSION_GATEWAY_URL`。

### 选择模型

每个助手面板都有模型下拉框，列出网关提供的模型（`GET /v1/models`，已加载的排在前面）。
选中后按应用保存，未显式指定模型的所有调用都用它，刷新后仍然生效。提供哪些模型、每个
API Key 允许用哪些，由网关侧决定（每个 key 的 `allowed_models`、fusion-gateway 的后端
路由），不在本仓库配置。没有网关 Key 时下拉框不出现，使用 `VITE_FUSION_MODEL`。

各应用的 AI 入口：

- 文档：助手面板通过工具操作当前文档：读取、查找、插入或替换选区、设置格式、插入表格
  或分页符、添加链接。替换选区前会请求确认，每次修改都是一个撤销步骤。语法检查、翻译、
  智能查找、图片提示保持不变。
- 表格：公式生成与解释、数据问答、翻译，以及 `AI`、`TRANSLATE` 等表格函数。
- 演示：提示词生成整套幻灯片、助手面板、幻灯片审阅。
- PDF：侧栏 **Ask AI** 是基于当前文件的助手：通过工具读取页面、查找文本、跳转页面、
  调整缩放、添加书签（唯一的修改，可撤销）。扫描件需要先做 OCR。
- 项目：看板标题栏的项目助手可读取并修改项目：新建、更新、移动、归档、删除任务，
  添加检查清单项和评论，添加列。删除任务前会请求确认。任务上的
  **Break down with AI** 仍通过 JSON 回复把任务拆成检查清单。

文档、PDF、项目三个助手共用 `packages/ai-client/src/agent.js` 的循环：带上工具定义发送
对话，执行模型请求的调用，把结果回传，并在限定轮数内结束。各应用自己维护工具定义与执行器。

用真实已加载模型做端到端验证：

```bash
FUSION_GATEWAY_KEY=<受限-key> node scripts/verify-ai.mjs
```

脚本依次检查模型注册、普通对话、流式对话、工具事件流、PDF 与项目 JSON 路径，以及文档、
表格、演示、PDF 助手面板的真实适配器路径。加载浏览器模块时只使用 jsdom，不启动浏览器。
任一步失败都会以非零状态退出。

## 联合 Web Shell 集成

每个应用自带 `web/manifest.json`，通过 `POST /api/v1/shell/manifests` 注册到
`fusion-gateway`。网关把 `/shell/<id>/` 反向代理到应用的上游静态服务器，并要求
Shell 会话令牌，而不是 API Key。

五个清单共用 `"group": "fusion-office"`，组标题为 `Fusion Office`，联合 Shell 因此
显示一个一级菜单，二级按 `sort` 1 到 5 排列：文档、表格、演示、PDF、项目。模块
`id`、`path`、`entry` 保持不变，仍是稳定的接口契约。分组菜单需要支持清单 schema v2
（`group`）的 Shell；旧版 Shell 仍按扁平列表展示。

`scripts/shell-serve.mjs` 会为五个已构建应用各启动一个静态服务器，固定端口
11485-11489（已登记 `architecture/port-registry.yaml`），注册清单、定时心跳，并在
退出时注销。`start.sh` 按fusion-supervisor 生命周期协议封装，admin key 依次从环境
变量、`.env.local`、网关配置解析：

```bash
./start.sh start | stop | restart | status | log
```

直接运行（同样固定端口）：

```bash
FUSION_GATEWAY_ADMIN_KEY=<admin-key> node scripts/shell-serve.mjs
```

fusion-supervisor 在跑时，`fusion-sv up fusion-office` 即可托管：崩溃自动重启、健康
历史、Web 控制台；`fusion-sv down fusion-office` 停止。

一次性路由冒烟检查需要再加 master key，用于派生 Shell 会话密钥：

```bash
FUSION_GATEWAY_ADMIN_KEY=<admin-key> \
FUSION_GATEWAY_MASTER_KEY=<master-key> \
node scripts/shell-serve.mjs --smoke
```

冒烟流程会注册每个模块，用短期会话令牌请求 `/shell/fusion-office-<app>/`，校验
HTML 应用根节点和一个带哈希的静态资源，然后注销全部清单并退出。两个 Key 只存在于
环境变量中，不会写入仓库。

## 构建与测试

```bash
npm run build            # 顺序构建五个应用
npm test                 # 顺序运行五个 vitest 套件
npm run build -w apps/pdf
npm test -w apps/pdf
npm test -w apps/pdf -- tests/ai-panel.test.js
```

`npm install` 会为演示应用执行 `patch-package`，并链接共享测试依赖。五个应用都有
浏览器端到端套件，需要安装 Playwright 浏览器：

```bash
npx playwright install
npm run test:browser -w apps/documents
npm run test:browser -w apps/spreadsheet
npm run test:e2e -w apps/presentation
npm run test:e2e -w apps/pdf
npm run test:browser -w apps/pm
```

每个应用都有一个 `assistant-tools` 浏览器用例，通过真实界面驱动助手的全部工具。
用例在页面内用模拟网关应答模型的请求，因此不需要 API Key、网关或已加载模型。文档应用
使用自带的开发桩；其余应用把网关的补全端点接到脚本化的流式事件上。

文档能力服务有独立的 Python 测试套件：

```bash
cd services/office-api
python -m pytest tests -q
./start.sh start          # 127.0.0.1:11520
./start.sh stop
```

## 文档能力服务

`services/office-api` 是一个 FastAPI 小服务，向其他 Fusion 项目提供文件能力（首个
调用方：`dahai80/envipermit`），实现 issue #1 的契约：

- `POST /v1/xlsx/parse` — `multipart` 字段 `file`；返回工作表、表格、展平后的合并
  单元格，以及无法可靠识别表头而进入 `unparsed_regions` 的区块。
- `POST /v1/docx/fill` — `multipart` 字段 `file` 加 `values` JSON；替换段落、表格
  单元格、页眉页脚中的 `{{placeholder}}`，返回填充后的二进制，并带
  `X-Office-Doc-SHA256` 与 `X-Office-Unfilled` 响应头。
- `GET /healthz`、`GET /readyz`。
- 超过 100 MB 的上传返回 `413`，格式错误返回 `422`。服务只监听回环地址，不发起
  外部请求。`/v1/docx/snapshot` 推迟到 v0.2。

详见 `services/office-api/README.md`。

## 目录结构

```text
apps/<app>/src        应用代码
apps/<app>/tests      vitest 套件
apps/<app>/web        Shell 清单
apps/<app>/dist       生产构建产物（已忽略）
packages/ai-client    网关客户端
packages/storage      本地优先存储
scripts/              构建、测试、AI 验证、Shell 托管脚本
dev/                  本地开发辅助和验证日志
```

## 配置

| 文件 | 用途 |
| --- | --- |
| `.env.example` | 网关地址、Key、模型的模板 |
| `.env.local` | 本地覆盖，已被 git 忽略 |
| `apps/<app>/web/manifest.json` | 联合 Shell 使用的模块身份 |

应用没有运行时配置接口。变量在构建期通过 `import.meta.env` 读取，运行时只依赖
浏览器环境。

## 存储模型

- 首次写入时通过 File System Access API 请求工作区目录，句柄在当前会话内复用。
- 目录选择器不可用、用户关闭选择器，或浏览器在无用户手势时中止选择器，都会回退到
  页面源下的 OPFS。
- 文件内容是真实的 `.docx`、`.xlsx`、`.pptx`、`.pdf`、JSON 和图片文件，不写入专有数据库。
- IndexedDB 只保存尽力而为的路径、大小、时间索引。索引丢失不会丢文件。
- 测试只在 `import.meta.env.MODE === 'test'` 时使用桩对象 `globalThis.puter`。
  生产构建不会访问该全局。

## 许可证与来源

- `packages/storage`、`packages/ai-client`、`services/office-api` 和根目录工具：
  Apache-2.0，本项目原创。详见 `LICENSE`。
- `apps/documents`、`apps/presentation`、`apps/pdf`、`apps/pm`：MIT，迁移自
  [HeyPuter/everything](https://github.com/HeyPuter/everything)，各自目录下有
  `LICENSE` 文件。
- `apps/spreadsheet`：AGPL-3.0-only，迁移自 HeyPuter/everything，详见
  `apps/spreadsheet/LICENSE`。根目录 Apache 许可证不覆盖该应用；分发包含它的
  组合二进制或托管服务会就该应用触发 AGPL 义务。

上游问题应提交给上游，不要在本仓库维护分叉补丁。

## 状态

迁移方案 M0 到 M5 已实现：工作区搭建、存储抽取、AI 客户端、五个应用的 AI 接入、
联合 Shell 清单。除实时 AI 验证需要本机网关和已加载模型外，其余套件均可离线运行。
