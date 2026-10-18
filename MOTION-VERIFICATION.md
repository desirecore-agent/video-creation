# 通用动效验收

本记录仅对应本轮通用动效扩展，不覆盖或重标记首版应用的 `VERIFICATION.md`。

## 功能基线的固定验收结果

应用功能及验收器基线源码为 `fa11bd5f2f3ee4674bb3f4cb4ff0f09cadbf9831`，源码归档 SHA-256 为 `60c095f30806aa8c69fff840f4a35f4174d460ae5056246cb02b878aec8fda14`。最终导演内容为 `4bf2494092f9e088e5240fc14ad7aca95f95efd4`，归档 SHA-256 为 `c4db7ce88332550cc13c1223463cd12dcd735b2a656f511a472ed13b94f1854e`。随后补齐 SDK 独立分发的许可全文，字节与新验收另行记录，不改写本节运行身份。

应用固定材料为 `f8923fd8d597186bdd4f94b4628e792e4e5c92d8d301901a9b9d56de2cded45b`，192 文件／9,179,706 字节；仓库外仅安装 7 个生产依赖，全文件哈希与完整 Schema 格式校验通过。三平台分别从准确新归档安装并构建，离线 SDK SHA-256 一致为 `35d97c111ff86e8fa4c7d90afeb18a6cafb7a463264661ccb14f66540536f67d`。

| 环境 | 实际版本 | 正式结果与边界 |
| --- | --- | --- |
| macOS arm64 | Darwin 25.6.0、Node 25.6.1、Chromium 149.0.7827.55、FFmpeg 6.0 | 新归档完整短验收 8／8；完整成片另见下表。真实浏览器编辑器宽窄窗／明暗／参数／关键帧／数据／锁的操作证据以其原始 dirty 源码及逐文件哈希保存。 |
| Windows 11 Pro x64 实机 | 10.0.26300、Node 24.18.0、Chromium 149.0.7827.55、固定 FFmpeg 6.1.1 | 完整短验收 8／8，正式 5 文件 runtime 6／6，最终 Agent 14／14，正式包装器两条领域检查通过。headless／服务／CLI／HTTP／MCP／媒体，未冒称可见桌面 GUI。 |
| Linux arm64 容器 | LinuxKit 7.0.14、Node 22.23.3、Chromium Headless 149.0.7827.0、FFmpeg 5.1.9 | 完整短验收 8／8，最终 Agent 14／14及正式包装器通过。2 CPU／2 GiB／256 MiB shm、WenQuanYi、SwiftShader 软件渲染；runtime 6 项另保留原 6d 源码执行身份，未重复贴为本轮。 |

三平台的 12／30fps 真实 2 秒 H.264＋AAC 分别为 24／60 帧。本次各自从 DOM 采集的 ROI 为 `(19.1875,156.234375,4,9.5625)`，真实解码的持续 2×2 绿色块分别在第 12／30 帧首次出现，由第 13／31 帧确认；返回首次帧，不把确认帧充作视觉时刻。各自的实际 PCM 能量峰均为 1.008 秒，音画差 8ms。VP9 WebM／ProRes 4444 实际解码 alpha 均覆盖 0..255，异色底合成通过。

八组还覆盖四场景乱序重复求帧、首帧参数、结构化数据、人工覆盖／锁冲突、横竖方文字与主体边界、可选字幕、Saved 闭包、真实 MCP 和 SDK 安装／取用，以及取消、精确中断、重启后记录保留及新 revision 的显式重试。普通服务均 EOF 正常关闭 0，自有应用／浏览器／FFmpeg 进程及端口归零；Linux 本轮容器也正常退出 0、无 OOM。刻意中断只用于测试本次拥有的进程树。

本机原始记录分别在 `.verification/general-motion/macos-fa11bd5/`、`windows-fa11bd5/`、`linux-fa11bd5/`；均包含真实新任务、ROI 像素、编码／帧数／媒体 SHA-256 与清理证明。Mac `acceptance.json` SHA-256 为 `be5e76a8e940c613ed688b634af5472211c46f9ec9153ecd2f1fb54f5b26e75c`；Windows 50 文件 manifest 为 `bf8a5d9626d86ededeb8ba9d7615eefd2d602411236593ea61d91e8aa0273fc4`；Linux 47 文件 manifest 为 `28733e670092cf8f50821307d689b6c44738884bd77fe29fe1b142de205a314b`。媒体留在本机忽略目录，不经 Actions artifact 分发。

准确 fa11bd5 的 [core CI](https://github.com/desirecore-agent/video-creation/actions/runs/39117059744) 与 [Linux x64 实际 runtime CI](https://github.com/desirecore-agent/video-creation/actions/runs/39117059747) 成功；最终合并仍检查 PR 最新 head、实际 base 及全部门禁，不能用本段旧运行替代。

### 完整成片

四支完整视频由准确 `dea3ad7bce3833352c9a9be2413b5fdaabac0397` 归档和同一 `f892` 运行材料实际导出；fa11bd5 只修验收器，运行文件逐字节未变，因此保留其原来源，不重标。全部 1920×1080／30fps；三支 MP4 为 H.264 High／BT709，MOV 为 ProRes 4444／yuva444p12le。

| 成片 | 时长 | 帧数 | 文件 SHA-256 |
| --- | --- | --- | --- |
| 无旁白产品演示.mp4 | 24 秒 | 720 | `cd57dcbe8dd05639cc178c5a00e1b76ef9f3acdfa6223a27e94fced6a0875793` |
| 数据解释.mp4 | 24 秒 | 720 | `be4b1ae39953386d67b2e7337a7da9041924d78c74369bb5070355e4e77169f1` |
| 知识图示-字幕可选.mp4 | 24 秒 | 720 | `c7372be4eb211aa44b8361164407fbdb345093cdd45ec75d3e569028b80ac65a` |
| 透明标题层-ProRes4444.mov | 6 秒 | 180 | `ae9f836653649d6d59ab2f2e676843f5afb158f2c7bf6b035ceb0067333e0441` |

四文件都经过全片解码与 0／6／14／22 秒等实际关键帧复核；两份完整音轨各 576,000 个 24kHz PCM 样本、24 秒，非静音。透明 MOV 第 3 秒 alpha 0..255，洋红底角落 `(255,0,254)`。主任务也实际目视三支 MP4 的 14 秒解码帧与透明合成图，未用源 HTML 截图冒充实际成片。

交付副本在 `.verification/general-motion/macos-dea3ad7/showcase/`，友好文件名的复制哈希与原任务一致；同目录 `index.html` 提供播放与原文件下载。`delivery.json` SHA-256 为 `bd3eaee21bee7bf86960bf32f1cb1b8573e29fd0b34d276f03ae0804db79994c`，`acceptance.json` 为 `91428e81b4dd7e2cce67f4de5f2a6cf524859fe597886471180b6ac0e9500031`；正常清理证明保留原标签。

## 原创样片

- `examples/general-motion/product-demo`：24 秒，无字幕、无旁白。原创界面 SVG、镜头缩放、路径引导、卡片组合及确定性合成音乐。
- `examples/general-motion/data-story`：24 秒，三组结构化演示数据、SVG 折线、增长数字、注释；数据不代表真实业务指标。
- `examples/general-motion/optional-caption`：24 秒，流程图示、Canvas 粒子、文本事件和合成节奏；关闭字幕仍能独立表达，不要求 SRT 或 TTS。
- `examples/general-motion/alpha-title`：6 秒透明标题层；仅以 WebM 或 ProRes 4444 MOV 验证 alpha，不宣称 MP4 透明。

场景、SVG 和声音均由本仓库独立创作，按 MIT 提供；没有复制 Overlay Studio 的代码、模板或素材。`make-audio.mjs` 可复现 PCM 声音。只使用操作系统可用字体，不分发字体。

## 可复现入口

先构建应用，再准备可直接打开的样片：

```sh
pnpm build
node examples/general-motion/prepare-samples.mjs
node --test --test-concurrency=1 desirecore/general-motion-smoke.test.mjs
node desirecore/general-motion-smoke.mjs --workdir <全新绝对目录> --evidence <绝对JSON路径>
```

`--showcase` 额外逐个生成三个 1080p30 完整 MP4 和一个 1080p30 ProRes 4444 MOV。所有真实导出默认单浏览器，样片和应用数据使用本轮独立目录；harness 从未访问平台身份或模型，也不上传素材。

有界实跑覆盖：四个场景乱序和重复求帧的像素差异；参数首帧生效；真实 revision、结构化数据、人工 DOM override 与动效锁；横、竖、方实际 stage 布局；关闭可选字幕；Saved 复制后的独立资源闭包；真实 MCP 标准输入输出；12 与 30 fps 导出、实际解码声音的节拍偏差；WebM／ProRes alpha 解码和异色背景合成；精确取消、进程中断、重启后保留记录与显式重试。显式重试重新冻结当前输入，未声称断点续渲。

## 诊断与修复历史

2026-10-18 的 macOS ARM64 诊断已完成默认有界实跑：Darwin 25.6.0、Node 25.6.1、Chromium 149.0.7827.55、FFmpeg 6.0。源码基线为 `c0d83af1b6443f8aad13ade6adf510f8d6536e1d`，工作区包含本轮未提交修改，因此本次只作为实现诊断，不能替代最终准确提交的跨平台验收。

原始记录 `.verification/motion-macos-diagnostic-f.json`，SHA-256 为 `e08f2b2c56962e21af2ee8c64d90edf11113eb9fe41d11fe612883d7245669af`，含运行源码及 SDK 哈希和全部任务回执。八组检查均通过；四场景乱序求帧的像素差异均为零。12／30 fps 的两秒真实 MP4 分别有 24／60 帧，首次视觉节拍都在 1 秒，解码 PCM 能量峰在 1.008 秒，相差 8 毫秒。VP9 WebM 和 ProRes 4444 MOV 解码 alpha 均覆盖 0 到 255，异色背景合成通过。取消、中断、重启后的记录保留及新 revision 的显式重试通过；最终服务经标准输入 EOF 调用正式生命周期关闭，退出码 0、无终止信号。

上述 f 记录只通过当时的技术断言。后续人工目视发现小画幅的固定最小字号、图标和内边距导致遮挡；原来的画幅检查仅证明 viewport 尺寸，不能证明可读。因此 f 不作为样片视觉验收通过的依据。

随后重排四个场景：页眉、主体、脚注及字幕使用各自的网格空间；横屏、竖屏和方形按比例安排卡片与流程节点；图表轴标签按实际 SVG 显示比例保持至少 8 像素，注释保留完整可读内容。`.verification/motion-layout-20261018-c` 保存 40 张真实 FilmPage 代表帧及矩形数据：三个 24 秒场景分别在 6／14／22 秒，透明层在 2 秒，覆盖 320×180、180×320、240×240 和 1920×1080。另有三画幅的人工标题／字距／数据修改检查。四场景的新布局乱序求帧像素差异仍为零。

这些代表帧均经过人工目视。正式 harness 已增加文字边界、实际字号、文字互遮、主区域互遮、主体越界及覆盖无关主体的断言；SVG 字号按最终画面像素计算，正常的文字与自身容器包含不算遮挡。六项定向测试通过，新增回归拒绝小字、越界和遮挡的伪通过。该目录的 `manifest.json` 记录本次源码／SDK 哈希；仍属于未提交源码上的定向布局诊断，新布局的完整运行及跨平台结果须在最终冻结提交后补齐。

诊断暴露并修复了知识片的浏览器历史栅格差异：节点在半透明／缩放期间改变合成层，Canvas 也会切换绘制后端。样片显式固定三个节点的合成层和小粒子层的 CPU 栅格后，`[14, 0.1, 23, 14]` 的差异降为零；没有放宽验收阈值。基线、单项对照、修复后的首帧／重复帧／差异图保存在 `.verification/motion-optional-diagnostic-20261018`。这是样片的明确绘制选择，未将任意自由场景强制改成 CPU 渲染。

验收包装还修复了两个 harness 问题：override 字段改用正式合同要求的 `letterSpacing`；服务启动包装改为独立 `.mjs` 入口，避免 `--eval` 参数被渲染 worker 的 `fork` 继承。定向回归以真实子进程验证 EOF 正常关闭、HTTP 端口释放、退出码 0，并确认被 fork 的子进程没有额外 Node 执行参数。旧诊断失败记录保留，未重新标记成功。

准确候选 `6d9a3731650afb836ebe6591f264424b4d64bd4b` 的 macOS 归档验收通过前五组后，实际 H.264 的首节拍条检测失败：小画幅的条宽仅 2.08 像素，色度采样将中心像素的绿红差压到 21，未达到原阈值 35。失败记录保存在 `.verification/general-motion/macos-6d9a373`，未开始完整样片导出，也未重标成功。随后只将产品片节拍条的最小宽度改为 4 像素，检测策略、阈值、时间与声音均保持不变。独立 QA 副本的两秒 12／30 fps 实际 H.264 首显帧分别为 12／30，解码像素绿红差为 59／68；PCM 能量峰均在 1.008 秒，误差 8 毫秒。320×180、180×320、240×240 的文字／主体矩形检查和目视均通过，服务正常关闭。修复的定向证据在 `.verification/general-motion/beat-width-repair-a/evidence.json`，仍须以新冻结候选重跑三个平台的完整验收。

以上为早期诊断时的状态；最终三平台结果和完整成片见首节。所有历史失败、源码身份和原始文件哈希继续保留。

Linux 仅能按实际运行环境记录，容器无桌面或独立 GPU 时不得称作桌面实机验收。未覆盖付费媒体、三维角色动画、影视跟踪或签名安装包。

### 编码后音画探针的区域修正

`dea3ad7` 的 macOS 完整九组与 Windows 八组通过；Linux ARM64 的 30fps 中心像素在第30、31帧恰为35色差，严格单点判断直到第32帧才成立，导致整体验收仍失败。实际解码在第30帧已于真实标记边界内出现完整2×2绿色块，第31帧持续；不是影片事件晚了两帧。该失败与原媒体留在 `.verification/general-motion/linux-dea3ad7/`，未覆盖或改标。

验收器现在采集本次DOM的 `beatRect`，仅在该边界内查找完整2×2绿色像素块并要求连续两帧，返回最初显现帧。每像素 `G-R > 35`、`G > 110` 和最终音画差不超过一帧均保持原值；没有按照预设标记时间伪造视觉时间。新增单点、分散点、区域外或跨界绿色、单帧噪声、阈值临界、截断与无效区域负例，10项定向测量回归通过。

对保留的六份12／30fps媒体做只读区域诊断，分别检出第12／30帧、由第13／31帧确认，与1.008秒声音峰相差8ms。该诊断统一使用Linux已采集的真实区域，不冒称重新采集旧Mac／Windows的DOM。正式三平台重验将各自从新归档采集实际区域。此修正只涉及验收器，正式运行材料仍为 `f8923fd8d597186bdd4f94b4628e792e4e5c92d8d301901a9b9d56de2cded45b`，四个完整视频的运行字节没有变化。

## SDK 单文件许可补齐

复核发现工程单独复制旧 SDK 时，完整第三方许可只在应用材料中；现将根许可与实际打包的五项依赖许可原文附在模块内。实际依赖为 Ajv、ajv-formats、fast-deep-equal、json-schema-traverse（MIT）及 fast-uri（BSD-3-Clause），不把构建工具或未进入输出的包计入分发。构建按 esbuild 实际输出核验依赖身份、许可正文大小与 SHA-256；缺失、身份变化或无法原样嵌入的原文均显式失败。

新 SDK 为 323,726 字节，SHA-256 `880d3640c30d689833623166b2659a2d6f5ed31c5a2b5b1128d1b349da0c3f8d`。两人独立用 esbuild 解析新旧模块并移除注释，可执行代码完全相同，SHA-256 均为 `f733e0cd564a84c12e2d7dcedaeba8e44096d7798ed4c22e3b4c752499ea6b1e`；未用正则删除代码。SDK 构建、真实工程安装及 Saved／快照原字节携带的定向检查通过，动效关联检查 66／66、包级 typecheck 与完整 UI 构建通过。

新固定分发材料为 `8368f4421466e44475c0e92c43f0fc6a05c4b809ed5e72e5742ab8801ea007d5`，192 文件／9,217,686 字节。其新增注释后的三平台实跑结果见下；上面的旧源码验收保持原 SDK 字节身份。既有四支完整成片保留原材料标签，可执行代码相同也不改变其实际来源。

## 真实导演自主创作与人工续改

独立 macOS arm64 standalone 使用正式 ZIP 导入的导演、既有 `desirecore-cloud/mimo-v2.6-pro` 与默认 AI 审批，实际生成非预设的“磁场折纸”场景：四点路径、连接强度、可编辑标题／强调色／速度与事件。无口播、无 SRT，也未由验收者代写场景。初稿标签在第 1 秒遮挡副标题，真实帧反馈后由模型 Read／Edit 局部修复。应用使用 dea3ad7／f892，原创和布局修复使用 Agent305b627，正式更新4bf2494后完成参数续改；不冒称使用新许可字节。

通过正式 HTTP 模拟人工修改标题、锁住 `params.title` 并添加标题颜色／字距 DOM 覆盖；不是人工 UI 点击。真实锁定字段修改返回409且工程不变。随后模型只将未锁定强调色改为 `#fb7185`，独立比较完整 FilmValue 证明标题、锁、DOM 覆盖和场景源码均保留。最终 revision `1ca3f285b9a53769`，场景8802字节／SHA-256 `51788b016c05ab505301f3a3534f4fa310ac99637694e49aa8f133a3c3dbc6d1`。

最终任务 `e436cf7cfc0b` 已完成：6秒、320×180、12fps、72帧、H.264、无音轨，视频 SHA-256 `05fa752ec0b1c65f858e4f59107c0448de972541a506ff4a23702a3a3d2ba0fa`。实际解码1／3／5.5秒帧经目视；23时点边界、事件出现与倒回清除、首帧参数和覆盖检查通过。同帧额外 PNG 字节断言曾失败，仅4像素单通道差1；原像素差阈值下 meanAbsolute=6.430041152263375e-7、changedRatio=0，未宣称 PNG 字节相同。

原工具误用、Schema拒绝、入口软链失败、布局失败和有界取消历史继续保留。清理后自有应用／standalone进程与四个端口均关闭，令牌删除；没有更改平台生产身份或新增模型供应商。闭集来源与回执位于 `.verification/general-motion/director-305b627/`，原始归档 SHA-256 `a443ef57985e0601f0e6bff67f2fd7e7b34409135383740f3ffa5127d3fd061b`。

## 实际成片播放

交付播放页通过本机只读预览打开，真实 Chromium 分别播放三支24秒MP4；1920×1080、时长24秒、播放时间和解码帧数均前进、无媒体错误。测试使用静音基本播放，没有声称完成听感复核或随机 seek；透明 MOV 仍以实际 FFmpeg 解码／异色底合成为依据。原始播放记录 `.verification/general-motion/showcase-browser-playback.log` SHA-256 `e8c32ef6bd50ddc11ab8a147ed3ce3986d6c1093426b0cdcf49d65ad4c397d5d`。临时浏览器会话、只读服务器与端口均已关闭。

### a34 完整许可候选的三平台实跑

准确源码 `a34ac3e4c938e345e11496385e96f463e8c333cf`，归档 SHA-256 `8235e333dd10ec17de26327a8bb057abf9d915e39301df4bd34b85ebf2e52799`。三个环境分别新建源码、QA目录与任务，从冻结归档安装构建，未复用旧媒体冒称新运行。环境版本与前述平台表一致。每个平台的完整短验收八组全部通过，实际重新采集 DOM ROI；12／30fps 首显12／30帧、确认13／31帧，PCM峰1.008秒、音画差8ms。VP9／ProRes实际透明解码、Saved／MCP、取消、中断保留及显式新重试均通过。

Mac／Linux各直接核对9份本次SDK复制件，Windows直接核对4份本次实际构建／工程／MCP／Saved复制件，全部323,726字节／`880d3640…c3f8d`；根MIT与实际五项依赖的许可逐份全文字节匹配，含 fast-uri 完整1813字节BSD-3-Clause原文。Windows／Linux最终4bf包装器实际 inspect／motion-inspect 两项通过；未把先前14项或runtime6项重贴为本轮重跑。

| 本轮记录 | 内容与摘要 |
| --- | --- |
| `macos-a34ac3e/acceptance.json` | SHA-256 `a3003e333ef200fa53cdfcaca1fcabbf6787870b206a5636926148bf94f47764`；许可、summary、清理各有独立原始JSON。 |
| `windows-a34ac3e/evidence-manifest.json` | 59文件，SHA-256 `eb8a6148882d3e22e4ef22ad2b0ab74148d136b8f377418059528ef145e81265`。 |
| `linux-a34ac3e/evidence-manifest.json` | 51文件，SHA-256 `6660a72709feb3bff1ff048e745778306e703a9b6741829cf484d932d4abbf27`。 |

以上路径均相对 `.verification/general-motion/`，媒体、实际probe／ROI像素、SDK原件／全文核验、任务与清理记录一并留存。普通服务EOF退出0、自有进程和端口归零；Linux容器正常退出0／Pid0／非OOM。旧失败及四支长片的原始来源标签保持不变。

准确 a34 的 [core CI](https://github.com/desirecore-agent/video-creation/actions/runs/39120207062) 与 [Linux x64实际runtime CI](https://github.com/desirecore-agent/video-creation/actions/runs/39120207057) 均成功。材料C仅装7生产依赖，192文件／9,217,686字节、完整现行平台Schema及规范摘要独立通过；审计报告 `sdk-license/material-c-8368f442-audit.json` SHA-256 `6e3140bf10f0efb8c59aefed72a0d521e41e42d74e687c482597b06bf5596684`。

### 样片辅助入口窄修与分发差异

收尾发现 `prepare-samples.mjs` 的命令行入口以字面URL比较路径，经目录软链运行可能退出0却不复制。提交 `7db9f703ea61dfdea7a2aff524a14d209673693c` 仅将入口判断改为对称真实路径，并保持stdin／普通import无写入；`prepareSamples` 函数正文原字节保留。Mac真实子进程先复现旧版静默失败，再验证新目录软链、保留主软链、stdin无副作用与缺SDK明确失败，四份复制SDK均为新880d原字节。双语README同时纠正样片根 `motion.mjs` 与新工程安装路径的区别。

最终材料D为 `bf787d53209c47b1798b4a43082b333fc7b9f191e7670df1317de3497fa229ab`，192文件／9,218,015字节。与C逐文件对比，只有 `examples/general-motion/prepare-samples.mjs` 增加329字节，其余191文件，包括UI、SDK、参数协议、求帧与导出实现，完全一致。定向入口检查归 `sample-helper-entry/`；a34的三平台主验收保持其真实来源，未重贴为辅助入口或最终文档提交。材料D的完整现行Schema、规范摘要和全部文件由独立审查再次验证，审计报告 `sdk-license/material-d-bf787d53-audit.json` SHA-256 `52648dd60a12bd830fc28473cd2d0c3e7a9ed3820863a07603ac256e89ba04c4`。

Windows在全新小夹具使用真实目录junction，Linux在无网络短容器中使用目录软链，分别执行相同四场景：正常软链与保留主入口软链均退出0并复制4份准确880d SDK，stdin导入无输出／无写入，缺SDK明确退出1且不复制。均核对新入口1508字节／SHA-256 `ec3f17bf3606062b5d33f9d372c967bafc34a22a98a80a89112ffeb73818111e` 及函数正文未变；没有安装依赖、启动服务或重渲染。Windows记录在 `sample-helper-entry/windows/`，Linux11文件manifest SHA-256 `7cc0442a115b415a35af05a01a005888e1ddeec0bf51a1bb84e8dc8bbd82d7d4`；自有子进程结束，Linux容器自然退出0／Pid0／非OOM。

### 导演工程交付副本

原导演QA归档保持只读；另制作 `director-delivery/magnetic-fold-project.zip`，73,796字节，SHA-256 `69ad75d28f30cc0dbdbefa383fd6481554b3e9e3a8ef9011826c73b7ca4d965f`。ZIP包含实际film、原创场景、操作文件和本地SDK；场景／film／两操作文件逐字节保留人工锁与覆盖，只把SDK替换为补齐许可的880d版本，并在工程内README／PROVENANCE明确这是交付包装。没有重新调用模型、改写场景或渲染影片。

同目录 `magnetic-fold.mp4` 是原05fa752…影片的原字节副本。ZIP CRC、相对路径及逐文件读回通过，独立复核确认无隐藏或软链项；`FILE-MANIFEST.json` SHA-256 `306787e19531ff6cb98655e413c283180aff7d0b62d1c0eb7419595db35a64f8`。用户解压后可直接使用film.html工程，不必从运行诊断数据中整理作品。
