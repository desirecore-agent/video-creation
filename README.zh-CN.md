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

应用正式入口是 `node desirecore/cli.mjs`。`start` 启动编辑器；`inspect` 读取项目和版本；`patch` 按版本提交编辑；`check` 检查画面；`render` 创建渲染任务；`jobs`、`retry`、`cancel` 管理渲染；`mcp --project <目录>` 提供视频导演的工具接口。用 `--help` 查看实际参数。媒体生成服务仍需用户配置，收费服务应先获得具体操作授权。

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
