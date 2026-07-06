# 为何 Upkeep 是 reusable workflow（而非 step action）

多数 GitHub Actions 是以 **step** 形式使用：

```yaml
steps:
  - uses: actions/checkout@v4
```

Upkeep 则是以 **job** 形式使用，指向一个 workflow 文件：

```yaml
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
```

第二种写法相较于常见的 `- uses: owner/action@v1` 显得陌生，会被问为什么。它其实是 **reusable workflow**（`on: workflow_call`）标准、官方文档记载的语法——见 [GitHub: Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)。以下说明 Upkeep 为何这样设计。

## 原因：并行、故障隔离的 reviewer 需要 `strategy.matrix`

Upkeep 会分派一组 reviewer。我们希望每位 reviewer：

- **并行**执行——一次完整审计不该花掉单一 reviewer 墙钟时间的六倍；以及
- **故障隔离**——某位 reviewer 失败（超时、API 抽风）不能中断其他人。

「把同一单元并行、独立地跑很多次」对应的原生 GitHub 机制就是 `strategy.matrix`。**matrix 是 job 层级的功能**：只有 *workflow* 能声明 job 与 matrix，*action* 不能。要把 reviewer 扇出（fan out）到多个并行、隔离的 matrix job，Upkeep 必须是 reusable workflow。

## 为何不干脆做成 action？

action 有两种，两种都无法表达这种扇出：

- **JavaScript / Docker action**——单一入口（例如 `main: dist/index.js`）。它无法 `uses:` 另一个 action，因此无法把 LLM 工作委派给 [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)，得自己调用 Claude；而且它仍无法并行跑 job。
- **Composite action**——以 **一个** job 内的一连串 *step* 执行。它*可以* `uses:` 其他 action（故能调用 `claude-code-action`），但没有 matrix，reviewer 会在单一 job 内**串行**执行。

所以 composite action（`- uses: wei18/upkeep@v2`）*是*做得到的——代价是 reviewer 变串行。Upkeep 刻意选择 reusable workflow 形式，以保持 reviewer 并行且各自隔离。对排程审计而言，较慢的串行路径其实可接受；但我们偏好并行与干净的故障隔离。

v2.1 起，repo root 已提供对应这个取舍的 `action.yml`（`- uses: wei18/upkeep@v2`）——一个串行执行、可在 GitHub Marketplace 曝光的替代路径。当 reviewer 并行性重要时，上面的 reusable workflow 仍是推荐的集成路径。

## 你实际放弃的是什么

只有调用端语法。用 `jobs.<id>.uses: owner/repo/.github/workflows/file.yml@ref` 取代 `- uses: owner/action@ref`。其余一切都跟 action 一样：用 `with:` 传 inputs、用 `secrets:` 传 secrets、用 `@v1` 钉版本。
