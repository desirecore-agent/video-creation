# 视频创作首版固定验收记录

日期：2026-10-18。上游克隆基线见 UPSTREAM.md。应用与智能体源码分别位于 desirecore-agent/video-creation 和 desirecore-agent/video-director。以下区分首轮 macOS 编辑器验收、本轮三平台应用运行验收与尚未完成的原生导演闭环。

## 已实际运行

- 独立数据 home 启动 Studio，读取与保存 examples/first-film，运行 CLI inspect/patch/check/render。
- 真实 HTTP 编辑：人工标题修改后，旧基线同字段覆盖返回 409；不同字段修改重放成功并保留人工标题。
- 30 秒影片抽取 6 帧，分别按两种顺序重复绘制，确定性检查通过。
- 实际导出 H.264 MP4；ffprobe 核对 1920×1080、30/1 fps、30.000000 秒、3,872,988 字节。媒体保存在本地 .verification/first-film-1080p30.mp4，不作为源码提交。
- 普通浏览器实测双层预览、播放到第 9 秒再暂停、刷新重开、选中镜头后交接摘要保留该镜头、关闭恢复按钮焦点及草稿保留。无宿主 SDK 时显示明确提示，没有伪造平台授权或执行。
- 隔离的 DesireCore Electron 开发实例通过正常导入接口导入视频导演，实际返回 ID video-director；模板由当前 Agent seed Schema 和技能解析器验证，11 个技能可识别。
- 真实子进程集成测试覆盖受管数据根优先级、只读运行身份与 no-store、顶层原生导航签入、跨站 iframe 不签入、受鉴权导演配置及同一服务上的编辑冲突。

## 定向回归

运行 pnpm test、pnpm test:reliability、包级 typecheck 和 UI build。回归包含持久导出、进程被终止后的 interrupted 与显式 retry、排队任务准备完成后修改源文件、快照边界、取消清理隔离、不同 home 的作品与收藏隔离、有限桥接和界面状态。

## 本轮三平台应用运行验收

三平台运行同一份 `desirecore/platform-smoke.mjs`，真实启动应用子进程和 stdio MCP，不使用平台假身份、模型或用户素材。样片为本地合成 HTML/CSS，使用中文及空格路径。每个平台都通过：同一 home 重复启动拒绝、影片读取与修改、旧 revision 同字段返回 409、MCP 握手与参数拒绝、6 帧两次乱序确定性检查、真实 MP4 导出、强制结束自有进程后重启、旧任务恢复为 interrupted、显式 retry 使用新输入版本。

| 环境 | 实际运行依赖 | 本地固定证据 |
| --- | --- | --- |
| macOS arm64，Darwin 25.6.0 | Node 22.22.0；FFmpeg/ffprobe 6.0；Playwright Chromium | `.verification/macos-arm64-runtime-fixed-20261018.json` |
| Windows 11 Pro x64，10.0.26300，`win-test` 实机 | Node 24.18.0；FFmpeg/ffprobe 6.1.1；Playwright Chromium | `.verification/windows-20261018/windows-smoke-cjk.json` |
| Linux arm64，Debian 12 容器，LinuxKit 7.0.14 | Node 22.23.3；FFmpeg/ffprobe 5.1.9；Playwright Chromium；文泉驿正黑字体 | `.verification/linux-arm64-runtime-fixed-20261018.json` |

三个证据均以 `1a35d6616b0a5db725da00027b42fda6d999c0cf` 为来源基线，并包含本轮未提交修复的逐文件 SHA-256；三平台记录的全部运行文件哈希一致。Windows 使用声明该完整 SHA 的源码归档，另外核对运行文件哈希，未将归档误写为干净 Git checkout。固定 harness SHA-256 为 `1135e4c2d2b16343dfce1e7dc9a536d5f59b899d2716927b2ef7d29a6cd7ae91`；修复后 `export-job-store.mjs` SHA-256 为 `bda2d99aebd07378bc10ba7cb6235c5d470d68ef9e96551125c2d820ca447adf`。

三平台的首次输出与 retry 均由 ffprobe 确认为 H.264、320×180、12 fps、1 秒、12 帧。首次输出 SHA-256：

| 平台 | 视频 SHA-256 |
| --- | --- |
| macOS | `92b3dd16b610c72b4c99fdba438c4af816221d5319968711fd124e9cc9c5c65a` |
| Windows | `85a0d42f6e16dbb03e27f1cb032ab0c8ec758b02cbc4c413b3c6693779093beb` |
| Linux | `a3cf8f5e96c44b5eec611a68c27dd2fe48df76f989160fa809968f65aa0bf94f` |

已目视核对 Windows 导出首帧和 Linux 六帧图：人工标题可读，黄色矩形随时间移动，没有中文方框或裁切。不同系统字体和软件渲染器会产生不同视频字节，不将跨平台哈希相等作为画面一致性要求。媒体、完整机器路径及原始诊断只保存在本地 `.verification/`，不纳入源码或 Actions artifact。

本轮发现并修复 Windows 导出阻断：持久回执原来以只读 `r` 句柄调用 fsync，实机报 `EPERM`；改成 `r+` 后回执、导出、崩溃恢复及重试全部通过，仍保留同步落盘。复现记录为 `.verification/windows-20261018/fsync-windows-reproduction.json`。

本轮另外运行 `node --test --test-concurrency=1 desirecore/platform-smoke.test.mjs desirecore/release.test.mjs packages/openfilm/studio/server/exports-reliability.test.mjs`，验证验收器拒绝损坏视频、固定发布材料和导出可靠性。新增 `.github/workflows/cross-platform.yml` 在 Linux x64 runner 重复真实运行验收，并将有界证据写入日志与 job summary；结果以当前 PR 的实际 CI 为准。

## 尚未覆盖

- 影片使用本地 HTML/CSS 与自有示例，无收费媒体生成，没有实际调用大模型进行创作。
- 此记录不宣称正式安装包、远程 Web、完整应用市场上架已通过。Windows/macOS 应用运行与 Linux 容器运行是上述实际证据；Linux 实体桌面窗口和物理 GPU 未验收，Windows/Linux 检查使用软件 SwiftShader，不能推导 GPU 画面完全一致。
- 原生 AppHost 已在隔离开发实例继续联调；最终提案确认到真实视频导演执行仍在进行，当前记录保留 pending，不用三平台应用服务验收替代平台端到端验收。
- 原生伴随聊天的正确性目前有定向组件回归；浏览器视频验收与平台源会话回归是不同证据。
- 快照固定已解析的本地影片依赖；未解析的动态路径与远程资源会在回执及输入清单中明确提示，不能据此宣称任意网页资源均已冻结。
- 外部进程直接覆写影片文件只能做乐观检测；导演应使用带真实 revision 的领域 patch 接口。
