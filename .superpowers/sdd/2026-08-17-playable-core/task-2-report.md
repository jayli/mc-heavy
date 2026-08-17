# Task 2 报告：块坐标、section 坐标和方块注册表

## 实现

- `src/domain/coords.ts`：定义 `SECTION_SIZE`、坐标类型，以及支持负坐标的 `sectionOf`、`localIndex`、`localPos`。
- `src/domain/blocks.ts`：定义渲染类别、方块定义和注册表接口；注册不可变的 air、stone、grass、water、sand、wood、leaves、glass（ID 0–7），支持按 key/id 查询并对未知值抛出明确错误。
- `tests/unit/domain/coords.test.ts`：覆盖负坐标 section/local 映射和最高局部索引。
- `tests/unit/domain/blocks.test.ts`：覆盖 water/stone 语义、按 ID 查询和未知 key 错误。

## TDD 证据

初始 RED：运行 `npm run test:unit -- tests/unit/domain/coords.test.ts` 时，因 `src/domain/coords.ts` 尚不存在而失败：`Cannot find module '../../../src/domain/coords'`。

实现后 GREEN：

```text
Test Files  2 passed (2)
Tests       4 passed (4)
```

简报中负坐标示例的索引手工值 `3855` 与明确公式不一致；经确认按公式保留实现，并将测试值修正为 `255`。

## 最终验证

- `npm run test:unit -- tests/unit/domain`：通过，2 个文件、4 个测试。
- `npm run lint`：通过。
- `npx tsc --noEmit`：通过。

## 提交

- Commit: `a9264b67b27a14a297cf9f1063fc4728d1a760f3`
- Message: `feat(domain): add voxel coordinates and block registry`

## 自审

- 坐标计算无 DOM、Three.js 或浏览器依赖，并使用 floor division 与正模处理负坐标。
- 方块定义和返回对象均不可变；未知 key/id 不会静默回退。
- 本任务范围外文件未修改（工作区原有 `docs/superpowers/plans/` 未跟踪内容保留）。
