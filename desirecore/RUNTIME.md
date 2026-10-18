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
