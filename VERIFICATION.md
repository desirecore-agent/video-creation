# 视频创作首版固定验收记录

日期：2026-10-18。上游克隆基线见 UPSTREAM.md。应用与智能体源码分别位于 desirecore-agent/video-creation 和 desirecore-agent/video-director。以下分别记录三平台应用运行与真实原生导演执行，证据按实际源码版本归属。CI 与合并进度实时查[视频创作 PR #1](https://github.com/desirecore-agent/video-creation/pull/1)、[视频导演 PR #1](https://github.com/desirecore-agent/video-director/pull/1)及[平台 PR #4971](https://github.com/desirecore/desirecore/pull/4971)。

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

## 当前固定发布材料

本轮外观候选的应用 UI 源码为 `b5bcf776bbda1bc3519af5d7f250e09457fd90a7`，发布清单提交为 `c0d83af1b6443f8aad13ade6adf510f8d6536e1d`。`desirecore/app-release.json` 固定 165 个文件、4,970,144 字节，release digest 为 `063b91371538f5233855b339c37dd8ee7884c37ca7cc6c47185936bcc66c4443`。该候选的外观行为与已验证范围单列于下节，不把旧材料的原生结果转记为当前候选通过。

本轮外观调整前的固定材料为：应用提交 `7e5b9a4cb475d0489cbde55d6da650c78c1bcad7`，172 个文件、5,183,847 字节，release digest `489a34e3b8128cac660c9a4ec46e63a8eb27f03d3cdd5a21e9666d74e15abd93`。相较三平台首轮运行材料，该版增加进程出生身份锁，并更新 CLI；下表历史运行结果没有冒称这些新增字节已在三平台全部复跑。该准确提交的 [core CI](https://github.com/desirecore-agent/video-creation/actions/runs/39100223154) 与 [Linux x64 runtime CI](https://github.com/desirecore-agent/video-creation/actions/runs/39100223128) 均已通过。视频导演 `32b483c7c575e2eb533e9aa6099442348c31685c` 的 [content CI](https://github.com/desirecore-agent/video-director/actions/runs/39093396008) 也已通过。

## 界面外观与本轮候选

支持外观同步的 DesireCore 原生窗口通过既有有限应用桥提供解析后的明暗主题及 43 项闭合语义 Token；应用只在可信顶层 Studio 文档中临时采用这些值，设置显示“跟随 DesireCore”。独立浏览器和未提供外观同步的旧版宿主仍使用本地浅色／深色／系统偏好；宿主同步不写入该偏好。字体、动作色、玻璃表面、控件密度、焦点、禁用状态和菜单交互统一沿宿主语义呈现。影片与场景 iframe 不安装该适配器，作品 HTML/CSS、配色和导出画面不随编辑器主题改写。

应用 UI 候选的 14 项定向外观／既有桥回归、包级类型检查与构建已通过，覆盖完整 Token 与 CSS 值验证、初始及动态主题、较早 connect 返回不能覆盖新事件、同步订阅回放、销毁后的迟到返回、旧宿主／失败／超时回退、子 iframe 隔离，以及本地偏好保留。独立浏览器的真实明暗截图检查发现并修正了浅色菜单当前项对比与设置搜索焦点框；这些检查不代替原生宿主同步验收。

平台候选 `70dd4f1d41bd79083ca3d104137b2b5a41a94ec3` 的 Windows 原生复验曾出现窄窗返回重开后外观事件丢失，不能记为该候选通过。平台修复了保活窗口重建连接后的只读外观事件投递；以下新证据使用准确平台源码 `9ed499af5780fb9341f5e60eba4d2ed0e1837125` 与当前 `063b` 应用材料，不覆盖旧候选失败记录。

macOS 26.6.2 arm64 的隔离 Electron 原生验收通过正常正式安装冷启，未额外调用 SDK connect 修复被测连接。宽窗 light／dark、隐藏后切换再重开、重开后连续切换、系统原生平铺产生的 Main 652 CSS px／Studio 596 CSS px 窄窗及 auto 实际解析为 light，共 9 份状态快照中 43 项 Token 均与宿主逐值相同。Main timeOrigin `1792312478708.6`、Studio timeOrigin `1792312553580.6` 保持不变；源会话草稿、影片与场景文件 SHA、本地 `openfilm.theme = null` 均保留。实际截图检查并独立复核搜索完整焦点环、菜单键盘当前项、禁用状态及窄窗主要操作，没有发现阻断。

播放头按真实输入区分：宽窗主题切换与隐藏重开保持 33 ms；随后菜单检查时焦点尚未进入菜单的一次 Down 将播放头移动，真实播放后暂停到 5,801 ms。后续窄窗 dark／light 与恢复 auto 后重开均保持 5,801 ms，不把有播放或键盘输入的两个时点之间写成“播放头全程不变”。实际默认世界复验仅顶层 Studio 有限 SDK，影片及场景无 SDK、Conveyor 或 Node 对象。运行健康查询返回 200／408 ms、available／healthy；正常 runtime.stop 返回 200，TaskHost `e993b752-9c7f-459a-b678-5aba653e61b1` 记录 user_stopped／task_host／SIGTERM／exit -1，开发启动器 SIGINT 退出 130。自有进程与端口归零、调试令牌移除、主题 auto 与原窗口尺寸恢复。结果位于 `.verification/ui-theme-20261018/macos-9ed499/MACOS-ACCEPTANCE.md`，26 个文件的 `manifest.json` SHA-256 为 `0c698de780e10ca4495681c994e4a1560b147dfdb559f293cea57f70c253b4e2`。本轮没有导演创作或付费媒体请求。

Windows 11 Pro 10.0.26300 x64、Node 24.18.0／Electron 44.5.1 的原生外观复验也通过。使用同一 `9ed499` 平台源码归档及 `063b` 正式应用材料，在 Main 1,400／800 CSS px、Studio 960／744 CSS px 下检查明暗、auto、隐藏重开与重开后连续切换；43 项 Token 逐值一致，实际收到 12 个外观事件，没有诊断 connect、刷新 Studio 或手动补 CSS。原矩阵的 Main timeOrigin `1792312522606.6`、Studio timeOrigin `1792312584573.4` 不变，播放头保持 33 ms，源会话和导演草稿、本地主题偏好、影片与场景 SHA 均保留；默认世界中的影片／场景仍无宿主 SDK、Conveyor 或 Node。宽窄窗明暗原生截图、菜单当前项、导演对话框及主要操作已实际检查。

Windows 后续独立冷启动只补设置动画结束后的稳定帧：该轮 Studio timeOrigin 为 `1792313365447.1`，明暗主题中对话框及遮罩 opacity 均为 1，43 项 Token 相同、影片与场景未改。它不属于前述同文档矩阵。最后一次正式 TaskHost `4076af74-9e20-4f7c-8e6f-4d859a6872d1` 通过正常停止渠道记录 user_stopped／task_host／exit 1；2026-10-18T08:52:56Z 清理审计确认零自有进程、零自有计划任务、端口关闭且调试令牌不存在，主题恢复 auto、审批覆盖恢复 null。结果为 `.verification/windows-20261018/ui-appearance-9ed499/candidate-result.json` 的 `passed`，74 个文件的 `evidence-manifest.json` SHA-256 为 `b030c17a207b9e1b07b33781e045d99545d3e0b8f2298bd20b9db127c2f0fc7a`。本轮没有新的导演创作、付费媒体或其他 Windows 架构／签名安装器验收。

## 本轮三平台应用运行验收

三平台运行同一份 `desirecore/platform-smoke.mjs`，真实启动应用子进程和 stdio MCP，不使用平台假身份、模型或用户素材。样片为本地合成 HTML/CSS，使用中文及空格路径。每个平台都通过：同一 home 重复启动拒绝、影片读取与修改、旧 revision 同字段返回 409、MCP 握手与参数拒绝、6 帧两次乱序确定性检查、真实 MP4 导出、强制结束自有进程后重启、旧任务恢复为 interrupted、显式 retry 使用新输入版本。

| 环境 | 实际运行依赖 | 本地固定证据 |
| --- | --- | --- |
| macOS arm64，Darwin 25.6.0 | Node 22.22.0；FFmpeg/ffprobe 6.0；Playwright Chromium | `.verification/macos-arm64-runtime-fixed-20261018.json` |
| Windows 11 Pro x64，10.0.26300，`win-test` 实机 | Node 24.18.0；FFmpeg/ffprobe 6.1.1；Playwright Chromium | `.verification/windows-20261018/windows-smoke-cjk.json` |
| Linux arm64，Debian 12 容器，LinuxKit 7.0.14 | Node 22.23.3；FFmpeg/ffprobe 5.1.9；Playwright Chromium；文泉驿正黑字体 | `.verification/linux-arm64-runtime-fixed-20261018.json` |
| Linux x64，GitHub Actions Ubuntu | Node 22.23.3；FFmpeg/ffprobe 6.1.1；Chromium 与 SwiftShader | [真实 runtime CI](https://github.com/desirecore-agent/video-creation/actions/runs/39100223128) |

macOS、Windows 与 Linux arm64 的三个 JSON 证据均以 `1a35d6616b0a5db725da00027b42fda6d999c0cf` 为来源基线，并包含当时尚未提交的修复逐文件 SHA-256；三平台记录的 14 个运行文件哈希一致，修复随后纳入 `fabc67ee43f5a0030d7d562d06489a08e602a0ea`。Windows 使用声明该完整 SHA 的源码归档，另外核对运行文件哈希，未将归档误写为干净 Git checkout。固定 harness SHA-256 为 `1135e4c2d2b16343dfce1e7dc9a536d5f59b899d2716927b2ef7d29a6cd7ae91`；修复后 `export-job-store.mjs` SHA-256 为 `bda2d99aebd07378bc10ba7cb6235c5d470d68ef9e96551125c2d820ca447adf`。

三平台的首次输出与 retry 均由 ffprobe 确认为 H.264、320×180、12 fps、1 秒、12 帧。首次输出 SHA-256：

| 平台 | 视频 SHA-256 |
| --- | --- |
| macOS | `92b3dd16b610c72b4c99fdba438c4af816221d5319968711fd124e9cc9c5c65a` |
| Windows | `85a0d42f6e16dbb03e27f1cb032ab0c8ec758b02cbc4c413b3c6693779093beb` |
| Linux | `a3cf8f5e96c44b5eec611a68c27dd2fe48df76f989160fa809968f65aa0bf94f` |

已目视核对 Windows 导出首帧和 Linux 六帧图：人工标题可读，黄色矩形随时间移动，没有中文方框或裁切。不同系统字体和软件渲染器会产生不同视频字节，不将跨平台哈希相等作为画面一致性要求。媒体、完整机器路径及原始诊断只保存在本地 `.verification/`，不纳入源码或 Actions artifact。

本轮发现并修复 Windows 导出阻断：持久回执原来以只读 `r` 句柄调用 fsync，实机报 `EPERM`；改成 `r+` 后回执、导出、崩溃恢复及重试全部通过，仍保留同步落盘。复现记录为 `.verification/windows-20261018/fsync-windows-reproduction.json`。

本轮另外运行 `node --test --test-concurrency=1 desirecore/platform-smoke.test.mjs desirecore/release.test.mjs packages/openfilm/studio/server/exports-reliability.test.mjs`，验证验收器拒绝损坏视频、固定发布材料和导出可靠性。新增 `.github/workflows/cross-platform.yml` 在 Linux x64 runner 重复真实运行验收，并将有界证据写入日志与 job summary；结果以当前 PR 的实际 CI 为准。

## 真实原生联调

隔离 Electron 通过正常文件夹导入安装 `video-director`，使用真实模型 seed、TaskHost accepted command、只读运行身份握手、TerminalControl 关闭与正式安装提交纳管应用。页面不获得全权 token。实际默认执行环境检查确认：顶层编辑器能读取有限 SDK；影片及场景 iframe 中没有宿主 SDK、Conveyor、Node require 或 process。记录为 `.verification/native-frame-isolation-20261018.json`。

最终 macOS 26.6.2 arm64 隔离 Electron 开发 GUI 验收准确平台源码为 `a07347f222da6d45c7ca1c4bc8f37ddd06be31ae`，使用旧版 `489a34e3b8128cac660c9a4ec46e63a8eb27f03d3cdd5a21e9666d74e15abd93` 应用材料与上述 Agent 提交。正常入口选择镜头、准备提案并真实单次确认后，同一 Run `8a636838-7faf-420f-9593-ebd6f3c244e1` 中本轮 turn `f63bf1d3-b65b-4e1a-b78a-1c16de25234d` 绑定 receipt `receipt_575a6f64-3339-4018-91ba-763a879a9ca7`；Bash invocation `a5cc733d-3892-4edd-8080-521dce5bee64` 与本轮回执均成功。CLI inspect→patch→inspect 将 revision `8eeb5c7cea9f8235` 改为 `324604f031083210`，影片与编辑器实际标题为“视频导演 · 联调验收完成”。精确 client request、真实 user message 与工具摘要身份记录于 `.verification/native-macos-a073-tool-receipt.json`。

本轮 641 个实际 Query 事件没有断线或捕获丢弃。提案用户行在 Store／DOM 各一条，审批终态、Read／Skill／Bash 和最终回复无需刷新可见。持久用户行、212 字无工具前缀、451 字含三个已完成工具的最终回复，在 conversation、merged view 和磁盘历史中持久 ID、全文 SHA-256、工具及顺序一致；审批请求／响应在视图合成一张终态卡。运行中 801 CSS px 窄窗返回原对话、保留草稿并重开同一 Studio document，GET `/runs` 为 591 ms；结束后 runtime available／healthy。实际默认执行环境复验仍只有顶层编辑器具有有限 SDK，影片与场景 iframe 没有 SDK、Conveyor 或 Node。正常 runtime.stop 返回 200，TaskHost `c59b2345-a64f-4e51-b1ce-5e68c9cb9031` 记录 user_stopped／exit 0。证据为 `.verification/native-macos-a073-{query-event-audit,message-consistency,ui-runtime,studio-origin,frame-isolation,stop}.json`。一致性记录 13 项检查全部通过，摘要为 `05b12583becf4d9b58c6b29fb185d4735dc5f4a499340aaa2ba3db719d95df68`。随后自有开发启动器正常退出 130，零自有进程，调试 token 已移除，见 `native-macos-a073-cleanup.json`。

Windows 11 最终 `a07347f222` clean 归档兼容复验通过：同 home 正常冷启、原关联／草稿／授权、四项 SDK 能力、原生编辑器及影片 iframe 隔离、中文标题、正常停止和清理。此轮未重存 grant（字节／mtime 不变），也未执行导演模型请求。平台完整归档 SHA-256 为 `1e501a7955f1af258a0293fea4b6f48f2b05af8455359ace960c8062b9d9cad3`；结果为 `.verification/windows-20261018/compat-a07347f/compatibility-result.json`，19 文件清单摘要为 `7dbe00d1b5bb904134dcf2d0287c907c1246b0dd177b45adedeb7331c94472f8`。

Windows 较早的 `d6589b721` 运行层证据还覆盖新固定材料正式更新、自动回收 PID 复用旧锁、保留安装／数据根／项目、权限保存后真实重载、同一 TaskHost 后台保活与停止后冷恢复；宽窄窗口和 OS 图像分别保留 `135cccbce7` 标签。报告为 `.verification/windows-20261018/WINDOWS-ACCEPTANCE.md`，`native-final-evidence-manifest.json` 摘要为 `dafb906cb20c2bddd172d3f359514a80bbe643d353ba8b2fa2e8b3e99eeae806`。自有进程、计划任务和调试凭据已清理，审批覆盖还原。

## 发现问题后的修复行为

- Windows 导出回执改以可写句柄 fsync 后原子替换；材料目录使用紧凑身份路径，保留完整 release 摘要和身份标记，旧引用与数据不迁移。在本次长 home 下材料 cwd 从 292 降为 195 字符，真实 cmd 与 node-pty 可进入；任意超长自选 home 仍受操作系统进程目录预算约束。
- 应用单实例锁核对操作系统进程出生身份；旧格式只有明确的出生时间晚于锁时间才证明陈旧，未知身份或损坏记录拒绝，回收前再核对文件身份与内容。文件复核、删除和独占创建不是跨进程原子 CAS；平台串行同一安装的激活，本轮不宣称任意独立 CLI 同时回收都能完全互斥。
- 平台分离页面授权版本与长期运行身份；每次仍校验精确 owner、安装、release 和完整数据登记，授权变化撤销旧页面连接。并发冷激活串行，首次呈现取消和迟到回执按当前页面处理，长提案的确认按钮常驻。
- 在可信 Main 入口及时消费真实输入对应的精确动作，再继续权限与执行核验；不延长原生一次性输入 TTL。身份 HTTP 探针使用独立新连接，保留 5 秒完整响应截止、socket 超时、8 KiB 上限及最终 TaskHost／身份核验，避免复用临近关闭的空闲 socket。
- `135cccbce7` 和 `d6589b7213abf074d66b65733c0e14e1eec0caec` 去除同一页面／运行复验中的重复快照读取。计数回归中页面路径从 21 次降为 4 次，运行路径从 17 次降为 7 次；每次 fresh runtime guard 仍实际完成一次完整文件证明、owner／host／安装 revision／完整数据登记和最终物理身份检查，运行身份不读取页面 grants，不新增 TTL 或缓存。90 项范围测试及独立安全复核通过。

最终平台 `a07347f222` 进一步去掉同一 grant 读取前紧邻的第三次重复证明，仅在已有被 await 的模型 `message_update` 回调中让出 I/O，并按消息身份重定位流式定稿。保留原授权检查与副作用边界，不新增 TTL、跨事件缓存、未等待异步链或工具通用授权 hook。14 个定向文件的 362 个唯一测试与独立复核通过，原生通过另以上述实际运行证据为准。

## 保留的历史失败

早期 AppWork sink 只发应用状态通知，导致审批卡与回复依赖历史恢复；其事件与真实用户行投影合同维护于平台私有文档“对话系统说明／原生应用工作请求的实时对话”。`135cccbce7` 后台 Run 与窄窗重开曾出现同步校验挤占服务事件循环，旧记录保留原源码标签。

Mac 旧候选 `8a3f17bac0a274c262e5d3f6abefe9628b8bce16` 第 5 轮工具与 outcome 成功：同 Run 新 turn `a59940a7-37dd-4070-b4e8-37e66d2e04b4`、receipt `receipt_68a376d7-37a4-42cc-a1ac-68a2a3f1b876` 和 invocation `29f2492a-2cc2-4d4a-93cf-9c2c70c5231c` 将 revision `03376ef38f2a9a42` 改为 `8eeb5c7cea9f8235`，见 `.verification/native-macos-run5-tool-receipt.json`。该轮有一次 Socket 断线，前一帧至断线间隔 85.021 秒；恢复后 `assistantPersisted`、`complete` 已到达，但陈旧流锚点仍在 Renderer 覆盖持久消息显示槽位、造成排序错误，因此不记作该旧源码实时聊天验收通过。本机 `video-native-query-events-run5-final.json`、`.verification/native-macos-run5-stop.json` 保留事件和 TaskHost user_stopped／exit 0，开发启动器退出 130。最终 `a07347f222` 的无刷新与身份一致性通过，来自独立新轮次的实际证据。

## 尚未覆盖

- 影片使用本地 HTML/CSS 与自有示例；真实导演 Run 使用既有已授权模型修改合成作品，没有收费媒体生成或真实用户素材上传。
- 此记录不宣称正式安装包、远程 Web、完整应用市场上架已通过。Windows/macOS 应用运行与 Linux 容器运行是上述实际证据；Linux 实体桌面窗口和物理 GPU 未验收，Windows/Linux 检查使用软件 SwiftShader，不能推导 GPU 画面完全一致。
- Windows 记录覆盖应用承载、有限桥、源对话返回、草稿与冷恢复；真实导演模型创作闭环在 macOS 验证。三平台服务 smoke 与这些原生场景各自独立归属。
- 快照固定已解析的本地影片依赖；未解析的动态路径与远程资源会在回执及输入清单中明确提示，不能据此宣称任意网页资源均已冻结。
- 外部进程直接覆写影片文件只能做乐观检测；导演应使用带真实 revision 的领域 patch 接口。
