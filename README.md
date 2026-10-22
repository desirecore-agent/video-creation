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

## Project synchronization, output sizes and MiMo narration

Renaming an open project synchronizes its name, folder and file watchers while preserving edits and the director draft. Proposals already prepared for the previous folder need to be prepared again. The export tray labels the total delivery size and expands exact bytes for each video, subtitle or other output; API bytes remains the total and outputSizes records each output.

MiMo preset TTS supports explicit voices and delivery instructions through the existing media service and managed get CLI. Keep credentials in Providers or the service environment, outside projects and export packages. Ordinary API and Token Plan endpoints and credential scopes are configured separately under their official terms; requests do not silently switch endpoints or repeat an unknown paid request. MiMo does not supply word timestamps, so subtitles must be aligned to the actual generated audio. See the [runtime contract](desirecore/RUNTIME.md).

## Versioned frame review

`review` / MCP `video_review` distinguishes current project previews from completed video exports. The director chooses the observation points and revision strategy freely.

```sh
node desirecore/cli.mjs review <project> --source export-job --job <job-id> --times 0,2.5 --last --max-edge 1280 --home <app-home>
node desirecore/cli.mjs review <project> --source current-project --times 1,3 --last --home <app-home>
```

Use a real `done` video job ID returned by `jobs`. The receipt binds `reviewId`, `sourceKind`, original `filmRevision`, and each frame's `requestedTime`, `actualTime`, dimensions, independent PNG path, exact bytes and SHA-256. An export is copied to independent temporary storage and decoded, never re-rendered from the current project. Its revision remains the original input revision; its output digest is explicitly observed during this review. Numeric times use the first decoded video frame as this tool’s relative zero: `actualTime` is relative, `actualPTS` preserves the original timestamp, and `timeOriginPTS` records the origin. This does not claim a universal player clock or map range/clip exports back to global film time. `last` uses the actual final frame PTS. Current-project review freezes the existing static local dependency closure and seeks its browser preview. Its last state is duration minus 1ms, with `actualPTS:null`, rather than an encoded frame. Detected source changes fail explicitly.

`observation: generated-not-viewed` means the images have been generated, not that the director has seen them. The director must use the platform's existing `Read(path, expected_sha256)` to read necessary PNGs and connect the visible evidence to the exact revision and times. Inclusion in a model request does not prove understanding. Frame reads check exact bytes and digest; missing or changed images never fall back to another image. Review leaves the film, human overrides and locks untouched; revisions still use the existing versioned editing tools.

Each review is limited to six timed frames and one independent composite artifact, 4 MiB per PNG and 12 MiB across both kinds. Closing the service rejects new reviews, aborts and awaits this instance’s own review resources and queue cleanup, and does not silently continue them in the background. Temporary full-video and project input copies are removed on success and failure. Frames, requested composites and receipts remain under the app home's `reviews/<reviewId>/`, without automatic expiry or implicit reconstruction. Removing that exact directory makes old references unavailable. New export input manifests record each frozen copy’s SHA-256; historical manifests may contain only paths and byte sizes, without historical scene/resource hashes. Local digests do not freeze remote or unresolved dynamic dependencies, system fonts, or the browser environment. See [RUNTIME.md](desirecore/RUNTIME.md) for request and HTTP contracts.

## Discoverable timeline editing contract

Read the installed version’s timeline operation contract without reading app source, starting the service, or specifying a project/home:

```sh
node desirecore/cli.mjs patch --help
node desirecore/cli.mjs patch --schema
```

The second command returns a versioned Draft-07 operation-array Schema shared with MCP `video_patch.ops`. Existing field, deletion, compatibility and final validation behavior remains in the kernel. Discovery grants no new permission and does not provide scene-source CAS. Inspect the project before editing, save the operation array as a project JSON file, and submit it with the actual revision as `--base`.

To point an existing clip at an independently created scene copy, use `[{"op":"set","clip":"actual-id","field":"src","value":"tide-beacon-r2.html"}]`. This leaves unmentioned motion inputs, human DOM overrides, locks and source `time` intact. Inspect normally separates an HTML `#t` fragment into `time`; do not append a duplicate fragment when changing `src`. Preserve the actual inspected range. Reload and merge on conflict, rather than replacing the revision and blindly replaying. The installed `patch --schema` is the authoritative machine contract.


## Target-size review and traceable measurements

`node desirecore/cli.mjs review --schema` discovers the shared Draft-07 request, finding, coverage and artifact contract (`contractVersion:2`) offline, without reading a project/home or starting the service. MCP `video_review` and authenticated `GET /api/review-schema` use the same contract. For example:

```sh
node desirecore/cli.mjs review <project> --source export-job --job <job-id> --first-last --target-width 390 --max-edge 1280 --home <app-home>
```

`targetWidth` (64–4096) only downsizes verified PNG bytes from this request; it cannot upscale or exceed `maxEdge`. Each frame's `presentation` separates native source, captured and actual output dimensions, scale and `limitedBy`. Requesting 390 does not guarantee 390 pixels. `firstLast` adds 0 and last; without other sampling options it produces just the two endpoints, still within the six timed-frame limit. One `artifacts[]` entry of kind `first-last-composite` combines the two fixed frame buffers. `derivedFrom` binds exact bytes/SHA/time and encoded integer time bases. Its `timeBasis:composite-not-timed-frame` is not a frame on the timeline. `maxEdge` caps the entire composite; `layout.cells` separately reports each cell's position, source/actual dimensions and scale. Transparent padding is not source imagery.

`findings[]` records actual sampled time/source/selector/bounds/measurement/evidence/limitations. `coverage[]` describes observed, unknown or partial scope. Current-project previews measure text Ranges, local clipping and quantitative target-width size in the same FilmPage seek window. Font size and clipping are separate facts; there is no universal aesthetic font threshold. Complex transforms, occlusion, Canvas/WebGL, complex-background contrast, unsampled moments and silence are not assumed healthy. DOM and PNG belong to one sampling window, not an atomic pixel snapshot. Encoded jobs only decode their original output and never borrow current-project DOM selectors or font conclusions. `check` retains `{ok,lines,files}` and adds structured facts, but its live-check has no review snapshot guarantee.

The director chooses the observations needed, reads necessary images with `Read(path, expected_sha256)`, and decides revisions freely. Endpoints, small images and technical measurements do not certify continuous animation, audio or overall aesthetics. No finding or a check that was not run is not a pass. Observations leave the film, human DOM/motion fields and locks unchanged and do not block export automatically.
