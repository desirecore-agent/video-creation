# 上游来源与复用边界

本仓库通过 `git clone` 直接取得 OpenFilm 完整 Git 历史，然后在独立仓库中开发，没有重新生成或重写其编辑器、影片格式和渲染算法。

- 原仓库：https://github.com/openfilm/openfilm
- 原始上游提交：`eefd6a8d379289102141359a4718dbab12170526`
- 本仓库初始化合并提交：`ebc04d38caa9a8ec01b8e4c7aa395c74451a3207`（保留上游与独立仓库初始历史）
- 独立应用仓库：https://github.com/desirecore-agent/video-creation
- 产品名称：视频创作；技术 ID：`video-creation`
- 关联智能体：视频导演，独立仓库 https://github.com/desirecore-agent/video-director
- 本地 `upstream` remote 指向原仓库；`origin` 指向独立应用仓库。

## 复用

`packages/openfilm` 保持原目录，直接使用格式读取、HTML 影片宿主、Studio React 编辑器、文件与素材处理、字幕、检查和渲染能力。`film.html`、`.film/`、`window.film`、`window.openfilmHost` 与必要的 `OPENFILM_*` 环境变量保留兼容性。上游示例和创作 Skill 保持原来源链接，不能称为本项目独立创作的内容。

`apps/desktop`、`packages/shared` 和原历史文档留存作来源参考；它们不是本产品的运行入口，也不属于默认 pnpm workspace。应用由 DesireCore 承载，聊天、智能体执行与授权使用宿主能力。默认 CI 仅做本应用的定向检查；删除继承的 npm 发布和原桌面版发布 workflow，禁止意外发布上游品牌或使用官方更新渠道。

## 本改版

产品显示「视频创作」，兼容 CLI 使用 `video-creation`，包名为 `@desirecore-agent/video-creation`，默认数据根为 `~/.video-creation`；作品库、收藏与导出分别默认归该实例的 `projects/`、`saved/` 与 `exports/` 子目录，正式和预览数据根互相隔离。显式外部目录选择保持兼容。品牌和发行策略由 `packages/openfilm/product.json` 与 Draft-07 Schema 定义。原创 SVG 标志位于 `docs/video-creation.svg`，为带播放三角的画面框和三段时间线，与上游 F 标志不同。

`desirecore/` 为 DesireCore 安装描述、启动器与工具桥。集成保留文件作为作品事实源，并补充编辑冲突反馈、渲染状态持久化与输入快照等执行可靠性。具体契约以代码、Schema 和测试为准。

通用动效新增 `src/motion.mjs`、`src/motion-schema.mjs`、同源离线浏览器 SDK、编辑器参数/关键帧、版本化修改工具与 `examples/general-motion/` 四个原创样片。继续使用同一 film.html、FilmPage、Saved 依赖闭包与导出队列。新增逻辑与样片按本仓库 MIT 许可提供；合成声音可由样片中的生成脚本重现。

Overlay Studio（https://github.com/jeszhou/overlay-studio，参考提交 `e35e1aff9dae3b3addc21f68f3bcd51f95bdc1a8`）仅用于理解动效产品设计。该项目采用有限制的自定义许可，本仓库没有复制、修改或分发其代码、构件模板、技能、素材或运行包。新增实现的来源是现有 MIT 内核与独立编写的代码。

## 许可与分发

原 `LICENSE` 的 MIT 版权与许可全文不变；`TRADEMARK.md` 和内核 `THIRD_PARTY_NOTICES.md` 继续保留。OpenFilm 名称仅用于来源声明和兼容契约；本产品不自称官方版本。MIT 允许使用、修改和分发，但仍须在分发中带上原版权和许可。

运行时 FFmpeg、Chromium、第三方字体和其他依赖需按实际分发的组件核对各自许可证。没有把上游独立桌面包或其二进制直接作为本产品发行。构建源码不等于已完成最终二进制的许可核验。
