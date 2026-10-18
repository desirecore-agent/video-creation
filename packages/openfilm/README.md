# 视频创作内核

这是「视频创作」应用直接复用的 OpenFilm 内核，保留上游源码路径以便维护。包名为 `@desirecore-agent/video-creation`，兼容 CLI 名为 `video-creation`，不发布或更新上游 npm 包。

应用安装、开发与运行见仓库根目录的 [README.zh-CN.md](../../README.zh-CN.md)，来源与许可见 [UPSTREAM.md](../../UPSTREAM.md)。正式入口为根目录的 `node desirecore/cli.mjs`。

直接调用兼容 CLI：

```sh
node packages/openfilm/bin/openfilm.mjs --help
node packages/openfilm/bin/openfilm.mjs get
node packages/openfilm/bin/openfilm.mjs skills
```

`film.html`、`window.film`、`.film/` 与 `window.openfilmHost` 保留格式兼容。[MANUAL.md](MANUAL.md) 和 [SPEC.md](SPEC.md) 保留原格式说明；CLI 打印手册时会替换为本应用名称和命令。不要从原始手册执行 `npx openfilm` 或安装上游桌面版来运行本改版。

保留 [MIT 许可](../../LICENSE)、[商标政策](TRADEMARK.md)与[第三方声明](THIRD_PARTY_NOTICES.md)。
