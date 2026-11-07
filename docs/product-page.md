---
doc_id: fusion-office/product-page
product: fusion-office
class: app
entry: guided-ui
doc_type: product-page
title: { zh: "Fusion Office 产品页", en: "Fusion Office product page" }
audience: end-user
status: draft
version: 0.1.0
updated: 2026-11-07
owner: @dahai
source_of_truth:
  - README.md
  - start.sh
---

# Fusion Office

```yaml
slug: office
name: fusion-office
tagline:
  zh: 本机优先的办公套件：文档/表格/幻灯片/PDF/项目管理五件套，数据不出本机，AI 走本地网关
  en: Local-first office suite — documents, spreadsheet, presentation, PDF and PM in one, with data kept on your machine and AI routed through the local gateway
cta:
  zh: 打开浏览器写第一份文档，存进你自己的文件夹
  en: Open your browser, write a first document, and save it into your own folder
repo: https://github.com/dahai80/fusion-office
```

## capabilities

```yaml
capabilities:
  - icon: 📝
    name:
      zh: 文字处理 Documents
      en: Documents
    tag:
      zh: .docx 打开/保存，批注与修订，拼写检查
      en: Open and save .docx, with track changes, comments, and spellcheck
    points:
      - zh: Word 风格编辑器，样式、表格、页眉页脚
        en: Word-style editor with styles, tables, headers and footers
      - zh: 约束：复杂排版（分节符、域代码）与 Word 不完全等价
        en: Constraint: advanced layout (section breaks, field codes) is not fully Word-equivalent
    viz: []
  - icon: 📊
    name:
      zh: 表格 Spreadsheet
      en: Spreadsheet
    tag:
      zh: 公式、图表、数据透视表，.xlsx 读写
      en: Formulas, charts and pivot tables with .xlsx read/write
    points:
      - zh: 与 Documents 共享同一存储层与 AI 客户端
        en: Shares the same storage layer and AI client as Documents
      - zh: 约束：宏（VBA）不支持
        en: Constraint: macros (VBA) are not supported
    viz: []
  - icon: 🖼
    name:
      zh: 幻灯片 Presentation
      en: Presentation
    tag:
      zh: .pptx 支持 + AI 生成整份初稿
      en: .pptx support plus AI-generated first drafts
    points:
      - zh: 从主题生成结构化初稿再人工改，AI 产出可逐页拒绝
        en: Generate a structured draft from a topic, then edit per slide; AI output is rejectable page by page
      - zh: 约束：模板还原度依赖源文件复杂度
        en: Constraint: template fidelity depends on source-file complexity
    viz: []
  - icon: 📄
    name:
      zh: PDF
      en: PDF
    tag:
      zh: 批注、表单、OCR、Ask AI 侧栏
      en: Annotation, forms, OCR, and an Ask AI sidebar
    points:
      - zh: Ask AI 基于当前文件工作：读页、查找、跳转、缩放、书签
        en: Ask AI works on the open file: reads pages, finds text, jumps, zooms, bookmarks
      - zh: 约束：扫描件先 OCR 才能被 AI 读取
        en: Constraint: scanned files need OCR before the AI can read them
    viz: []
  - icon: 🗂
    name:
      zh: 项目管理 PM
      en: PM
    tag:
      zh: 任务、看板、时间线，本地数据
      en: Tasks, boards and timelines on local data
    points:
      - zh: 与其余四件共用本地存储，无账号体系
        en: Shares local storage with the other four apps; no account system
      - zh: 约束：单机使用，无多人协同
        en: Constraint: single-machine use, no collaboration
    viz: []
```

## workflow

```yaml
workflow:
  - name:
      zh: 安装启动
      en: Install and start
    action:
      zh: 克隆仓库构建后跑 ./start.sh，五个应用分别落在 11485–11489
      en: Build the repo and run ./start.sh; the five apps land on ports 11485-11489
    input:
      zh: Node/Bun 环境
      en: Node/Bun environment
    output:
      zh: 浏览器可访问的五个本地地址
      en: Five local addresses reachable from the browser
  - name:
      zh: 选择数据位置
      en: Pick a data location
    action:
      zh: 首次保存时选一个本机文件夹（或使用浏览器私有文件系统）
      en: Pick a local folder on first save (or use the browser-private file system)
    input:
      zh: 无
      en: none
    output:
      zh: 文档保存进你自己的文件夹
      en: Documents saved into your own folder
  - name:
      zh: 日常使用
      en: Daily use
    action:
      zh: 直接编辑；需要 AI 时点 Assistant / Ask AI
      en: Edit directly; tap Assistant or Ask AI when you want AI
    input:
      zh: 可选：本机 fusion-gateway 运行中
      en: Optional: local fusion-gateway running
    output:
      zh: 文件留在本机，AI 结果实时出现在侧栏
      en: Files stay local; AI results appear in the sidebar in real time
  - name:
      zh: 接入 web shell
      en: Mount into web shell
    action:
      zh: 经 fusion-gateway 以 manifest 挂进 fusion-web-shell 统一入口
      en: Mount via fusion-gateway manifests into the fusion-web-shell unified entry
    input:
      zh: gateway 与 shell 已运行
      en: Gateway and shell running
    output:
      zh: 统一登录后从 shell 内打开五件套
      en: The five apps open from the shell after unified login
```

## useCases

```yaml
useCases:
  - name:
      zh: 隐私敏感的日常文档
      en: Privacy-sensitive everyday documents
    headline:
      zh: 合同、笔记、报表全程不出本机
      en: Contracts, notes and reports never leave the machine
    body:
      zh: 原来用云文档，内容存他人服务器；现在文件存自己文件夹，编辑无网络请求。差别：数据主权回到本机，断网也能用。
      en: Cloud suites store content on someone else's servers; here files live in your folder and editing sends no network requests. Difference: data sovereignty on-machine, works offline.
  - name:
      zh: 本地模型加持的 AI 办公
      en: AI office work on local models
    headline:
      zh: AI 摘要/生成走本机网关，用量按用户归因
      en: AI summarize and generation go through the local gateway with per-user attribution
    body:
      zh: 原来办公 AI 把文档上传云端；现在 PDF 的 Ask AI、幻灯片生成请求发到本机 fusion-gateway，按网关模型策略与配额执行。差别：能力接近，数据路径完全不同。
      en: Office AI normally uploads your documents; here Ask AI and deck generation hit the local fusion-gateway under its model policy and quota. Difference: similar capability, a completely different data path.
```

## techDepth

```yaml
techDepth:
  - category:
      zh: 本地优先架构
      en: Local-first architecture
    items:
      - name: { zh: 存储层, en: Storage layer }
        desc: { zh: File System Access API 为主，OPFS 兜底，IndexedDB 做索引, en: File System Access API primary, OPFS fallback, IndexedDB for the index }
        steps:
          - zh: 见 packages/storage
            en: See packages/storage
      - name: { zh: AI 客户端, en: AI client }
        desc: { zh: 统一走 OpenAI 兼容的 fusion-gateway，含模型策略（fail-closed allowlist）, en: All AI goes through the OpenAI-compatible fusion-gateway, under its fail-closed model-policy allowlist }
        steps:
          - zh: 见 packages/ai-client
            en: See packages/ai-client
```

## 提交检查清单

- [x] 所有字段 zh/en 成对
- [x] 每条能力含一条约束
- [x] 端口/路径与 start.sh 实测一致
- [x] 无虚构数字（应用数量、端口为仓库事实）
