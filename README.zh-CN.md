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
pnpm build      # 只构建编辑器
pnpm typecheck  # 只检查应用内核的服务端和编辑器
pnpm test       # 定向适配器、服务、发布、品牌、格式与编辑检查
```

`packages/openfilm` 保留上游路径，技术包名是 `@desirecore-agent/video-creation`，兼容 CLI 命令名是 `video-creation`。源码中的 `bin/openfilm.mjs`、`window.openfilmHost`、`film.html`、`.film/` 与 `OPENFILM_*` 环境变量作为格式/源码兼容接口保留。独立数据根默认是 `~/.video-creation`，也可由 DesireCore 分别为正式和预览实例指定。新影片库、收藏和导出分别默认放在该根目录的 `projects/`、`saved/`、`exports/`，保留用户显式选择的外部目录；项目可放在 `projects/` 内，密钥、设置、任务状态和运行时目录不能作为项目。

应用通过 DesireCore 安装与更新；源码版更新本仓库后重新构建。CLI 和服务均不查询或执行上游 npm 自更新，也不引导下载上游独立桌面版。`apps/desktop` 和 `packages/shared` 保留作来源参考，排除在默认工作区、构建及测试之外。

## 项目文件

影片是普通文件夹：`film.html` 描述轨道与片段，镜头页面实现 `window.film.frame(t)`，`assets/` 保存素材，`.film/` 保存历史与派生数据。可直接打开兼容的 OpenFilm 项目。修改前读取当前版本；尊重人工 overrides 与锁定轨道；合并冲突需要明确处理。

[格式规范](packages/openfilm/SPEC.md)与[创作手册](packages/openfilm/MANUAL.md)保留上游格式契约。直接读取原始手册时，请把其中的 `npx openfilm` 换成本仓库的兼容 CLI，或优先使用 `desirecore/cli.mjs`；通过兼容 CLI 打印的手册会显示本应用命令。

## 许可与边界

保留 [MIT 许可证](LICENSE)、[商标政策原文](TRADEMARK.md)和[第三方声明](packages/openfilm/THIRD_PARTY_NOTICES.md)。本改版使用原创图标与独立名称。运行时依赖的 FFmpeg、Chromium、字体及其他第三方组件，按实际分发内容处理各自许可证；本仓库不打包或发布原上游独立桌面安装器。

完整影片格式和编辑能力来自上游；DesireCore 集成的实际验证范围见提交与 PR 中的验证记录。付费媒体服务、安装版宿主兼容性及每个平台的最终发行包需要各自的运行验证。

`render --output` 指定输出目录；`--wait` 等待实际完成。首版真实运行范围和边界见 [固定验收记录](VERIFICATION.md)。
