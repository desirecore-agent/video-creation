# Third-party notices

Studio's editor (`studio/ui/dist`) bundles:

- **Inter** by Rasmus Andersson, via `@fontsource-variable/inter`: SIL Open Font License 1.1
  (https://openfontlicense.org).
- **React** and **React DOM**: MIT License, © Meta Platforms, Inc. and affiliates.
- **Lucide** icons (`lucide-react`): ISC License, © Lucide Contributors.

The CLI depends on **playwright-core** (Apache License 2.0), which downloads a headless Chromium on first use.

Motion manifests and instances are validated by **Ajv 8.17.1** and
**ajv-formats 3.0.1** (MIT). The offline motion SDK bundles these validators and
their runtime dependencies. Full license texts for the actual installed runtime
and bundled dependencies are retained under `desirecore/licenses/`; its
`manifest.json` lists versions, sources and notice hashes.

The standalone SDK also embeds the complete root license and actual bundled
dependency notices in its own file: Ajv, ajv-formats, fast-deep-equal and
json-schema-traverse (MIT), and fast-uri (BSD-3-Clause). This preserves the
notices when only the SDK is copied with a project or Saved component.

The general-motion SDK and `examples/general-motion/` are original additions
under this repository's MIT license. Overlay Studio was a design reference;
none of its restricted code, templates, skills or assets are distributed here.
