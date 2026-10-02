# Live2D 模型资源

本目录下的两套模型取自开源仓库 [guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 的 `test/assets/`（该仓库自带的官方示例素材，用于其测试与示例）。

| 模型 | 运行时版本 | 入口文件 | 体积 | 内容 |
|---|---|---|---|---|
| **Haru**（春日） | Cubism **4** | `haru/haru_greeter_t03.model3.json` | 3.2 MB | 2 张贴图 / 8 个表情 / 5 个动作 / 物理 + 姿势 |
| **Shizuku**（雫） | Cubism **2** | `shizuku/shizuku.model.json` | 6.6 MB | 6 张贴图 / 4 个表情 / 18 个动作 / 15 个音效 |

合计 66 个模型文件，约 9.5 MB。另含 `README.md`、`index.json`、`_report.txt`、`_verify.txt` 四个说明/日志文件。

## 目录结构

```
models/
├── index.json                      # 模型清单（程序读这个即可，路径相对 models/）
├── haru/                           # Cubism 4
│   ├── haru_greeter_t03.model3.json    ← 入口
│   ├── haru_greeter_t03.moc3           # 模型网格数据（magic: MOC3）
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

## 完整性校验结果（真实跑过）

对全部 24 个 JSON 做了引用解析，共 121 处资源引用：

```
missing refs        : 0（除下方说明的 cdi3.json）
refs leaving models/ : 0
跨模型引用           : haru 的 Tap 音效 -> ../shizuku/sounds/flickHead_00|01.mp3  exists=true
渲染必需文件         : haru 5/5 存在、shizuku 全部存在
文件头校验           : *.png=89504e47、haru .moc3=4d4f4333(MOC3)、shizuku .moc=6d6f63(moc)、*.mp3=49443304(ID3)
```

两点需要知道：

1. **`haru_greeter_t03.cdi3.json`（DisplayInfo）缺失** —— 上游仓库本身就没有这个文件。它只用于 Cubism Editor 里显示参数别名，**不影响渲染**；模型 json 里这一项是可选的，pixi-live2d-display 官方测试同样在缺该文件的情况下跑通。
2. **Haru 的动作音效引用了 Shizuku 的 mp3**（`../shizuku/sounds/...`）—— 这是上游原始数据就这么写的。两套模型必须**放在同一父目录**下，否则音效会 404。现在的位置是对的，别把 `haru/` 单独拷走。

## 授权（重要，请勿忽略）

- **代码 vs 素材**：`pixi-live2d-display` 的**代码**是 MIT；但这两套**模型素材本身属于 Live2D Inc. 的官方示例数据**，受 *Live2D Free Material License Agreement* 约束，**不是 MIT，也不随本仓库的许可分发**。
- 允许：个人学习、技术评估、非商业展示（保留出处）。
- 需要额外授权：**商业用途**、转售素材本体、把模型作为产品卖点大规模分发。
- 如果要把这个终端公开商用，请自行核对当前协议原文：
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
import { Live2DModel } from 'pixi-live2d-display/cubism4'; // 加载 Shizuku 换成 /cubism2

const app = new Application({ view: canvas, backgroundAlpha: 0, autoStart: true });
const model = await Live2DModel.from('models/haru/haru_greeter_t03.model3.json');
app.stage.addChild(model);
model.scale.set(0.25);
model.motion('Idle');      // 待机动作
model.expression('f01');   // 切换表情
```

> 提示：Cubism 2 与 Cubism 4 的 Core **不能同时加载**，一个页面只用一种；两套模型建议分两个页面 / iframe 使用。

---

`_report.txt`（抓取日志）和 `_verify.txt`（校验输出）是过程证据，可随时删除。
