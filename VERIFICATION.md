# 视频创作首版固定验收记录

日期：2026-10-18。环境：macOS arm64，本地源码开发版；上游克隆基线见 UPSTREAM.md。应用与智能体源码分别位于 desirecore-agent/video-creation 和 desirecore-agent/video-director。

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

## 尚未覆盖

- 影片使用本地 HTML/CSS 与自有示例，无收费媒体生成，没有实际调用大模型进行创作。
- 此记录不宣称正式安装包、Windows/Linux、远程 Web、完整应用市场上架或原生 AppHost 中最终提案确认与 Agent 执行已通过。
- 原生伴随聊天的正确性目前有定向组件回归；浏览器视频验收与平台源会话回归是不同证据。
- 快照固定已解析的本地影片依赖；未解析的动态路径与远程资源会在回执及输入清单中明确提示，不能据此宣称任意网页资源均已冻结。
- 外部进程直接覆写影片文件只能做乐观检测；导演应使用带真实 revision 的领域 patch 接口。
