# 通用动效样片

先运行 `pnpm build`，再运行 `node examples/general-motion/prepare-samples.mjs`，将正式同源 SDK 复制到各工程。缺少构建时会明确报错；没有替代 SDK。

四个工程均为本仓库独立创作，以 MIT 许可提供；没有使用 Overlay Studio 的代码、模板或素材。场景保持可自由编写的 HTML/SVG，`film.html` 是唯一剪辑事实源。每个场景内嵌 `film-motion` 描述、参数 Schema 和默认值，可作为可编辑构件保存，也可以继续由智能体修改场景代码。

| 工程 | 时长 | 内容与可编辑项 |
| --- | --- | --- |
| `product-demo` | 24 秒 | 无旁白、无字幕的虚构产品演示。原创界面、局部镜头、路径指示、标注、卡片分组、合成音乐；标题、强调色、镜头缩放可编辑。 |
| `data-story` | 24 秒 | 三组结构化季度数据、折线描画、数字增长、注释和分组布局。数据、配色和揭示进度可编辑。 |
| `optional-caption` | 24 秒 | 自有文本事件、图示、背景粒子及合成节奏。字幕可关闭；工程无需 SRT，也不依赖 TTS 或外部媒体。 |
| `alpha-title` | 6 秒 | 透明背景的标题、路径与标记；适用于 WebM 或 ProRes 4444 MOV 合成。MP4 不具有 alpha。 |

所有工程支持横屏、竖屏和方形布局。每个 `frame(t, context)` 根据绝对时间直接求值，不依赖前一帧。标题等文本使用系统无衬线字体，不分发字体文件；跨平台验收机器需有可显示中文的系统字体。不同系统字体的像素不同，乱序求帧比较只在同一运行环境内进行。

`make-audio.mjs` 以确定性正弦、包络和种子噪声生成两份原创 PCM WAV；运行 `node examples/general-motion/make-audio.mjs` 可复现仓库内的声音文件。声音不是人声，也未冒充口播。节拍为 120 BPM；关键变化在同一秒级时钟中对齐。

验收输出保存在仓库忽略的 `.verification/motion-*`。真实成片、编码、帧数和跨平台环境的证据见根目录 `MOTION-VERIFICATION.md`，源码存在不代表运行验收通过。
