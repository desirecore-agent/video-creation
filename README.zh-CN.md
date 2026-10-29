<p align="center"><img src="docs/video-creation.svg" alt="视频创作" height="72"></p>

# 视频创作

「视频创作」是 DesireCore 的视频编辑应用，关联独立智能体「视频导演」。用户在时间线中调整镜头、字幕与素材，智能体通过文件和工具操作同一个影片项目。

本仓库直接克隆 [OpenFilm](https://github.com/openfilm/openfilm)，保留其 Git 历史，复用影片格式、Studio 编辑器、本地预览、素材处理、检查与渲染内核。它是独立改版；不代表 OpenFilm 官方。上游来源、复用边界及许可见 [UPSTREAM.md](UPSTREAM.md)。

- 应用仓库：[desirecore-agent/video-creation](https://github.com/desirecore-agent/video-creation)
- 智能体仓库：[desirecore-agent/video-director](https://github.com/desirecore-agent/video-director)
- 应用安装描述：[desirecore/app-release.json](desirecore/app-release.json)
- 英文说明：[README.md](README.md)

## 开发与运行

需要 Node.js 22.18+、pnpm 9、Git 与 PATH 中的 FFmpeg/FFprobe。首次检查、预览或导出还需要 Playwright 的 Chromium；可显式安装后离线使用。

```sh
git clone git@github.com:desirecore-agent/video-creation.git
cd video-creation
pnpm install --frozen-lockfile
pnpm build
node desirecore/cli.mjs setup-runtime --home .dev/video-creation
node desirecore/cli.mjs start --home .dev/video-creation --project examples/first-film
```

应用正式入口是 `node desirecore/cli.mjs`。`start` 启动编辑器；`inspect` 读取项目和版本；`patch` 按版本提交编辑；`check` 检查画面；`review` 生成带准确来源、时间点和图片摘要的审片材料；`render` 创建渲染任务；`jobs`、`retry`、`cancel` 管理渲染；`mcp --project <目录>` 提供视频导演的工具接口。用 `--help` 查看实际参数。媒体生成服务仍需用户配置，收费服务应先获得具体操作授权。

```sh
pnpm dev        # 构建并启动示例，使用独立 .dev/video-creation 数据
pnpm build      # 构建编辑器、离线动效 SDK 与样片依赖
pnpm typecheck  # 只检查应用内核的服务端和编辑器
pnpm test       # 定向适配器、服务、发布、品牌、格式与编辑检查
pnpm test:motion          # 动效协议、编辑、依赖闭包与测量回归
pnpm test:motion:runtime  # 实际 Chromium 求帧与本地 SDK 集成
```

`packages/openfilm` 保留上游路径，技术包名是 `@desirecore-agent/video-creation`，兼容 CLI 命令名是 `video-creation`。源码中的 `bin/openfilm.mjs`、`window.openfilmHost`、`film.html`、`.film/` 与 `OPENFILM_*` 环境变量作为格式/源码兼容接口保留。独立数据根默认是 `~/.video-creation`，也可由 DesireCore 分别为正式和预览实例指定。新影片库、收藏和导出分别默认放在该根目录的 `projects/`、`saved/`、`exports/`，保留用户显式选择的外部目录；项目可放在 `projects/` 内，密钥、设置、任务状态和运行时目录不能作为项目。

应用通过 DesireCore 安装与更新；源码版更新本仓库后重新构建。CLI 和服务均不查询或执行上游 npm 自更新，也不引导下载上游独立桌面版。`apps/desktop` 和 `packages/shared` 保留作来源参考，排除在默认工作区、构建及测试之外。

## 界面与主题

在支持外观同步的 DesireCore 原生窗口中，编辑器随宿主切换明暗，字体、表面与控件沿用宿主风格，设置中显示“跟随 DesireCore”。独立浏览器仍可选择浅色、深色或跟随系统；宿主的临时覆盖不会改写已保存的浏览器偏好。未提供外观同步的旧版宿主继续使用本地偏好。

主题切换只影响编辑器界面，不改写影片或场景的 HTML/CSS，不改变作品配色或导出画面。实际运行验证范围见[固定验收记录](VERIFICATION.md)。

## 通用动效

无需口播或 SRT 即可制作产品演示、数据解释、图文动画和透明标题。[四个原创样片](examples/general-motion/README.md)包含横屏、竖屏和方形布局、结构化数据、路径、镜头变换与原创合成音乐。构建会把同一份离线 SDK 放入各样片根目录的 `motion.mjs`；新工程通过 `motion-install` 安装到 `video-creation-motion/motion.mjs`，无需 CDN。

素材区的动效库可发现内置构件及当前工程场景，收藏并插入现有时间线。选中带 `film-motion` 描述的场景后，可调整 Schema 定义的参数与数据，编辑属性关键帧、缓动曲线、轨道局部循环与时间映射、标记以及字段锁定。锁定和人工 overrides 随原工程保存；智能体修改必须携带真实版本，冲突会明确返回。

视频导演可选择构件、组合构件，或自主编写新的 HTML/SVG/Canvas 场景。旧 `frame(t)` 场景继续工作；新场景可使用 `frame(t, context)`，在绘制前接收完整参数、数据、画布尺寸和当前事件。电影时间线、Saved 依赖闭包和导出队列仍为现有实现。

CLI 提供 `motion-catalog`、`motion-inspect`、`motion-install`、`motion-take`、`motion-patch`；MCP 对应 `video_motion_*` 工具。取用构件先生成 Saved 条目，再由智能体决定插入位置。导出工具支持帧率、尺寸、画幅、范围、运动模糊、透明 VP9 WebM 与 ProRes 4444 MOV 等现有编码选项。MP4 不支持透明通道。字段与示例见[格式规范](packages/openfilm/SPEC.md)、[创作手册](packages/openfilm/MANUAL.md)和[运行工具契约](desirecore/RUNTIME.md)。

真实验收使用 `node desirecore/general-motion-smoke.mjs --workdir <全新目录> --evidence <记录路径> --label <环境>`；需已安装 Chromium，并使 FFmpeg/FFprobe 位于 PATH。`--showcase` 额外输出完整 1080p 样片。源码、环境、实际通过项与未覆盖边界统一记录在 [MOTION-VERIFICATION.md](MOTION-VERIFICATION.md)。

## 项目文件

影片是普通文件夹：`film.html` 描述轨道与片段，镜头页面实现 `window.film.frame(t)`，`assets/` 保存素材，`.film/` 保存历史与派生数据。可直接打开兼容的 OpenFilm 项目。修改前读取当前版本；尊重人工 overrides 与锁定轨道；合并冲突需要明确处理。

[格式规范](packages/openfilm/SPEC.md)与[创作手册](packages/openfilm/MANUAL.md)保留上游格式契约。直接读取原始手册时，请把其中的 `npx openfilm` 换成本仓库的兼容 CLI，或优先使用 `desirecore/cli.mjs`；通过兼容 CLI 打印的手册会显示本应用命令。

## 许可与边界

保留 [MIT 许可证](LICENSE)、[商标政策原文](TRADEMARK.md)和[第三方声明](packages/openfilm/THIRD_PARTY_NOTICES.md)。本改版使用原创图标与独立名称。运行时依赖的 FFmpeg、Chromium、字体及其他第三方组件，按实际分发内容处理各自许可证；本仓库不打包或发布原上游独立桌面安装器。

通用动效层与上述样片在现有 MIT 内核上独立实现；Overlay Studio 仅为设计参考，其代码、模板、技能与素材未纳入本仓库。Schema 校验使用随应用打包的 Ajv 与 ajv-formats，完整依赖许可保存在 `desirecore/licenses/`。离线 SDK 本身也嵌入根许可与实际五项依赖的完整 MIT／BSD 原文，单独保存或复制工程时一并携带。

完整影片格式和编辑能力来自上游；DesireCore 集成的实际验证范围见提交与 PR 中的验证记录。付费媒体服务、安装版宿主兼容性及每个平台的最终发行包需要各自的运行验证。

`render --output` 指定输出目录；`--wait` 等待实际完成。首版真实运行范围和边界见 [固定验收记录](VERIFICATION.md)。

## 工程同步、导出明细与MiMo旁白

重命名已打开的工程会同步名称、目录及文件监听，保留当前编辑和导演草稿；已准备的旧目录提案需要重新准备。导出托盘明确标注全部交付的总大小，并可展开视频、字幕等每项文件的准确字节；API回执的bytes仍为总计，outputSizes为逐项大小。

媒体能力新增MiMo预置语音，支持明确选择音色与演绎风格；正式CLI通过get调用现有媒体服务。密钥由应用Providers或运行环境配置，不能放入工程和导出包。普通API与Token Plan端点、凭据使用范围分别按官方规则配置，不自动切换端点或重试未知付费请求。MiMo不返回词级时间戳，字幕须按生成后的真实音轨对齐。调用合同见[运行工具契约](desirecore/RUNTIME.md)。

## 带版本和时间点的真实审片

`review`／MCP `video_review` 明确区分当前工程预览与已完成的视频导出。导演自由选择观察点，不规定叙事、构件或修订路线。读取 `jobs` 返回的真实 `done` 视频任务 ID 后，例如：

```sh
node desirecore/cli.mjs review <项目> --source export-job --job <任务ID> --times 0,2.5 --last --max-edge 1280 --home <应用数据根>
node desirecore/cli.mjs review <项目> --source current-project --times 1,3 --last --home <应用数据根>
```

回执包含 `reviewId`、`sourceKind`、原始 `filmRevision` 与每帧 `requestedTime`、`actualTime`、尺寸、独立 PNG 路径、准确字节和 SHA-256。真实视频从该任务的输出复制独立暂存后只解码，不重新渲染工程；旧输出始终归原输入版本，输出摘要明确是本次审片观察值。编码视频的数字时间以首个真实解码视频帧为零点，选择不早于请求时间的第一帧；`actualTime` 为此相对秒数，`actualPTS` 保留原始 PTS，`timeOriginPTS` 记录零点。此工具时间原点不等同于所有播放器时钟，也不提供 range/clip 输出到原 film 的全局映射；`last` 使用真实末帧 PTS。当前工程沿既有静态本地依赖快照求帧，末态为 duration 前 1ms，`actualPTS:null`，不能称为编码末帧。版本或已知来源在观察期间变化会明确失败。

生成材料的 `observation: generated-not-viewed` 不是导演已看图。导演应再使用平台现有 `Read(path, expected_sha256)` 读取必要 PNG，将实际画面与准确版本、时间点一起作为修订依据；图像进入请求也不等于模型理解。读取帧会核对原字节和摘要，丢失或篡改不会以其他图片代替。审片不改影片、人工 overrides 或锁；修订仍走现有版本化编辑。

每次最多六个 timed 帧和一个独立组合制品；每图最多 4 MiB、两类合计 12 MiB。正式关闭服务会停止接收观察、结束并等待本实例审片资源及等待队列清理，不在后台暗中继续。完整暂存视频与工程输入在成功或失败后清理，只有帧、请求的组合图和回执留在本应用数据根的 `reviews/<reviewId>/`；没有自动过期或隐式重建。清理精确审片目录后旧引用明确不可用。新导出输入清单逐项记录冻结副本的 SHA-256；历史清单可能只有路径与字节，没有场景/资源的历史摘要；远端或未解析动态依赖、系统字体与浏览器环境不能由本地摘要证明冻结。详细请求和 HTTP 读取合同见 [RUNTIME.md](desirecore/RUNTIME.md)。

工程 `current-project` 审片现在把Studio外置字幕与FilmPage画面合成为同一PNG，使用与导出相同的字幕时钟、样式、语言和语义强调；字幕关闭、没有字幕或当前无活动句分别写进 `studio-subtitle-layer` coverage。`source.subtitles` 绑定本次冻结样式文件、字幕源版本和完整cue投影摘要；旧编码审片仍只解码真实成片，不借当前工程DOM补造测量。

需要按本次用途检查竖向信息区域时，可给 `--safe-top 0.15 --safe-bottom 0.15`，对应同源请求 `informationSafeArea:{top:0.15,bottom:0.15}`，比例之和须小于1。不提供就不预设安全区。`subtitle-information-bounds` 和显式 `data-review-intent` 的essential/supporting场景目标以影片坐标给出包含行盒、描边和保守阴影的完整边界；`subtitle-information-overlap` 仅提示同一采样时刻的框相交。未标注、Canvas/WebGL、复杂变换和未覆盖图层保留unknown，不能把无finding当整体安全或审美通过。测量不自动排版、裁切、改锁或限制原创场景。

## 公开时间线修改合同

无需读取应用材料源码、打开服务或指定工程/home，即可查询本版本支持的全部时间线操作：

```sh
node desirecore/cli.mjs patch --help
node desirecore/cli.mjs patch --schema
```

后者只读输出版本化 Draft-07 操作数组 Schema，与 MCP `video_patch.ops` 同源。已有字段/删除/兼容宽值及最终校验归原内核；公开说明不授予新权限，也不是场景源码 CAS。正常修改先 `inspect`，再把 JSON 数组保存为工程内操作文件并用真实 `--base` 提交。

仅切换已存在片段到导演创建的场景副本时，使用 `[{"op":"set","clip":"真实ID","field":"src","value":"tide-beacon-r2.html"}]`。该操作保留未指定的 `motion`、人工 DOM overrides、锁和 `time`。`inspect` 通常已把 HTML `#t` 分离为 `time`，只换 `src` 时不要重复拼接 `#t`；范围按实际返回值保留。冲突后重读合并，不换新 revision 盲重放。完整机器合同以当前安装版本 `patch --schema` 为准。


## 目标尺寸与可追溯的测量

`node desirecore/cli.mjs review --schema` 可离线读取 `contractVersion:2` 的请求、finding、coverage 与 artifact Draft-07 合同，不读取项目或 home、不启动服务。MCP `video_review` 与原鉴权下的 `GET /api/review-schema` 使用同源合同。首尾及目标宽度示例：

```sh
node desirecore/cli.mjs review <项目> --source export-job --job <任务ID> --first-last --target-width 390 --max-edge 1280 --home <应用数据根>
```

`targetWidth` 为 64–4096，仅从本次核验 PNG 字节缩小，不能放大或突破 `maxEdge`。每帧的 `presentation` 分列原生源尺寸、捕获尺寸、目标实际尺寸、比例和 `limitedBy`；请求 390 不保证得到 390 像素。`firstLast` 补充 0 与 last，未给其他采样时只生成首尾两帧；总 timed 帧仍不得超过六。`artifacts[]` 的一个 `first-last-composite` 从这两帧的固定 buffer 组合，`derivedFrom` 绑定精确 bytes/SHA/实际时间及编码整数时间基；它的 `timeBasis:composite-not-timed-frame` 不是时间线上一帧。`maxEdge` 约束整个组合图，`layout.cells` 另报每格坐标、源/实际尺寸与比例，透明补边不算原画面。

`findings[]` 给出实际采样的 time/source/selector/bounds/measurement/evidence/limitations；`coverage[]` 说明 observed、unknown 或 partial 的范围。工程预览从同一 FilmPage 的求帧窗口测文字 Range、局部裁切和目标宽度下的数量值；CSS 字号与裁切分列，不按固定字号判审美好坏。复杂变换、遮挡、Canvas/WebGL、复杂背景对比度、未测点位或静默不能被冒称“正常”。DOM 与 PNG 是同采样窗口，不是原子像素快照；旧编码任务只解码原输出，不附当前工程 DOM 的选择器或字号结论。`check` 保留原 `{ok,lines,files}` 并添加结构化事实，但其 live-check 没有 review 的版本快照保证。

导演仍应按用途选必要图片，经 `Read(path, expected_sha256)` 实际看图并自主决定修订。首尾、目标小图、技术测量均不证明连续动画、整段音频或整体审美；没有 finding 或未运行检查也不表示通过。所有观察保持影片、人工 DOM/动效字段及锁不变，不自动拦截导出。

## 明确前置条件的场景源码修订

读取当前场景的原字节 SHA-256 和影片版本，再发布独立新版本，只切换明确选定片段的来源：

```sh
node desirecore/cli.mjs scene-read --schema
node desirecore/cli.mjs scene-read <项目> <真实片段ID> --home <应用数据根>
node desirecore/cli.mjs scene-revise <项目> --args <revision.json> --home <应用数据根>
```

`scene-revise --schema` 离线返回同一 Draft-07 合同。JSON 文件包含 `{base,sourcePath,expectedSourceSha256,clipIds,targetPath,content}`；MCP `video_scene_read` / `video_scene_revise` 和原鉴权 project HTTP 使用同一领域 Schema。摘要须用返回的原字节摘要，不能拿影片版本或解码后的 motion 摘要代替。即使影片未变，原源码改变也冲突。选定实例必须共享该实际原源；未选引用及所有非 `src` 字段、人工 overrides、motion 输入、锁和时间均保留。不覆盖已有不同内容，已有同字节普通目标可明确返回 reused。原创 HTML/SVG/Canvas/WebGL 仍受支持；静态兼容与数据保留不证明任意新 JavaScript 仍遵守其画面语义。

原文件读取至多 4 MiB。完整序列化 read 回执不超过 480 KiB 才返回全文，否则明确 `textIncluded:false` 与省略原因，同时保留完整 bytes/SHA 和有限元数据。新 content 实际 UTF-8 至多 256 KiB，领域 JSON 输入至多 768 KiB；通过 JSON 文件传入，避免 OS 单参数尺寸限制。原全局预算保持：HTTP 请求体 4 MiB、MCP 请求行 1 MiB、**内部工具数据 JSON** 512 KiB。二次转义、真实 request id、wrapper 和换行会增大完整 MCP 响应；本功能未新增整 RPC 上限。

完整私有文件先以 no-replace 语义发布，再切换影片；两资源不是文件系统事务或 OS CAS。后续切换失败时保留已发布源码，有限错误 `recovery` 包含其 path/SHA/bytes 及可观察的当前影片版本/映射。CLI 通过 stderr 保留这些字段，409 返回 exit3；MCP 保持 `isError:true`。超时不证明取消，先重读和检查再决定，不盲重试或按推测归属删除已发布路径。旧 `patch` 和一般文件写入不会获得这项新源码前置条件。准确边界见 [RUNTIME.md](desirecore/RUNTIME.md)。

## 时间窗总览与同源多尺寸对照

`review --schema`（v3起）沿同一CLI／MCP／鉴权HTTP公开两个可选观察方式，不修改作品或人工锁：

```sh
node desirecore/cli.mjs review <项目> --source export-job --job <done任务ID> --times 0 --sequence-start 0 --sequence-end 8 --sequence-count 16 --max-edge 1280 --home <数据根>
node desirecore/cli.mjs review <项目> --source current-project --times 5 --compare-widths 180,360,720 --compare-frame 0 --max-edge 1280 --home <数据根>
```

`sequence:{start,end,count}`选择半开窗口，长度0.001–30秒、8–24格。编码窗口最多1800实际帧：低分辨率灰度活动分析覆盖全部所选实际帧，contact格只是按时间选择的少量帧；VFR可以重复引用，真实PTS、整数时间基及每格摘要保留。`temporal.windows`记录活动值、实际覆盖和`peakAdjacentPair`前后帧的整数PTS/时间基；最大差平局取首对，按后帧归请求起点的秒桶，可能跨桶。不评分、不判冻结/节奏合格。工程来源仅离散seek，明确`partial`，不冒充编码全帧或连续播放。

`compareWidths`的2–3个唯一宽度64–4096从同一target缩小前捕获派生，`compareFrame`为本回执timed index，默认0。竖排对照的每格请求／实际尺寸和限制分列，不放大、不假装响应式重排。DOM字号投影按该格实际宽度，复杂映射保持null；encoded没有当前DOM。捕获摘要与已经缩小的公开frame摘要分开。

firstLast、sequence、compareWidths一次只选一种artifact。仍最多6张timed frame加1张artifact、每PNG4MiB／总12MiB；整图maxEdge可能再缩小每格。整图优先保留格子面积、最多留一个透明空格，不能把空格当黑帧。序列标签在独立带显示格号和3位小数实际秒数，尺寸标签为请求>实际px；源像素不被覆盖。极小格会完整简化或省略标签并在metadata标明，不能据此猜时点；完整时间与整数PTS以layout.cells/derivedFrom为准。实际看图使用artifact自身path和SHA。旧请求／v1、v2回执仍可读。窗口、来源或预算不成立明确失败，不偷偷降采样或改作品。自由场景、原源和人工锁保持；这些观察不是美学、字形对比度、音频或所有OS播放的认证。

## 观看意图、同版本定位与修订对照

review --schema v4沿用同一review / video_review入口，支持片段attrs.data-review-intent中的可选信息角色、目标宽度和说明。标注不驱动自动排版，原人工参数/DOM/锁继续保留；无标注仍可正常使用。

编辑器“审片”入口可浏览已有材料、点选观察格、放大已有图及播放历史成片。工程定位需重新校验准确输入、保存状态和已证明的时间映射；旧任务缺映射不猜。新普通整片/线性选区可以记录映射，旧捕获请求及v1/v2/v3回执兼容。

```sh
node desirecore/cli.mjs review <项目> --source review-pair --before-review <已有reviewId> --before-frame 0 --after-review <已有reviewId> --after-frame 0 --target-width 360 --home <数据根>
```

对照复用两个已有timed PNG，不再渲染；每侧源、版本、时点、SHA与实际尺寸独立。只列可证明的输入/已捕获字段差异，缺数据unknown，不自动对齐语义、判优、删除源或解锁。字段、预算及来源边界以唯一Schema与[RUNTIME.md](desirecore/RUNTIME.md)为准。

可选本地审片副本：`review <项目> --read <reviewId> --copy-to <已授权目录>`复用已有回执和鉴权PNG，不再捕获。副本保留来源摘要供既有Read使用，同字节可复用，冲突不覆盖，也不授予权限；新捕获同样可选`--copy-to`。详见[运行合同](desirecore/RUNTIME.md)。

## 编辑可靠性与导演上下文

文字检查器在保存期间允许继续输入；先前保存的成功或失败回执不会覆盖后续草稿或另一片段的同名图层。片段导出的SRT/VTT只包含该片段的字幕，按已有源trim、speed和片段本地range映射到输出时间；整片选区仍使用工程时轴。工程重命名同步元数据和监听，目录自身改名不会被误当成画面资源变化。

导演提案按宿主connect可选返回的workProposal.maxBytes核算完整UTF-8内容，按完整引用删减并提示省略数量，保留指令和必要工程身份；旧宿主缺字段时兼容64KiB。最小必要内容仍超限时保留完整草稿并提示调整，不静默截断指令；结果未知的重试保持原正文和请求身份。

新审片sourceFacts.version为2，人工锁摘要来自真实motion.locked，与布局摘要分开。旧版1回执可继续读取和看图，但其工程字段对照标为unknown，不用错误的历史锁投影证明“锁未变化”。

## 口播字幕的时间来源与修改保护

字幕面板逐行区分“模型词时间”“估算时间”“人工修订”和旧文件的“时间来源未知”。模型词时间只表示输入词与正文完整字面匹配，不保证识别准确率或音素对齐；匹配计数是整段转写口径。中文数字正规化等低覆盖输入仍利用实际词时间外框估算，不会静默退回零秒。来源随标准 VTT cue identifier 保存，技术标签不会印入成片。

同路径换素材或旧字幕超出音频时会列为待转写；人工切分或修订的字幕保留，自动刷新明确说明需先核对，只有显式 ASR `--force` 可请求替换。普通字幕保存、单行修改、撤回与 ASR 落盘比较所读源快照；另一窗口或识别期间发生变化会冲突，编辑器保留未提交文字。此保护复用本服务进程内串行与快照前置检查，不是跨进程文件系统事务。

`pnpm test:speech` 只运行字幕/口播相关的指定回归文件，并纳入默认 CI。真实识别、听感与声画节奏另用实际录音和最终编码验证；不以模拟服务通过代替云服务准确性。导演仍自主选择构件、组合或原创场景。

## 长口播工作媒体与文稿精剪

`prepare-media <项目> --args <JSON文件>` 将已导入的视频整源准备为可追溯的 SDR H264/AAC 工作副本，返回 `output.path` 与 `provenancePath`，不自动改时间线。明确 HLG/PQ 输入会 tone-map，旋转和原声相对起点保留；它不是 Dolby Vision 母版调色。选用该副本后，预览、渲染和审片读取同一文件，避免仅预览 proxy 仍使大原片进入审片闭包。参数、首 PTS 与旧离线 ASR 的时钟映射见[运行合同](desirecore/RUNTIME.md)。

字幕面板的“精剪这句”可选择同片段的连续句、微调气口并预听边界或跳区接缝，随后明确删除声画并闭合空隙，一次撤销。试听是当前播放器预览，最终切口仍需实际编码听看。删除字幕原文仍仅修改字幕。导演使用 `captions` 读取真实句标识和源版本，`speech-cut` 生成提案，`speech-cut-apply` 以提案原影片/字幕版本提交；过期提案冲突后重读，不把旧操作贴到新内容。原 VTT 不因剪片重写；相关锁保持，不能借删段绕过人工锁。

`pnpm test:speech-edit` 只运行指定的工作媒体、时间线和公共传输回归，默认 CI 同时执行；真实手机素材、切口自然度及最终效果另外验证。

## 字幕局部强调

字幕可用 `emphasis:[{from,to}]` 标记当句纯文本的少量重点，索引是 UTF-16 半开范围。标准 VTT 的 `<b>` / `<c.emphasis>` 读为同一强调，写回规范为 `<c.emphasis>`；文字、词时间与时间来源保持。预览和烧录共用分段/样式；拆分、合并及裁剪同步映射范围，改字清除失效标记，译文不套用原文范围。VTT旁文件保留强调与词时间，SRT降级纯文本。它独立于逐词跟读karaoke，不自动决定关键词。

导演可用 `captions-source <项目> <素材相对路径>` 读完整源字幕与snapshot，`captions-save <项目> --args <JSON文件>` 以 `{src,cues,from:原snapshot}` 条件保存；必须保留其余源句与词时间，过期409后重读合并，不能替旧稿换新from。两入口 `--schema` 可离线发现合同。强调外观沿 `.film/subtitles.json` 的可选 `emphasis:{color,weight}`；缺失用默认暖黄/粗体，null关闭强调外观。场景边距、构图和重点选择仍由导演自主判断，并在最终编码和实际观看尺寸检查。
