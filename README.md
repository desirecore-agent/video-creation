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
pnpm build      # editor, offline motion SDK and sample dependencies
pnpm typecheck  # application core server and editor only
pnpm test       # focused adapter, service, release, brand, format and editing checks
pnpm test:motion          # motion contracts, edits, dependency closure and measurement regressions
pnpm test:motion:runtime  # actual Chromium frames and local SDK integration
```

The upstream source path `packages/openfilm` is retained. Its package is `@desirecore-agent/video-creation` and its compatibility command is `video-creation`. `bin/openfilm.mjs`, `window.openfilmHost`, `film.html`, `.film/` and `OPENFILM_*` variables remain source/format compatibility interfaces. The data root defaults to `~/.video-creation`, or to a separate formal/preview root supplied by DesireCore. New projects, saved media and exports default to `projects/`, `saved/` and `exports/` inside that root. Explicit external directory choices remain supported. Project folders may live under `projects/`; keys, settings, job state and runtime directories cannot become projects.

DesireCore owns installation and updates. Update a source checkout from this repository and rebuild it. Neither the CLI nor the service polls or executes upstream npm updates, and the UI does not offer the upstream desktop installer. `apps/desktop` and `packages/shared` remain as reference sources, outside the default workspace, build and tests.

## Interface and theme

In a DesireCore native window that supports appearance synchronization, the editor follows the host's light or dark theme, including fonts, surfaces and controls. Settings shows “Follow DesireCore”. The standalone browser editor keeps its own light, dark or system preference; the host's temporary override does not replace that saved choice. Older hosts without appearance synchronization continue using the local preference.

Theme changes affect the editor interface only. They do not rewrite the film or scene HTML/CSS, change the work's colors, or alter the exported picture. The fixed runtime validation scope is recorded in [VERIFICATION.md](VERIFICATION.md).

## General motion graphics

Create product demos, data stories, graphic animations and transparent titles without narration or an SRT file. [Four original samples](examples/general-motion/README.md) include landscape, portrait and square layouts, structured data, paths, camera transforms and original synthesized music. The build copies the same offline SDK to `motion.mjs` in each sample's root; `motion-install` installs it into `video-creation-motion/motion.mjs` for a new project. No CDN is needed.

The media pool's motion library discovers built-in components and project scenes, saves them and inserts them into the existing timeline. Select a scene with a `film-motion` manifest to edit Schema-defined parameters and data, property keyframes, easing curves, track-local looping and time mapping, markers and field locks. Locks and manual overrides stay in the project. Agent edits carry the actual revision and report conflicts explicitly.

Video Director can choose components, compose them, or write original HTML/SVG/Canvas scenes. Existing `frame(t)` scenes remain supported. New scenes can use `frame(t, context)` to receive complete parameters, data, viewport and current events before drawing. The film timeline, Saved dependency closure and export queue remain the existing implementations.

The CLI exposes `motion-catalog`, `motion-inspect`, `motion-install`, `motion-take` and `motion-patch`, with corresponding `video_motion_*` MCP tools. Taking a component creates a Saved entry; the agent chooses where to insert it. Export tools expose existing frame-rate, size, frame, range, motion-blur and codec options, including transparent VP9 WebM and ProRes 4444 MOV. MP4 has no alpha channel. See the [format specification](packages/openfilm/SPEC.md), [authoring manual](packages/openfilm/MANUAL.md) and [runtime/tool contract](desirecore/RUNTIME.md) for fields and examples.

Run actual acceptance with `node desirecore/general-motion-smoke.mjs --workdir <fresh-folder> --evidence <record-path> --label <environment>`. Chromium must be installed and FFmpeg/FFprobe must be on PATH. `--showcase` additionally exports complete 1080p samples. [MOTION-VERIFICATION.md](MOTION-VERIFICATION.md) records source identity, environments, actual results and uncovered boundaries.

## Project files

A film is a folder: `film.html` describes tracks and clips, shot pages implement `window.film.frame(t)`, `assets/` holds media, and `.film/` holds history and derived state. Compatible OpenFilm projects can be opened directly. Read the current revision before editing, preserve the person's overrides and locked tracks, and resolve conflicts explicitly.

The [format specification](packages/openfilm/SPEC.md) and [authoring manual](packages/openfilm/MANUAL.md) retain upstream contracts. When reading the original manual directly, replace `npx openfilm` with this checkout's compatibility CLI, or prefer `desirecore/cli.mjs`. The compatibility CLI prints the manual with this application's command name.

## License and limits

The [MIT license](LICENSE), original [trademark policy](TRADEMARK.md) and [third-party notices](packages/openfilm/THIRD_PARTY_NOTICES.md) are retained. This derivative has its own name and original icon. FFmpeg, Chromium, fonts and other runtime dependencies retain their respective licensing requirements according to what is actually distributed. This repository does not build or publish the upstream desktop installers.

The general-motion layer and those samples are independently implemented on the existing MIT core. Overlay Studio was a design reference; none of its code, templates, skills or assets are included. Schema validation uses bundled Ajv and ajv-formats, with complete dependency licenses under `desirecore/licenses/`. The offline SDK also embeds the root license and complete MIT/BSD notices for its five actual dependencies, retaining them when a project or the single module is saved or copied.

The complete film format and editor originate upstream. Integration verification is recorded in commits and pull requests. Paid media providers, the installed DesireCore host and final platform-specific packages require their own runtime verification.
