# Contributing to 视频创作

Read [README.md](README.md) and [UPSTREAM.md](UPSTREAM.md) first. This is an independent DesireCore application, directly derived from OpenFilm with its source history and license retained.

Use Node 22.18+, pnpm 9 and FFmpeg/FFprobe. `pnpm install`, `pnpm build`, `pnpm dev`, `pnpm typecheck` and `pnpm test` operate on the reused application core only. The original desktop shell is retained as reference and excluded from the workspace. Do not restore its updater or publishing jobs.

For tests, choose the files affected by the change. From `packages/openfilm`, for example:

```sh
node --test src/product.test.mjs
node --test src/film-doc.test.mjs
node --test --test-name-pattern="split" studio/server/film.test.mjs
```

The original package test command remains available as `test:upstream` for explicit maintenance use. Do not use it as a routine local check; browser, rendering and media tests can be resource intensive. Do not run every historical package's tests together.

Film format changes belong in `src/film-doc.mjs` and `SPEC.md`; agent-facing changes belong in the application and agent contracts. Keep the shared file format and `window.openfilmHost` compatible. Preserve the person's overrides and locked tracks. Never embed credentials in source, tests, logs or screenshots.

Product identity lives in `packages/openfilm/product.json` with its Draft-07 Schema. The application updates through DesireCore; source checkouts update from this repository and must be rebuilt. There is no automatic npm publication or independent desktop installer release.

Contributions retain the upstream [MIT license](LICENSE). Keep README.md and README.zh-CN.md synchronized.
