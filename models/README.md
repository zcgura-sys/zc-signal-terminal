# Live2D 模型资源

本目录下的两套模型取自开源仓库 [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 的 `test/assets/`（该仓库自带的官方示例素材，用于其测试与示例）。

| 模型 | 运行时版本 | 入口文件 | 体积 | 内容 |
|---|---|---|---|---|
| **Haru**（春日） | Cubism **4** | `haru/haru_greeter_t03.model3.json` | 3.2 MB | 2 张贴图 / 8 个表情 / 5 个动作 / 物理 + 姿势 |
| **Shizuku**（雫） | Cubism **2** | `shizuku/shizuku.model.json` | 6.6 MB | 6 张贴图 / 4 个表情 / 18 个动作 / 15 个音效 |

合计 66 个文件，约 9.8 MB。

## 目录结构

```
models/
├── index.json                      # 模型清单（程序读这个即可）
├── haru/                           # Cubism 4
│   ├── haru_greeter_t03.model3.json    ← 入口
│   ├── haru_greeter_t03.moc3           # 模型网格数据
│   ├── haru_greeter_t03.physics3.json  # 物理（头发/衣服摆动）
│   ├── haru_greeter_t03.pose3.json
│   ├── haru_greeter_t03.2048/          # texture_00.png / texture_01.png
│   ├── expressions/F01..F08.exp3.json
│   └── motion/haru_g_idle|m05|m07|m14|m15.motion3.json
└── shizuku/                        # Cubism 2
    ├── shizuku.model.json              ← 入口
    ├── shizuku.moc
    ├── shizuku.physics.json
    ├── shizuku.pose.json
    ├── shizuku.1024/                   # texture_00..05.png
    ├── expressions/f01..f04.exp.json
    ├── motions/*.mtn                   # idle / tapBody / flickHead / shake / pinchIn / pinchOut
    └── sounds/*.mp3
```

## 授权（重要，请勿忽略）

- **代码 vs 素材**：`pixi-live2d-display` 的**代码**是 MIT；但这两套**模型素材本身属于 Live2D Inc. 的官方示例数据**，受 *Live2D Free Material License Agreement* 约束，**不是 MIT，也不随本仓库的许可分发**。
- 允许：个人学习、技术评估、非商业展示（保留出处）。
- 需要额外授权：**商业用途**、转售素材本体、把模型当作产品卖点大规模分发。
- 如果你要把这个终端公开商用，请自行核对当前协议原文：
  https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html

## 运行时依赖（不在本仓库内，按 Live2D 协议需从官方/CDN 引入）

```
# Cubism 4 Core（Haru 必需）
https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js

# Cubism 2 Core（Shizuku 必需）
https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js
```

## 用法示例（pixi-live2d-display）

```js
import { Application } from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4'; // 或用 /cubism2 加载 Shizuku

const app = new Application({ view: canvas, backgroundAlpha: 0, autoStart: true });
const model = await Live2DModel.from('models/haru/haru_greeter_t03.model3.json');
app.stage.addChild(model);
model.scale.set(0.25);
model.motion('Idle');           // 播放待机动作
model.expression('F01');        // 切换表情
```

> 提示：Cubism 2 与 Cubism 4 的 Core 不能同时加载，一个页面只用一种；两套模型建议分两个页面/iframe。

---

`_report.txt` 是抓取过程的原始日志，可随时删除。
