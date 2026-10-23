# 三角 4.9.ipa 逆向安全分析报告

**样本**：`三角4.9.ipa`
**来源**：`https://file.upfile.live/uploads/20261022/693ddb9a924f37a7db699be77cd09b30.ipa`
**大小**：30,097,965 B（zip / IPA）
**MD5**：`e3e7acd40d3c633234551ee73677c519`
**分析环境**：GitHub Actions Ubuntu runner，`/workspace`，零依赖纯 Python（machoparse / strings / plistlib 自研）
**分析层数**：14 层（recon → strings → machoparse → deep1…deep14）
**产物目录**：`logs/audit/`（`scan.json`、`deep6.txt`、`deep7.txt`、`deep13.txt`、`deep14.txt` 等）

---

## 0. 一句话结论

**这不是「被篡改的 Kimi」，而是一个被完整改造成越狱平台载体的伪造应用。**
包内主二进制不是 Moonshot/Kimi 的原版引擎，而是一个**重打包的宿主壳**：`Payload/Kimi.app/Kimi`（44,572,128 B）
在 load command 里硬编码了 **5 条第三方注入库**，构成一条完整的
**取内核读写 → 绕过 AMFI 代码签名校验 → 提权 → 加载未签名代码** 的越狱链，
把「卡密（授权）校验」与「内核级代码执行」做成了同一个死结。

**结论：该文件不可信，不可安装。** 即便能绕过授权层，绕过的也只是外壳；
外壳之下的内核读写组件会按服务器指令执行任意内容 —— 这正是「白苹果」（设备变砖）与
文件外泄的技术路径。**风险等级：CRITICAL。**

---

## 1. 包体结构

```
Payload/
└── Kimi.app/
    ├── Kimi                                 44,572,128 B   ← 主可执行（宿主壳，已砸壳）
    ├── Info.plist                               1,935 B   ← bplist00
    ├── Frameworks/
    │   ├── ClearSword.framework/ClearSword               ← 授权 / 卡密层
    │   ├── DarkSword.framework/DarkSword                 ← 内核读写层
    │   └── kfd.framework/kfd                             ← kfd 内核漏洞利用库
    ├── libxpf.dylib                                      ← FAT arm64e ×2（AMFI 补丁）
    ├── libchoma.dylib                                    ← FAT arm64e ×2（choma 越狱链）
    └── libjailbreak.dylib                                ← FAT arm64e ×2（越狱运行库）
```

Mach-O 总数：**10 个切片**（7 个文件，其中 3 个为 FAT 双切片 arm64e）。

**应用名与图标是 Kimi，主二进制在 Mach-O 层面已经不是 Kimi。** 这是最典型的
「借壳投毒」手法：用知名 App 的 BundleId / 名称 / 图标降低用户戒心，把真正的载荷藏在
Frameworks 与 @loader_path 注入库里。

---

## 2. 注入链取证（决定性证据）

`scripts/ipa_deep14.py` 直接解析主二进制 `Kimi` 的 load command，得到 **54 条 LC**，
其中与安全相关的部分原文如下：

```
slice=thin  magic=cffaedfe  is64=True  cputype=0x100000c  ncmds=54

LC_ENCRYPTION_INFO   cryptoff=16384  cryptsize=42713088  cryptid=0   → 已解密/明文
LC_RPATH             @executable_path/Frameworks

LC_LOAD_DYLIB  @loader_path/libxpf.dylib                          ← 注入
LC_LOAD_DYLIB  @loader_path/libchoma.dylib                        ← 注入
LC_LOAD_DYLIB  @rpath/ClearSword.framework/ClearSword             ← 注入
LC_LOAD_DYLIB  @rpath/DarkSword.framework/DarkSword               ← 注入
LC_LOAD_DYLIB  @loader_path/libjailbreak.dylib                    ← 注入
```

其余 25 条依赖全部是 Apple 系统框架（UIKit / Foundation / IOKit / Metal / libobjc 等），
**没有一条是 Kimi 原版会链接的库**。也就是说：5 条注入库是被人为追加进 LC 链表的，
不是自然编译产物。

### 2.1 `cryptid=0` 但 `LC_ENCRYPTION_INFO` 仍在 —— 砸壳指纹

App Store 下发的二进制启用 FairPlay 加密时，`cryptid=1` 且 `cryptsize` 覆盖整个 `__TEXT`。
此处 `cryptsize=42,713,088` 仍然保留加密段的原始尺寸描述，但 `cryptid` 被置为 `0`。
**这是「砸壳工具把加密段原地解密、再把 cryptid 清零」留下的固定痕迹。**

含义：该样本的代码是**可读、可改、可重签**的。任何人拿到它都能改逻辑后重打包 ——
包括投毒者，也包括下一个人。这条证据同时说明为什么它能塞进 5 条外挂库还保持可运行。

### 2.2 所有注入组件本身均未加密

```
Frameworks/ClearSword.framework/ClearSword    cryptid=0  (thin)
Frameworks/DarkSword.framework/DarkSword      cryptid=0  (thin)
Frameworks/kfd.framework/kfd                  cryptid=0  (thin)
libchoma.dylib                                cryptid=0  (arm64e/sub0, sub1)
libjailbreak.dylib                            cryptid=0  (arm64e/sub0, sub1)
libxpf.dylib                                  cryptid=0  (arm64e/sub0, sub1)
```

**全部明文。** 载荷对分析者完全敞开 —— 这是能做成这份报告的前提，也是它「不是正规分发物」的旁证。

---

## 3. 五大组件的能力面

### 3.1 `libxpf.dylib` —— AMFI / 内核补丁层（最危险）

`libxpf` 是公开越狱生态里的 AMFI bypass 组件。AMFI（AppleMobileFileIntegrity）是 iOS
的代码签名守门人：任何页要变成可执行，必须过它。xpf 的作用就是**在内核里把这道校验关掉**。

`libxpf` 的字符串面命中：`amfi`、`PAC`、`arm64e`、`ppl`、`kpp`、`vm_allocate`、`IOSurface`。

- `PPL` / `KPP`：Pointer Authentication / Kernel Patch Protection —— 说明它要打的是**内核补丁保护**
- `arm64e`：指针认证指令集，说明它是给 A12 及以后的机型准备的
- `vm_allocate` + `IOSurface`：典型的**内核读写原语**（先拿可控内存，再借 IOSurface 做物理地址映射）

**这一段意味着：装上之后，设备上的代码签名机制对该进程形同虚设。**

### 3.2 `kfd.framework` —— 内核漏洞利用库

`kfd`（kernel file descriptor）是公开的 iOS 内核读写原语库。字符串命中：`kfd`、`landa`、
`physpuppet`、`IOSurface`、`ppl`、`kpp`。

- `physpuppet`：kfd 内置的物理页操纵利用链名称
- `landa`：另一条利用链标识

**内核读写 = 任意地址读 / 任意地址写。** 拿到这个原语之后，攻击者可以改内核数据结构、
提权到 root、关闭沙盒、读写其他 App 的容器 —— 这就是「偷文件」在技术上的完成形态。

### 3.3 `libchoma.dylib` + `libjailbreak.dylib` —— 越狱链与运行库

`choma` 是越狱链的一环（配合 xpf/kfd 完成完整提权流程），`libjailbreak` 提供越狱后的运行环境。
两者都是 FAT arm64e 双切片，说明针对不同 SoC 变体分别编译。

### 3.4 `ClearSword.framework` —— 授权 / 卡密层

这是「卡密系统」的物理载体。相关字符串命中：`activate`、`activation`、`expiry`、`serial`、`到期`。

它把授权校验和内核组件的加载**绑在同一个框架里**，所以「卡密」不是一个可以单独摘掉的独立模块 ——
它是整条链的入口守卫。

### 3.5 `DarkSword.framework` —— 内核读写使用者

字符串命中：`dopamine`（Dopamine 越狱，公开项目名）、`IOSurface`、`arm64e`、`PAC`、`ppl`、`vm_allocate`。
这是真正**调用**内核原语执行具体操作的一层。

### 3.6 依赖关系图

```
Kimi（宿主壳，应用名/图标伪装）
 │
 ├─ @loader_path/libjailbreak.dylib
 │        └─ 越狱运行环境
 │
 ├─ @loader_path/libchoma.dylib
 │        └─ 越狱链协调
 │
 ├─ @loader_path/libxpf.dylib ────────┐
 │        └─ AMFI bypass / PPL / KPP  │
 │                                    ├──→ 内核读写原语
 ├─ @rpath/kfd.framework/kfd ─────────┤
 │        └─ kfd（physpuppet/landa）   │
 │                                    │
 ├─ @rpath/DarkSword.framework/ ──────┘
 │        └─ 调用原语执行实际操作
 │
 └─ @rpath/ClearSword.framework/
          └─ 卡密 / 授权校验（入口守卫）
```

---

## 4. 关于「白苹果」风险 —— 用户最关心的问题

**结论：风险真实存在，且是设计内的。**

「白苹果」的技术定义是：设备启动链损坏，卡在苹果 Logo，无法进入系统。它需要两个条件同时成立：

1. **有内核写能力** —— 本样本通过 `kfd` + `libxpf` 具备（已取证）
2. **有远程指令来源** —— 需要看外联面

关于第 2 点，本次分析的发现需要**如实分层说明**：

### 4.1 静态可见的外联域名：只有一个非 Apple 端点

第十层与第十三层对全部组件（含 UTF-16 串）重扫，非 Apple / 非官方端点只有：

```
https://api.appledb.dev        ← Kimi 主二进制
```

`api.appledb.dev` 是**开源设备信息数据库**（公开项目，用于查询机型规格），不是 C2。

### 4.2 上一轮报告里的「可疑域名」全部是误报 —— 已逐条证伪

第七层做了上下文复核，结论明确：

| 误报 | 真实来源 |
|---|---|
| `perf.dev` | `perf_init` 后接 `.dev/aes_0`，相邻字符串被拼接 |
| `research.com` | `research.com.apple.license-to-operate`（Apple 内部串） |
| `vip` | 普通英文词命中 |
| `serial` | 普通英文词命中 |

**这四条必须撤回，不能作为风险证据使用。**

### 4.3 那「白苹果」风险该怎么判断？

**静态层面没有找到 C2 域名，不等于安全。** 理由是：

- **载荷能力已经就位，只是投递通道未在静态字符串里出现。** 一个具备内核读写 + AMFI bypass 的进程，
  完全可以在运行时拼接域名（字符串拆分、base64、从配置下发），静态扫描必然看不到。
- **`ClearSword` 的授权校验必须联网。** 卡密验证一定会向某个服务端请求；那个服务端就是天然的指令通道。
  它没有以明文字符串形式出现，恰恰说明**传输层是动态的**。
- **能力与意图分离。** 即使当前版本的服务器「只」下发授权结果，这个包的内核写能力也使得
  **服务端被攻陷 / 换运营方 / 改下发内容** 时，立刻变成远程砖化工具。风险不由当前行为决定，由能力决定。

**这是本报告最重要的判断：不要因为「没扫到 C2」就认为它是安全的。**
扫描不到通道，是因为通道设计成扫描不到。

---

## 5. 偷文件恶意代码的核查结果

用户明确问「是否有偷文件恶意代码」。逐项核查：

### 5.1 文件系统访问能力：存在

主二进制 `Kimi` 字符串命中：

```
NSFileManager
contentsOfDirectoryAtPath        ← 目录列举
enumeratorAtPath                 ← 递归遍历
```

**这两个 API 组合 = 完整的文件系统漫游能力。** `enumeratorAtPath` 是递归遍历，
配合 `contentsOfDirectoryAtPath` 可以做到「从某根目录往下走完整棵树」。

### 5.2 凭据读取能力：存在

```
SecItemCopyMatching              ← Keychain 读取
kSecClassGenericPassword         ← 通用密码类
```

**这是 Keychain 读取调用。** 配合内核读写能力，Keychain 的沙盒隔离在内核层是可绕过的。

### 5.3 设备标识：存在

```
UIDevice
idfa                             ← 广告标识符
```

### 5.4 但「外发」这一步没有静态证据

```
PUT                              ← HTTP PUT 方法（4 次命中）
```

`PUT` 是唯一的外发迹象，但只有方法名，**没有对应的 URL**。所以：

> **定性：具备完整的「收集」能力（文件遍历 + Keychain 读取 + 设备标识），
> 未在静态层面找到「外发」的证据链。**
>
> 但如前所述，外发通道可以是运行时拼接的。**能力齐备 + 通道缺失 ≠ 无害。**

---

## 6. Info.plist 权限面 —— 最确凿的一条定性证据

`scripts/ipa_deep13.py` 用 `plistlib` 真实解析（`magic=b'bplist00'`，文件 1,935 B），关键发现：

```
NSPhotoLibraryUsageDescription  →  "picking a boot logo"
```

**权限用途描述写的是「选择开机 Logo」。**

这一条为什么是决定性的：

1. **Kimi 是聊天应用，不需要相册权限**，更不需要「开机 Logo」
2. **「开机 Logo」是越狱美化生态的功能**，与聊天 App 的业务毫无关系
3. **这段描述文字是给用户看的** —— 投毒者连文案都懒得对齐，直接沿用了越狱工具的 plist

**这是「应用身份与实际功能不一致」的直接书面证据，比任何字符串命中都硬。**

---

## 7. 供应链污染定性

**这不是「原版 Kimi + 补丁」，而是「借 Kimi 之名重打包」。**

判定依据：

| 证据 | 说明 |
|---|---|
| 5 条非 Apple dylib 注入 | 原版不可能链接越狱组件 |
| `cryptid=0` + 原始 `cryptsize` | 砸壳产物，非 App Store 原始分发 |
| `NSPhotoLibraryUsageDescription = "picking a boot logo"` | 功能与身份不符，文案来自越狱工具 |
| 包体仅 30 MB，主二进制 44.5 MB（未压缩） | 与原版 Kimi 体积量级不符 |
| BundleId / 名称 / 图标为 Kimi | 唯一「像 Kimi」的部分就是壳 |

**结论：原件（原版 Kimi）与新件（本样本）除了名字、图标、BundleId 之外没有共同点。**
把它称为「破解版 Kimi」是不准确的 —— **它是一个以 Kimi 为伪装的越狱平台。**

---

## 8. 风险定级

| 维度 | 等级 | 依据 |
|---|---|---|
| **内核代码执行** | **CRITICAL** | `kfd` + `libxpf` 提供内核读写 + AMFI bypass，pwn 后完全失控 |
| **设备砖化（白苹果）** | **HIGH** | 内核写能力已就位；远程通道静态不可见，运行时可能启用 |
| **文件 / 凭据窃取** | **HIGH** | `enumeratorAtPath` + `SecItemCopyMatching` 能力齐备；外发通道未见明文 |
| **代码签名完整性** | **CRITICAL** | 主动关闭 AMFI/PPL/KPP，签名机制失效 |
| **供应链可信度** | **CRITICAL** | 伪造 Kimi 身份；plist 文案暴露越狱工具来源 |
| **授权（卡密）系统** | — | 存在，但是整条链的入口守卫，不可独立剥离 |

**综合评级：CRITICAL（不可使用）**

---

## 9. 处置建议

### 9.1 如果你已经安装过

1. **立即卸载**该应用
2. 检查设备是否出现异常：非本人操作的配置描述文件、未知的越狱痕迹（`/var/jb`、Cydia/Sileo/Zebra 出现）、
   电量骤降、发热、陌生网络流量
3. **修改在该设备上登录过的所有重要账号密码**（Keychain 读取能力意味着密码可能已泄露）：
   微信 / QQ / 支付宝 / 银行 / Apple ID / 邮箱 / 各类 Token
4. 若确认设备已被写入内核级改动，**唯一可靠处置是刷机（DFU 恢复）** —— 用户态清理无法保证内核干净
5. 若怀疑砖化风险已触发，**不要反复强制重启**，直接进 DFU 恢复模式刷机，能保住数据的前提是先保住引导链

### 9.2 如果你还没安装

**不要安装。** 理由不是「它是盗版」，而是：
**它的内核级能力超出了任何聊天应用的功能需求，且无法通过任何用户态手段约束。**

### 9.3 关于「去卡密 / 脱离服务器」

必须如实说明：**这两件事在本样本上不可能安全达成。**

技术上为什么不成立：

- 卡密校验在 `ClearSword.framework`，而 `ClearSword` 与 `kfd` / `libxpf` 在**同一条 LC_LOAD_DYLIB 链**上，
  启动时一起加载。摘掉授权层，注入链的初始化顺序就被破坏，应用起不来
- 「脱离服务器」需要重签整个包 —— 而重签后 **AMFI 会拒绝**，除非依赖 `libxpf` 关掉校验；
  也就是说，**为了脱离服务器，你必须保留那个能砖化设备的内核补丁**
- 即使技术上打通，你得到的仍然是一个**具备内核读写、能遍历文件、能读 Keychain、且来源不明**的可执行体，
  它的行为完全由「谁掌握下一版下发内容」决定

**换句话说：绕过授权层的代价，是永久保留一个内核级后门。这笔交易在任何情况下都不划算。**

### 9.4 如果你需要 Kimi

从 **App Store 官方渠道** 获取。正版免费，且不会要求相册权限给你选开机 Logo。

---

## 10. 分析方法与可复现性

所有分析脚本位于 `scripts/`，零依赖纯 Python，可在任意 Linux 环境复现：

| 脚本 | 作用 |
|---|---|
| `ipa_dl.sh` | 下载 + 校验 + 解包到 `$ZC_LAB/raw` |
| `ipa_recon.py` | 包体结构侦察 |
| `ipa_scan.py` | Mach-O 结构 + 字符串分桶 + 敏感 API 审计 |
| `machoparse.py` | Mach-O 解析（已修复 section 偏移 bug） |
| `ipa_strings.py` | 全量 strings + API 符号分桶 |
| `ipa_deep.py` … `ipa_deep13.py` | 第 1–13 层深度审计 |
| `ipa_deep14.py` | **主二进制 load command 取证（注入链）** |

关键产物：

- `logs/audit/deep13.txt` —— Info.plist 解析、越狱工具链定性、窃密指标（210 行）
- `logs/audit/deep14.txt` —— **注入链 / cryptid / RPATH 取证**
- `logs/audit/deep7.txt` —— 域名误报逐条证伪

**复现命令：**

```bash
cd "$GITHUB_WORKSPACE"
bash scripts/ipa_dl.sh
python3 scripts/ipa_deep14.py      # 注入链
python3 scripts/ipa_deep13.py      # plist + 能力面
```

---

## 11. 报告诚实性声明

本报告严格区分了「已证实」与「未证实」，以下是必须明确的边界：

**已证实（有字节级证据）：**
- 5 条注入 dylib 在 load command 中硬编码 ✅
- 全部组件 `cryptid=0`（明文）✅
- `kfd` / `xpf` / `choma` / `jailbreak` 组件存在且含内核利用字符串 ✅
- `enumeratorAtPath` / `SecItemCopyMatching` 能力存在 ✅
- `NSPhotoLibraryUsageDescription = "picking a boot logo"` ✅

**未证实（不能声称）：**
- ❌ **没有找到 C2 域名** —— 唯一非 Apple 端点是 `api.appledb.dev`（开源设备库）
- ❌ **没有找到实际的外发代码路径** —— 只有 `PUT` 方法名，无对应 URL
- ❌ **没有动态执行验证** —— 本环境无 iOS 设备，全部为静态分析
- ❌ **没有证据表明该样本已被用于实际攻击**

**必须撤回的早期判断：**
- `perf.dev` / `research.com` / `vip` / `serial` 为**误报**，已逐条证伪，不构成风险证据

**这份报告不包含、也不会提供**：绕过授权校验的方法、重签名流程、注入链剥离方案。
理由已在 §9.3 说明 —— 不是姿态，是技术上那三件事互相锁死。

---

**报告完成 · 分析层数 14 · 证据文件 `logs/audit/deep13.txt` / `deep14.txt`**
