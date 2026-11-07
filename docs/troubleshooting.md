---
doc_id: fusion-office/troubleshooting
product: fusion-office
class: app
entry: guided-ui
doc_type: troubleshooting
title: { zh: "Fusion Office 故障排查", en: "Fusion Office troubleshooting" }
audience: end-user
status: draft
version: 0.1.0
updated: 2026-11-07
owner: "@dahai"
source_of_truth:
  - README.md
  - start.sh
  - packages/ai-client
---

# Fusion Office 故障排查（Troubleshooting）

> 按症状索引。五个应用共享存储层与 AI 客户端，多数问题症状一致。

## 打不开 / 服务类

### 浏览器显示无法访问 11485–11489

- 症状：页面打不开或连接被拒
- 诊断：`./start.sh status` 看进程是否存活；`dev/shell-serve.log` 看端口绑定
- 解法：`./start.sh stop` 后重新 `./start.sh start`；端口被占则先释放（端口注册见 `~/fusion/architecture/port-registry.yaml`）

### 从 shell（统一门户）打不开应用

- 症状：fusion-web-shell 里 iframe 空白
- 诊断：gateway 与 shell 是否运行；manifest 是否注册
- 解法：先确认直连 `http://localhost:11485/` 能打开；直连正常则问题在 gateway/shell 侧，查 gateway 日志

## 保存类

### 点 Save 没反应 / 保存失败

- 症状：点击 "Save" 后没有文件落盘，或顶部一直显示 "Unsaved changes"
- 诊断：浏览器是否支持 File System Access API（Chromium 系支持，Firefox/Safari 部分场景降级 OPFS）
- 解法：换 Chromium 系浏览器；或允许浏览器弹出的位置授权后重选文件夹

### 打开的 .docx 排版乱了

- 症状：Word 存的文件显示与 Word 不一致
- 诊断：复杂排版（分节符、域代码、艺术字）尚不完全等价
- 解法：简化源文件后再打开；把样本附到 issue 帮助改进兼容性

## AI 类

### Assistant / Ask AI 报模型不可用或 403

- 症状：AI 侧栏提示无可用模型或权限拒绝
- 诊断：本机 fusion-gateway 是否在跑；租户模型策略（allowlist）是否配置
- 解法：启动 fusion-gateway；模型由网关侧租户策略统一决定，本应用不提供模型选择，联系管理员配置 allowlist

### AI 响应很慢或超时

- 症状：侧栏长时间转圈
- 诊断：本地模型首次加载耗时属正常；PDF 扫描件需先 OCR
- 解法：等待模型加载完成；扫描件先跑 OCR 再问

## 数据类

### 换浏览器后文件"消失"

- 症状：另一台浏览器里看不到之前的文档
- 诊断：OPFS 数据按浏览器 origin 隔离，不跨浏览器共享
- 解法：把文件保存进你选的本机文件夹（而非浏览器私有存储），即可跨浏览器打开

## 反馈

同一症状出现 3 次以上的，把根因与解法补充到本文件并附 issue 链接：
https://github.com/dahai80/fusion-office/issues
