# 贡献指南

感谢你考虑为 DeepSeek Companion 贡献！本文件是开发者上手的最短路径；
架构契约与编码规范的唯一权威来源是 [DESIGN.md](./DESIGN.md)。

## 环境准备

- Node.js `^22.19 || >=24`（开发期 HMR 需 Node ≥ 24.11，见 README「开发期热更新」）
- pnpm ≥ 10（`npm install -g pnpm`；本项目以 pnpm 为唯一包管理器，请勿混用 npm/yarn 生成第二份锁文件）

```bash
git clone https://github.com/beijingwahw/dsh-companion.git
cd dsh-companion
pnpm install
```

## 日常开发循环

```bash
pnpm dev        # 起 cordis + HMR：保存 src/ 任意文件即热重载（无需重启）
pnpm typecheck  # tsc --noEmit，提交前必须通过
pnpm build      # tsc → lib/（产物随仓库分发，提交前必须重新构建）
pnpm test       # 全部冒烟套件（test/ 下每个 *.mjs 一个子进程，失败即非零退出）
```

CI（`.github/workflows/ci.yml`）在 Node 22 / 24 两个版本上执行同样的三步：
typecheck → build → test。本地全绿即约等于 CI 全绿。

## 代码规范（摘要，全文见 DESIGN.md）

- TypeScript `strict: true`；不使用 `any`，确需宽松处用 `unknown` + 收窄。
- ESM；本地相对导入一律带 `.js` 后缀（NodeNext）。
- 注册即 effect：命令/路由/提示词注册都返回 disposer，交给 Cordis 生命周期。
- 品牌 id 经 `src/core/ids.ts` 铸造（`SessionId(x)`），禁止裸 string 跨边界。
- 模块间不互相 import；跨模块协作只经过 `ctx.companion` / `ctx.companionCost`。
- 每个文件与导出符号写简洁中文 JSDoc（说明契约，不复述代码）。

## 测试约定

- 算法 / 引擎级改动：在 `test/` 新增或扩展冒烟套件（纯 Node ESM + `node:assert/strict`，
  驱动 `lib/` 编译产物；套件末行打印 `全部通过：N 项断言` 供运行器汇总）。
  参考现有 `axes-*.mjs` 与 `core-primitives.mjs` 的结构。
- 修 bug 先写复现断言，再改代码（`pnpm build` 后断言转绿）。
- 新增套件无需注册：`test/run-all.mjs` 自动发现 `test/*.mjs`（下划线前缀除外）。

## 提交与 PR

- 提交信息用中文或英文均可，祈使句一行主题（≤ 50 字符）+ 空行 + 说明正文。
- PR 前自查：`pnpm typecheck && pnpm build && pnpm test` 全绿；
  `lib/` 产物已随源码一并更新（dsh 经 git 安装不执行构建脚本）。
- 涉及用户可见变更时同步更新：双语 README（`README.md` / `README.en.md`）与 `CHANGELOG.md`。

## 目录速览

```
src/       宿主 + 客户端源码（core 核心设施 / modules 七大模块 / client 浏览器端 UI）
lib/       编译产物（随仓库分发，勿手改）
test/      冒烟套件 + 统一运行器
dev/       开发期宿主桩（HMR 用）
```
