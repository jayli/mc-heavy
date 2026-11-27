# mc-heavy

Minecraft 风格体素游戏引擎。功能对标姊妹仓库 [mc-lite](../mc-lite)，
但架构完全重做：目标是**同样的玩法 + 更鲁棒、更可扩展、更高性能的引擎底座**。

- 纯 JavaScript（ES Modules + JSDoc），**无 TypeScript、无构建步骤**
- three.js **r185.1**（本地 `vendor/three/`），**WebGPU 唯一后端**
- 体素数据 typed array 为唯一权威，重计算全部在 Worker 池，确定性按需生成（无预生成）

## 快速开始

```bash
npm install          # playwright 固定 ^1.62.1
npm start            # 静态服务 http://localhost:8081
npm run check        # 日常最小门（约 2.6s）= check:arch + check:data + lint
npm test             # Playwright 全部验收（tests/*.spec.mjs）
npm run bench        # 性能基线跑图；加 -- --check 为回归门禁（回退 >10% 阻断）
npm run icons        # 烘焙全量背包图标（改背包内方块贴图/几何后需跑）
npm run atlas        # 重新生成 assets/atlas.png + atlas.json（世界渲染 atlas）
```

- 打开 `http://localhost:8081`。
- 浏览器内单测入口：`http://localhost:8081/src/tests/index.html`。

<img width="1228" height="701" alt="wallpaper" src="https://github.com/user-attachments/assets/46c872f6-206b-4c66-b879-9af9399f3599" />
