<p align="center"><img src="docs/video-creation.svg" alt="视频创作" height="72"></p>

# 视频创作 · Video Creation

视频创作 is a DesireCore video editing application associated with the independent 视频导演 (Video Director) agent. People edit shots, subtitles and assets on a timeline while the agent works on the same project through files and tools.

This repository is a direct clone of [OpenFilm](https://github.com/openfilm/openfilm), with its Git history retained. It reuses the film format, Studio editor, local preview, media handling, inspection and rendering core. This is an independent derivative and does not represent the OpenFilm project. See [UPSTREAM.md](UPSTREAM.md) for provenance, reuse boundaries and licensing.

- Application: [desirecore-agent/video-creation](https://github.com/desirecore-agent/video-creation)
- Agent: [desirecore-agent/video-director](https://github.com/desirecore-agent/video-director)
- Application install descriptor: [desirecore/app-release.json](desirecore/app-release.json)
- 中文说明：[README.zh-CN.md](README.zh-CN.md)

## Development and runtime

Requires Node.js 22.18+, pnpm 9, Git, and FFmpeg/FFprobe on PATH. Inspection, preview and export also need Playwright Chromium; install it explicitly before offline use.

```sh
git clone git@github.com:desirecore-agent/video-creation.git
cd video-creation
pnpm install --frozen-lockfile
pnpm build
node desirecore/cli.mjs setup-runtime --home .dev/video-creation
node desirecore/cli.mjs start --home .dev/video-creation --project examples/first-film
```

The application entry point is `node desirecore/cli.mjs`. `start` opens the editor; `inspect` reads the project and revision; `patch` submits a revision-checked edit; `check` inspects frames; `render` creates a render job; `jobs`, `retry` and `cancel` manage renders; `mcp --project <folder>` exposes tools for Video Director. Use `--help` for the actual options. `render --output` names a directory; use `--wait` to wait for completion. The source sample and fixed validation scope are recorded in [VERIFICATION.md](VERIFICATION.md). Media generation requires the person's configured services and authorization for paid operations.

```sh
pnpm dev        # build and launch the sample with isolated .dev/video-creation data
pnpm build      # editor only
pnpm typecheck  # application core server and editor only
pnpm test       # focused adapter, service, release, brand, format and editing checks
```

The upstream source path `packages/openfilm` is retained. Its package is `@desirecore-agent/video-creation` and its compatibility command is `video-creation`. `bin/openfilm.mjs`, `window.openfilmHost`, `film.html`, `.film/` and `OPENFILM_*` variables remain source/format compatibility interfaces. The data root defaults to `~/.video-creation`, or to a separate formal/preview root supplied by DesireCore. New projects, saved media and exports default to `projects/`, `saved/` and `exports/` inside that root. Explicit external directory choices remain supported. Project folders may live under `projects/`; keys, settings, job state and runtime directories cannot become projects.

DesireCore owns installation and updates. Update a source checkout from this repository and rebuild it. Neither the CLI nor the service polls or executes upstream npm updates, and the UI does not offer the upstream desktop installer. `apps/desktop` and `packages/shared` remain as reference sources, outside the default workspace, build and tests.

## Project files

A film is a folder: `film.html` describes tracks and clips, shot pages implement `window.film.frame(t)`, `assets/` holds media, and `.film/` holds history and derived state. Compatible OpenFilm projects can be opened directly. Read the current revision before editing, preserve the person's overrides and locked tracks, and resolve conflicts explicitly.

The [format specification](packages/openfilm/SPEC.md) and [authoring manual](packages/openfilm/MANUAL.md) retain upstream contracts. When reading the original manual directly, replace `npx openfilm` with this checkout's compatibility CLI, or prefer `desirecore/cli.mjs`. The compatibility CLI prints the manual with this application's command name.

## License and limits

The [MIT license](LICENSE), original [trademark policy](TRADEMARK.md) and [third-party notices](packages/openfilm/THIRD_PARTY_NOTICES.md) are retained. This derivative has its own name and original icon. FFmpeg, Chromium, fonts and other runtime dependencies retain their respective licensing requirements according to what is actually distributed. This repository does not build or publish the upstream desktop installers.

The complete film format and editor originate upstream. Integration verification is recorded in commits and pull requests. Paid media providers, the installed DesireCore host and final platform-specific packages require their own runtime verification.
