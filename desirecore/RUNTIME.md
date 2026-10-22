# 视频创作的固定应用材料

本目录使用 DesireCore 的 `app-authoring-v1` 发布与运行绑定合同。应用类型为 `native-app`，页面入口为 `studio`，逻辑服务引用为 `video-creation:studio`。声明入口、关联视频导演和安装成功都不授予页面权限，也不证明当前进程可用。

## 准备材料

开发机需要 Node.js 22.18 或更高版本、pnpm 9.15.9。先在源码仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
node desirecore/release.mjs
```

生成器只读取明确的运行文件，在 `desirecore/.release/` 创建独立快照，并把同一份清单写入 `desirecore/app-release.json` 供审阅。已有快照不会覆盖；后续版本使用新的 `--output` 目录。`node desirecore/release.mjs --check` 核对当前源码、审阅清单与该快照逐字节一致。生成器不安装、启动、登记或上传应用。

快照包含已构建 Studio UI、本地服务和渲染源码、CLI/适配器、技能、示例索引、依赖清单及原有许可。生成器从本次实际安装的依赖提取完整 LICENSE/NOTICE 到 `desirecore/licenses/`，包括 Inter 的原始 OFL 1.1、React/ReactDOM/Scheduler、Lucide、Ajv 与其运行依赖、Playwright 的 Apache 许可及完整第三方通知，并保留 Vite/Tailwind 所生成运行片段和 CSS 的许可。`licenses/manifest.json` 记录具体版本与各通知文件摘要，不能以 npm 包元数据的 MIT 替代字体 OFL。它排除 `node_modules`、独立 Electron 桌面壳、开发测试和 UI 源码。清单记录每个文件的大小与 SHA-256；`source.kind: worktree` 的摘要来自这些实际材料字节，包括忽略规则下的 UI 构建产物，不能拿干净 Git HEAD 替代。

## 在固定材料根准备依赖

将生成的快照作为 `materialRoot` 交给平台 prepare。平台返回的服务管理材料根是正式执行来源。原执行智能体在该根目录准备生产依赖；安装生命周期必须关闭，因为 UI 已构建，不能重新构建或修改白名单材料：

```sh
pnpm install --prod --ignore-scripts --frozen-lockfile
```

运行依赖包括 `playwright-core`。渲染还需要实际可用的 Chromium、FFmpeg、ffprobe 和 Git。在原 owner 明确授权的独立应用数据根中执行：

```sh
node desirecore/cli.mjs setup-runtime --home <明确的应用数据目录>
```

该步骤沿已锁定的 Playwright 版本准备 Chromium headless shell；先检查系统的 FFmpeg/ffprobe，缺少时只在有固定哈希构建的 macOS arm64/x64 与 Windows x64 下载核验的制品，并在同一运行目录保存许可及源码来源。Linux 或其他无预置构建的架构需先自行安装实际可用的 FFmpeg/ffprobe，再运行 `setup-runtime`。Git 仍需系统已有。准备动作会联网下载第三方制品，不是启动器的隐式行为；应在真实输出中核对实际结果，再做影片检查和视频导出，不能仅凭依赖安装宣称可用。本快照不附带浏览器、FFmpeg 或自有第二套桌面安装器。Windows、macOS、Linux 是本清单声明的目标，未分别运行验证时不可声称全部平台已通过。

## 纳管原执行与启动

先通过 `GET /api/apps/authoring/capabilities` 检查 `app-authoring-v1`、`release`、`runtime-binding` 的实际可用状态。prepare、commit、原执行命令和启动必须使用原 owner 的授权工具；不能从应用页调用管理 API 或给页面全权 token。确切请求以当前平台公开 Schema 为准。

1. 使用稳定 `mutationId` 调用 `POST /api/apps/releases/prepare`，传授权的文件资源引用、`manifestPath: app-release.json` 和精确目标。首次个人发布使用 `sourceId: user-managed`，固定 `appId: video-creation`、安装 ID 和设备。
2. 在返回的固定材料根准备生产依赖，并通过原执行工具运行 `node desirecore/cli.mjs start --port <实际端口> --no-browser`。保留原 `terminalId` 与实际端口，不以 PID 或 curl 成功代替执行事实。原始候选执行也应使用明确、独立的数据 home；正式启动再使用平台登记的数据根。
3. 调用 `POST /api/apps/runtime/contracts`，提交原 `prepareRef`、安装 ID、`terminalId`、`endpoint: { port, identityPath: /api/desirecore/runtime-identity }` 和用户选择的 `startupPolicy`。这里固定原已接纳命令，不接受维护文本或任意 URL。
4. 停止该候选进程；正式进程由原 owner 沿固定合同重新准入。通过 `POST /api/apps/releases/commit` 提交原 v2 安装材料、准备引用、预期修订和稳定 `submissionId`。保存成功与激活结果分别读取；响应未知时查询原提交键，不重新登记第二实例。
5. 仅当前 owner、宿主、安装修订、release 和运行代际一致时，平台签发可信 `AppRuntimeBinding` 和启动回执，由隔离 AppHost 打开页面。缺少运行证明时保留 Agent 管理入口，不用核验记录里的 URL/端口兜底。

受管服务须遵守实际注入的 `PORT`，并将项目、媒体、偏好和导出状态放在独立可变数据根（平台使用 `APP_DATA_DIR`／`APP_DATA_ROOT`，应用也支持显式配置），不能写入不可变材料根。清单的数据合同声明 `video-creation-home-v1`、卸载保留数据，并使用空的页面文件键集合：平台为正式实例与预览分别登记真实数据根，网页不由此获得读取整个目录的能力。关闭应用页不停止后台渲染；停止进程、取消导出和卸载应用是不同操作。

备份时先等待或明确取消导出，经原执行 owner 停止服务，再把精确数据根完整复制到独立备份位置；用户主动打开的目录外部项目也要分别备份。它们不会自动进入 release 包。恢复时先停止同一实例，将该版本的完整备份恢复到它的登记数据根，保留目录权限，再由原启动 owner 重启并核对项目、媒体与导出状态。没有做过实际备份或恢复核验时，不宣称可以恢复。升级数据格式需要单独迁移与验证；此清单不声明读取其他格式，也不执行隐式迁移。

服务的只读身份路径使用 `Cache-Control: no-store`，只返回本次环境的四个字段：

```js
{
  proof: process.env.DESIRECORE_APP_RUNTIME_PROOF,
  releaseDigest: process.env.DESIRECORE_APP_RELEASE_DIGEST,
  scopeId: process.env.DESIRECORE_APP_SCOPE_ID,
  runtimeGeneration: process.env.DESIRECORE_APP_RUNTIME_GENERATION
}
```

这些值只用于该进程的身份握手，不是平台凭据。不得记录或转交给影片 iframe，也不能把它们当作管理 API 授权。

## 导演协作与品牌

安装视频导演后，用户可沿应用弱关联 API 把 `studio` 入口关联到真实 Agent ID。关系只保存用户偏好，不自动授予文件或模型权限。安装者应从实际安装结果读取导演 ID，在本实例数据根的 `runtime-config.json` 保存 `directorAgentId`，例如 `{ "directorAgentId": "<真实安装ID>" }`。本机独立启动也支持 `VIDEO_DIRECTOR_AGENT_ID`，但平台正式重启只保留有限公开环境，不能假定候选环境里的自定义变量会自动延续。不要用仓库名或显示名猜 ID，也不要把用户专属 ID 写进可分发清单。

Studio 只通过原有 app 级鉴权的 `/api/desirecore/context` 返回这项接线；它不是平台通用查询接口。顶层页面经宿主确认获得有限 `window.desirecoreApp` 桥；声明的 `publishSelection`／`requestWork` 还需用户明确授予。应用可准备完整选区提案，最终提交由平台自己的控件接纳。影片页面不获得该桥。首版受管顶层签入针对 Electron，Web 隔离 iframe 的 cookie/bootstrap 和实际音视频兼容仍需独立验收。

OpenFilm 的原许可证、商标政策和第三方声明保留在材料中。产品界面使用“视频创作”，智能体使用“视频导演”；引用上游名称用于准确来源与版权说明。外部浏览器、编解码器和媒体模型服务的许可与费用，按实际使用的组件另行处理。

## 通用动效与自由场景工具合同

影片仍以 `film.html` 为唯一时间线。动效页面可在 `script#film-motion[type="application/json"]` 声明构件、参数 Draft-07 Schema、默认值和结构化数据；片段的 `motion` 保存参数覆盖、属性关键帧、事件锚点和人工锁。`video_inspect`／`video_patch` 仍允许智能体自主编写、组合 HTML/CSS/SVG/Canvas/WebGL 场景；没有 manifest 的旧 `frame(t)` 页面继续工作，不要求任务使用构件或字幕。

CLI 与 MCP 均绑定一个真实项目，使用启动服务已有鉴权、编辑串行与 revision：

| CLI | MCP | 结果与边界 |
| --- | --- | --- |
| `motion-catalog <项目>` | `video_motion_catalog {}` | 读取项目与应用自带样片中真实 manifest；返回参数 Schema 和内置构件 `ref`，不下载模板。项目页面沿编辑器已有非隐藏目录、最多三级的发现范围。 |
| `motion-inspect <项目> [片段ID]` | `video_motion_inspect {clip?}` | 返回 `{rev, clips:[{clip,src,motion,manifest,sourceDigest,problems}]}`，实际错误留在 problems，不以空对象掩盖坏声明。 |
| `motion-install <项目> --base <rev>` | `video_motion_install {base}` | 将本应用固定自包含 SDK 复制到 `video-creation-motion/motion.mjs`；返回真实 SHA-256。模块内保留根 MIT 及实际依赖的完整 MIT／BSD 许可原文，单文件复制时也携带。无联网和任意 npm 安装，已存在不同字节则冲突并保留。页面通过相对 ES module import 引用。 |
| `motion-take <项目> <ref> --base <rev>` | `video_motion_take {base,component}` | 从当前 catalog 的 builtin ref 沿既有 Saved 依赖闭包复制资源，返回 `{rev,clip,component,saved}`。只导入资源，影片没改则 revision 保持；随后以返回 revision 调用 `video_patch` 的 `insert` 自主选择位置与轨道。 |
| `motion-patch <项目> <片段ID> --base <rev> --ops <文件>` | `video_motion_patch {base,clip,changes}` | 文件内容为 changes 数组；按参数路径、属性轨路径、事件 ID 定位，保留其他值和同期人工编辑。 |

局部修改示例：

```json
[
  {"path":["params","title"],"value":"新的标题"},
  {"path":["tracks","params.opacity"],"value":{"path":"params.opacity","keyframes":[{"t":0,"value":0,"ease":"ease-out"},{"t":1,"value":1}]}},
  {"path":["markers","beat-1"],"value":{"id":"beat-1","t":1,"name":"音乐强调"}},
  {"path":["markers","old-beat"],"remove":true}
]
```

`params`／`data` 可按对象字段嵌套修改，数组数据作为整体替换，避免位置移动后修改错误项。单条属性轨按 `path` 整体比较和替换，事件按 `id` 比较和替换；同一目标同期变更返回 HTTP 409／CLI 退出码 3，其他独立字段可以在已知基线上重放。所有参数和全部关键帧写入前都通过真实场景 Schema；非法领域值返回 HTTP 422，影片保持原字节。通用 `fields`、移除片段及整片重写也检查旧人工锁，不能通过便利入口绕过。

锁属于编辑意图。用户明确要求调整锁时，沿既有 `patch` 提交独立操作 `{"op":"motion-locks","clip":"真实ID","locked":["params.title"]}`；`locked` 为保留的完整锁列表，`[]` 表示明确解锁全部。它只改锁，要求最新真实 revision，不在旧版本上自动重放。没有明确要求时，不为实现其他修改而先解除人工锁。

HTTP 合同分别为 `GET /api/projects/:id/motion/catalog`、`GET /api/projects/:id/motion?clip=<ID>`、`POST .../motion/sdk {base}`、`POST .../motion/take {base,component}`、`PATCH .../motion {base,clip,changes}`。这些路径不向影片 iframe 暴露平台凭据，也不赋予新平台权限。

## 输出参数与实际回执

`render`／`video_render` 复用同一视频参数 Schema 和既有固定输入快照、持久导出队列、查询、取消与明确重试，不另建任务系统。支持 `codec`、`alpha`、`fps`、`quality`、`frame`／`fill`／`shortEdge` 或明确 `width`＋`height`、`range`、`clip`／`scale`、`samples`／`shutter`、音频、硬件编码与字幕旁文件。MCP 另有 `output` 输出目录；CLI 对应 `--output`。

- `fps` 允许 1 到 120 的数字及 `24000/1001`、`30000/1001`、`60000/1001`。数字简写 23.976、29.97、59.94 规范为对应精确 NTSC 比值，同一数值用于求帧和编码。
- H.264／HEVC 输出 MP4；VP9 输出 WebM；ProRes 422 HQ、ProRes 4444、HEVC alpha 输出 MOV；PNG 为帧序列 ZIP。`alpha:true` 只接受实际支持透明的 VP9、ProRes 4444、HEVC alpha 和 PNG。特定编码器是否安装仍由真实运行能力决定，失败保存在任务回执。
- `width`／`height` 须一起提供、为 64 到 4096 的偶数，不能同时提供 `frame`／`shortEdge`／`clip`／`scale`。画幅宽高比为 1:4 到 4:1；`clip` 以原片段画幅和 `scale` 输出，`range` 使用片段本地秒。整片 `range` 使用工程秒。
- `samples:1` 不做运动模糊；2 到 32 使用内核现有快门区间平均。透明输出先以 16 位预乘颜色进行平均，再还原直通颜色，避免移动或淡出的透明边缘出现黑边。`shutter` 是一帧的 0 到 1 比例，必须同时提供 `samples`。PNG 序列不含音频；不支持的字段或组合直接拒绝，不静默忽略。

CLI 示例：`node desirecore/cli.mjs render <项目> --codec vp9 --alpha --fps 30000/1001 --width 1080 --height 1920 --range 0-3 --samples 8 --shutter 0.5 --no-audio --wait`。立即返回的是提交回执；以 `video_jobs` 或 CLI `jobs` 的实际 `status`、`outputs`、`error` 和输入快照为事实源。`done` 才表示完成，`failed`、`cancelled`、`interrupted` 都不是成功；`--wait` 对这些终态返回非零。MCP 工具消息出现 `isError` 或回执终态失败时，即使 stdio 进程退出 0，也不能宣称样片成功。超时结果未知时先查原记录，不自动重复提交。


## 工程重命名与导出大小

项目身份以稳定id为准；重命名改变name/path时，服务通过独立project事件通知已连接编辑器，重连也发送当前元数据。编辑器合并元数据，保留已加载影片、编辑历史和当前播放点；文件监听和导出事件根同步迁移到新目录。已经打开的导演草稿更新目录并保留指令/引用，旧的已准备提案失效，需基于新来源重新准备。

完成回执的`bytes`始终表示`outputs`全部交付的逻辑字节总计，包含字幕旁文件、分轨等，不是只指主MP4；`outputSizes:[{path,bytes}]`给出每项最终实际大小。目录按其文件内容递归求和。旧回执可能没有outputSizes，不能凭总计虚构单个文件大小。导出托盘标明总计，并可展开各文件的准确字节。最终声明交付缺失或不可读取会使该次导出失败，不发done。


## 媒体调用与MiMo

受管CLI复用现有`/api/get`：`node desirecore/cli.mjs get <项目目录> tts --args <JSON参数文件> --via mimo --model mimo-v2.5-tts --home <应用数据根>`。参数为`{"out":"intro-mimo","text":"准确的旁白正文","voice":"白桦","style":"自然、从容，数字清楚，避免播音腔。"}`。out是素材名称，实际src、精确dur和bytes以落盘回执为准；不是完整电影的导出命令。

凭据只通过应用Providers的MiMo设置或服务进程MIMO_API_KEY配置，不作为CLI开关、参数文件或工程来源字段。MIMO_API_BASE_URL显式选择运行进程端点，默认https://api.xiaomimimo.com/v1；Token Plan中国区为https://token-plan-cn.xiaomimimo.com/v1，须与相应凭据及官方使用范围匹配。缺少显式匹配配置会在出站前报错，不静默改端点。MiMo沿现有provider/素材落盘合同运行，不新增算力或Agent运行时。

风格进入user消息，正文原样进入assistant消息；适配只用预置TTS，不克隆真人，不自动润色正文。成功要求finish_reason=stop、有效完整PCM WAV和精确源时长；截断、错误或无音频不是成功。无MiMo词时间戳，因此不生成伪造逐字VTT。超时或传输断开时结果可能未知，应先检查素材与回执，不能自动重复付费请求。

## 带来源的审片材料

正式入口是 `review <项目> --source current-project|export-job`、MCP `video_review` 和原鉴权下的 `POST /api/projects/:id/reviews`。HTTP/MCP 共用 Draft-07 `reviewRequestSchema`：

```json
{"source":"export-job","job":"真实12位十六进制任务ID","times":[0,2.5],"last":true,"maxEdge":1280}
```

`source` 必须显式提供。只有 `export-job` 必须提供 `job`，且仅接受此项目真实 `done` 视频任务的主输出；不接受任意路径、未完成任务、音频或无输入版本的旧记录，不自动降级为当前工程。`times` 是 1–6 个不重复的非负有限秒数，与 `count` 互斥；`count` 为 1–6，工程按 duration、编码视频按真实首末 PTS 范围均匀取样。`last` 额外一帧，总数最多六帧。无任何取样选项时默认 `count:4`。`maxEdge` 为 128–1920，默认 1280，保持画幅且不放大。时间越界或请求之后没有编码帧明确失败，不能偷偷钳到末帧。

CLI 对应 `--job <ID>`、`--times 0,2.5`、`--count 4`、`--last`、`--max-edge 1280`。编码末帧使用真实解码 PTS，不由 duration×fps 猜测；`durationOrigin:container-format-metadata` 的 `duration` 是容器元数据（可能与首末帧范围不同），编码范围另报 `encodedRange:{firstPTS,lastPTS}`，不据容器 duration 提前拒绝存在的画面；数字时间以首个真实解码视频帧为零点，返回不早于所求相对时间的第一帧；`actualTime` 为此相对秒数，`actualPTS` 为原始 PTS，顶层 `timeOrigin:first-decoded-video-frame` 与 `timeOriginPTS` 声明这个工具口径，不把它推广成包含 edit-list/负 PTS 等媒体的通用播放器时钟。`source.output.outputTimeToFilmTime:null` 明确不提供 range/clip 输出到原 film 全局时间的隐式映射。当前工程没有编码 PTS，末态按 duration 前 1ms 求帧。每帧区分：

```js
{
  index: 0, requestedTime: 2.5, actualTime: 2.533333,
  actualPTS: 2.533333, actualPTSTicks: '38912', ptsTimeBase: '1/15360', timeBasis: 'encoded-pts', frameIndex: 76,
  width: 1280, height: 720, path: '<本次独立PNG绝对路径>',
  bytes: 12345, sha256: '<精确SHA-256>', mimeType: 'image/png',
  url: '/api/projects/<id>/reviews/<reviewId>/frames/0'
}
```

工程预览的 `timeBasis` 为 `project-seek`、`actualPTS:null`，`lastFramePolicy` 为 `project-duration-minus-0.001s`；真实导出为 `last-decoded-video-frame-pts`。`actualPTSTicks` 与 `ptsTimeBase` 保留原始整数时间戳及时间基，解码对应关系用整数交叉乘积验证，不因 showinfo 的低精度秒显示放宽容差。`reviewId`、`sourceKind`、`projectId`、`filmRevision`、`createdAt`、原请求和 `source` 与帧一并存入独立回执。每次产生新 24 位 ID，不覆盖其他审片。

当前工程复用 `snapshotFilm` / `filmClosure`，静态本地输入快照逐文件记录 `{path,bytes,sha256}` 与整体摘要，并在求帧前后核当前工程同一闭包和影片版本；`consistency: local-snapshot-with-live-before-after-checks` 不表示跨文件原子事务。导出从 job 的原 `inputSnapshot.filmRevision` 取版本，将输出复制到本次自有暂存目录、核原观察字节后仅解码该副本，并再次核副本摘要；`source.output.digestOrigin: observed-at-review`、`exportCompletionDigest:null` 明确不是任务完成时的摘要。新导出输入清单逐项 SHA-256 来自同次提交冻结副本；旧清单只有 path/bytes 时仍照实返回，不虚构场景或素材的历史 SHA。已生成的旧导出审片不随当前工程更新而改变来源。

临时完整视频和工程快照在成功/失败后精确删除。只保留应用数据根 `reviews/<reviewId>/` 的 PNG 与 `review.json`，没有自动 TTL；清理该精确目录即使其引用失效，不改变导出或影片。每次最多 10000 个静态输入、2 GiB 输入、6 张 PNG（单张 4 MiB、总计 12 MiB）；应用内串行生成审片，不启动第二任务系统或媒体服务。

`GET /api/projects/:id/reviews/:reviewId` 读取原回执；`GET .../reviews/:reviewId/frames/:index?expected_sha256=<原摘要>` 只按该项目和 review 身份读取精确 PNG，先核实际尺寸预算、字节和 SHA，返回 `image/png`、`Cache-Control:no-store` 与 SHA ETag。路径不可由请求替换。缺帧为 404 / `missing-frame`，字节/摘要或调用者期望不符为 409 / `digest-mismatch`，读取中源变化为 409 / `stale`，导出未完成为 409 / `job-not-complete`，非法请求/预算为 400 或 422；失败不隐式补帧或重渲染。权限仍由应用原 loopback/key、浏览器 origin 和平台原文件权限约束，不给影片 iframe 新桥或管理权限。

`observation: generated-not-viewed` 只说明材料已生成。导演通过现有 `Read(path, expected_sha256)` 实际读取必要画面，并按返回尺寸与实际时间描述观察；指针、生成回执或仅文本摘要不证明看图，图片包含于模型请求也不证明理解或审美结论。此入口不写 film.html、场景源码、人工 DOM overrides 或锁，不规定导演如何构思或修订。真实原生调用、图像请求证据和人工锁比较以固定验收记录为准。

审片运行生命周期归现有 Studio：`whenIdle` 退出会把在途/等待审片视为 busy。正式关闭服务时停止接收新审片，取消并等待仅该实例拥有的审片 FFmpeg/FFprobe、FilmPage 与本地文件 site，再清理其独占临时输入；不调用全局进程清理。等待队列也明确结束，不在重启后暗中恢复观察。读取已生成材料仍以原摘要为准；进行中观察停止为 `review-stopped`，未生成成功回执时不能当作已经看图。

## 不读材料源码的时间线操作发现

`node desirecore/cli.mjs patch --schema` 在配置/home/项目/服务发现之前返回 Draft-07 操作数组 Schema；`patch --help` 给出此入口。它不启动 Studio、不读取 `runtime-config.json`、不创建 home，也不要求把应用材料目录加入智能体文件读取范围。Schema 的 `$id: urn:desirecore:video-creation:timeline-ops:v1` 标明合同版本；MCP `video_patch.inputSchema.properties.ops` 使用同一份 `op-schema.mjs` 描述数据。它描述现有 `set`、`motion`、`motion-locks`、`move`、`insert`、`remove`、`split`、`props`、`fields`、`stage`、`track`、`reorder` 十二类操作，并保留旧内核的省略/删除与未消费附加字段语义。Schema 是发现入口，最终领域合法性、真实 revision、并发冲突和人工锁仍由原 `applyOps`／影片检查执行。

最小换源文件示例（先从实际 `inspect` 取 clip ID 和 revision）：

```json
[{"op":"set","clip":"scene","field":"src","value":"tide-beacon-r2.html"}]
```

沿现有 `patch <项目> --base <真实revision> --ops <JSON文件>` 提交；HTTP 仍为既有 `POST /api/projects/:id/edit {base,ops}`，MCP 仍为 `video_patch {base,ops}`。只改 `src` 不重交或清空 `motion`、人工 overrides、锁、轨标记及 `time`。格式读取通常把 HTML src 的 `#t=0,8` 拆成 `src` 与 `time:[0,8]`，写出时由内核重新组成一个片段；保留 inspect 的 `time`，不要在新 `value` 重复拼入片段。该操作不是场景源码 CAS；对新场景的参数/人工锁兼容性与最终影片格式仍检查，旧基线的同一 src 已变则冲突。没有明确用户意图时，不为换源解锁参数或重写整片。
