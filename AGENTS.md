# 视频创作

本仓库是独立 DesireCore 应用，产品名「视频创作」，关联独立「视频导演」智能体。阅读 README.zh-CN.md、UPSTREAM.md 和 desirecore/ 下的安装与工具契约后修改。

- 优先直接复用已克隆的上游代码；保留 Git 历史、MIT 版权、许可和来源声明。
- `packages/openfilm` 是复用内核，原目录名仅用于来源和兼容；不得恢复官方 npm 更新、桌面版下载或上游发布 workflow。
- 应用品牌和发行策略从 product.json 读取；新增可配置字段提供 Draft-07 Schema 和 description。
- `film.html` 是作品事实源。保留 `window.film`、`window.openfilmHost`、`.film/` 和兼容环境变量；更改前检查版本，保留人工 overrides 和锁定轨道。
- 智能体执行、审批与聊天归 DesireCore。不要重建上游独立桌面聊天执行器，不要在应用中固定智能体的创作流程。
- `apps/desktop` 和 `packages/shared` 留存作来源参考，排除默认构建、测试和运行。
- `pnpm test` 是定向 smoke；验证修改运行相应单文件/单目录测试。不运行整个上游仓库的完整测试，不扩大为所有 package。保留的 test:upstream 仅供维护者明确选用，不作为本地惯例。
- README.md / README.zh-CN.md 修改时同步。不要新建 CLAUDE.md。提交和 PR 不添加工具或助手署名。
