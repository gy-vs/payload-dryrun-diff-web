# Payload 迁移 Dry-run 审阅台

本地工作台：选定两个流水线 revision，对固定样例集合做 dry-run，按路径审阅新增 / 删除 / 类型变化 / 转换失败。**只生成审阅结果，不写回任何外部系统。**

## 运行

```bash
npm install
npm run dev        # tsx watch (4174) + vite dev (4173, /api 代理到 4174)
npm start          # 仅 API
npm test           # vitest（32 个测试）
npm run build      # tsc 类型检查 + 前端构建
```

## 能力与约定

- **固定 catalog**：3 个 revision（`rev-legacy` / `rev-current` / `rev-canary`）、第 1 代 7 个固定样例；`POST /api/testing/sample-set {generation}` 可切到第 2 代（9 个样例，含 canary 严格校验失败与双侧重复键）。
- **结构化 diff**（`src/server/diff.ts`）：
  - 数组元素优先按配置的稳定键对齐（`$.orders → orderId|id`，首个存在的候选生效），**没有配置键才按位置**比较；
  - 重复稳定键按出现次序 FIFO 配对，多余元素整元素新增/删除并产生唯一路径（`[occurrence=n]`），同时给出 `duplicate_stable_key` 诊断；缺键元素回落到位置配对并诊断；
  - 叶子差异分类：`added` / `removed` / `type_changed`（另有 `value_changed` 供详情展示）；某侧 transform 抛错则样例标记 `failed`，错误归因到消息中的路径（如 `$.age`），否则归到根。
- **并发与取消**（`src/server/runManager.ts`）：有界 worker 池（默认 3，上限 8）；取消后清空队列，**在途样例迟到的结果一律丢弃**，不进缓冲也不推给订阅者。
- **有界事件缓冲与重连**：每个 run 维护固定大小的持久事件环，事件带单调 `id`（即 SSE `id:`，浏览器重连自动回传 `Last-Event-ID`）。游标仍在缓冲内则只补发增量；游标已被挤出（或首次连接）则先发全量 `snapshot`（含高水位）再发后续事件。
- **会话过期**：run 终态后 TTL（默认 10 分钟，定时器 unref）清理，GET / cancel / SSE 对已消失会话统一 404，在线订阅者收到 `run_expired`。
- **样例集合更新**：建 run 时携带 `expectedGeneration`，catalog 已更新则 409 `sample_set_updated` 并回传新 catalog；旧 run 继续按其捕获的样例跑完，前端提示 stale 但仍可审阅旧结果。
- **前端**（`src/client/`）：事件经纯函数 reducer 增量归并（按 id 幂等去重，旧 run 的迟到事件直接拒绝）；运行中标注「部分统计」；从汇总路径进入详情后，后续结果到达不改变选中路径；重连中 / 缓冲回退快照 / 过期 / 集合更新均有横幅。

## HTTP

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /api/catalog` | revisions、样例、稳定键配置、`X-Sample-Generation` |
| `POST /api/runs` | `{leftRevisionId, rightRevisionId, expectedGeneration?, concurrency?}` → 201 / 409 |
| `GET /api/runs/:id` | 当前快照（404 = 已过期） |
| `POST /api/runs/:id/cancel` | 请求取消 |
| `GET /api/runs/:id/events` | SSE；支持 `Last-Event-ID` 头或 `?lastEventId=` |
| `POST /api/testing/sample-set` | 测试/演示用：切换样例集合代次 |
