# OpenFilm Protocol 0.1 (draft)

A film is a web page, `film.html`, that cuts pages, footage, pictures and sound together. A page is a web page that
can draw any moment of itself.

That is the whole idea. A page exposes one object, `window.film`, so it can be previewed, scrubbed, checked,
rendered to video, cut into a timeline and edited by any host that speaks this protocol. It may be written with any
library or none: three.js, p5, Canvas 2D, WebGL, GSAP, SVG, plain DOM. The protocol says nothing about how a page
draws, only how a host asks it to.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. The film: film.html

The edit, the part a person adjusts by hand in an editor, is `film.html`: HTML that says which clip plays when and
where, and CSS that says how each looks. A page draws a shot.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, height=1920">
<style>
  .card { object-fit: cover; object-position: top; border-radius: 24px; }
</style>
</head>
<body>
<section>
  <iframe id="title" src="scenes/title.html" at="1" style="left: 80px; top: 120px; width: 920px"
          overrides='[{"at":"#title","text":"Aura Pods","style":{"color":"#7fd4ff"},"t":[0,-40]}]'></iframe>
</section>
<section>
  <video id="open" src="assets/a.mp4#t=12.2,15" speed="0.5" volume="0.8" class="card"
         style="left: 56px; top: 700px; width: 968px; height: 474px" overrides='[{"fade":[0.5,0]}]'></video>
</section>
<section>
  <audio id="bed" src="assets/bed.mp3#t=0,10" volume="0.5"></audio>
</section>
</body>
</html>
```

- The stage, the frame in CSS pixels, is the viewport: `<meta name="viewport" content="width=…, height=…">`;
  without one, 1920 × 1080. The head is the film's own (styles, fonts), with no script: what moves is a page.
- The body is the tracks, each a `<section>`, in the order a timeline shows them: the first on top (a host stacks
  them; a page's own paint order does not). A track has no kind: any clip goes on any track. A track's clips do not
  overlap; overlapping pictures (a picture-in-picture, a title over footage) sit on different tracks. A track may be
  `hidden` (no picture and no sound), `muted` (no sound) or `locked`: the person's, so an agent changes nothing on it
  and an editor keeps it from being changed. Like any element of the film it may carry `id`, `class`, `title`,
  `lang`, `dir`, `aria-*` and `data-*`, which say nothing to the film.
- A clip is an element: `<iframe>` a page, `<video>`, `<img>` a still picture, `<audio>` a sound, holding nothing.
  - `src`: its file, relative to film.html. Which seconds of it play is a media fragment: `#t=in,out` in the file's
    own seconds, `#t=in` to its end; without one, all of it. A still, or a page without a `duration`, has no end:
    its `#t=0,length` is required, and is how long it stays.
  - `id`: unique across the film; without it, the file's name.
  - `at`: where it starts on the film, in seconds from 0 (default 0).
  - `speed` on videos and sounds: the playback rate, 0.25 to 4, sound keeping its pitch. The clip lasts
    `(out − in) / speed` on the film.
  - `volume` on videos and sounds: linear gain, 1 the file's own level; `muted` is 0.
  - `size` on pages: `size="1920x1080"`, the CSS pixels a page without its own `width` and `height` (§2) is laid
    out at; without it, the stage's. An editor writes it when the stage changes shape, so such a page is scaled into
    its box like a video rather than laid out again in the new shape.
  - Where a picture sits is its own style's `left`, `top`, `width` and `height` in stage pixels, and `rotate` in
    degrees, clockwise about its center. Nothing else places a clip: the host does, on the element, so no other CSS
    moves it (`position`, `transform`, `margin` and the like in a clip's style are an error). `width` and `height`
    default to the picture's own size (a page's `width × height` (§2), a video's or still's pixels); with one of them,
    the other follows the picture's proportions. A video or still is its box, the picture in it as its CSS says
    (`object-fit: contain` unless the film says otherwise: `cover` crops it to the box); without a box it is the
    stage. A page is fitted whole inside its box, centered; without one it is its own size, centered, so a page
    without a size covers the stage.
  - How a picture looks is CSS: its `class` and the rest of its `style` (`border-radius`, `clip-path`, `mask`,
    `filter`, `opacity`, `mix-blend-mode`…), and the film's `<style>`. The film's CSS has no time: what moves is a
    page.
  - `overrides` are the person's changes made in Studio, as JSON, a list of entries. An entry with `at` (a CSS
    selector), on a page clip only, tweaks an element of the page, applied by the host after each frame: optional `n`
    (which match, from 1), `t` (translate px), `s` (scale), `r` (rotate degrees) as the independent CSS transform
    properties so they compose with the page's own animation, `style` (CSS properties, camelCase or custom
    `--name`, applied with priority), `text`
    (replaces the element's own text: all of it when it has no child elements or only `<br>`s, a line break in `text`
    being a `<br>`; with other inline children, its first run of text, the children kept), `lock` (`true`: an editor keeps the element from being selected or moved; it changes
    nothing in the picture). An entry without `at`, at most one, on any clip, is the clip's own: `fade: [in, out]`,
    seconds (0 or more, to the millisecond, together no longer than the clip): its picture's opacity and its sound's
    gain ramp linearly from 0 to 1 over its first `in` seconds and from 1 to 0 over its last `out` seconds, times its
    own opacity and volume.
  - `alt`, `title`, `lang`, `dir`, `data-*` and `aria-*` are kept and say nothing to the film.
- Times (`at`, the fragment's) are seconds to the millisecond: a host rounds them to three decimals as it reads them,
  and an editor writes no more (no frame shows a finer difference). Each is rounded alone, so clips on a track that
  overlap by a millisecond or less touch.
- A page clip: the host calls the page's `frame` with the clip's local time `in + (t − at)`, holding the page's
  last frame when the clip runs past the page's `duration`.
- Anything else is an error: a host reads film.html strictly, so a misspelled attribute or a stray element is
  reported, at its line, not ignored. The reference reading is `src/film-doc.mjs`.
- The film's sound is its sound clips and the sound of its video clips, each unless its volume is 0 or its track is
  muted or hidden.

A host plays film.html as a film: served, it is itself a protocol page (the reference host puts its timeline,
`src/timeline.mjs`, in it), so a film can be previewed, checked and rendered like any page. Editors change
film.html, writing over only what they changed; the pages stay as their authors wrote them.

What film.html says is kept to what an agent and a person must agree on, so it hardly ever changes. An attribute is
added only when it changes the film (or is an agreement between the person and the agent) and cannot be CSS, a page
or a file: a look is CSS, a title is a page, a transition is a page or clips that overlap and fade, a treated recording
is a file. An editor's own state (its history, caches, what it shows) lives in its own folder (`.film/`), not in
film.html.

### Sound

A page has no sound. Every sound in a film is a clip: an `<audio>`, or a `<video>`'s own sound, each one placed,
trimmed, muted and set in volume on the timeline like any clip. A sound that belongs to a shot is placed at the film
second the shot plays it; moving the page clip does not move it. The host mixes and encodes the sound; it never
records it from the page.

Timing that follows sound (beats, onsets, word timings) is data, not API: precompute it into files the page reads
during `ready`. Hosts MAY provide tools that write such files.

### Words

What a sound or a video says is a WebVTT file beside it with the same name (`assets/vo/1.wav` → `assets/vo/1.vtt`),
in the file's own seconds: a cue is a line, timestamp tags inside it time its words, and a voice tag names who speaks.
Its translations are beside it as `1.<language>.vtt`, the same lines at the same times. A file that begins with
`NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.` has its cues as the person cut them: each is shown
as one subtitle as it is, where an editor would otherwise cut long lines into subtitles. An editor's subtitles are the
lines of the clips that can be heard, placed by each clip's `at`, its `#t=` fragment and `speed`; a host draws none
of them into the picture.

## 2. The page

```js
window.film = {
  frame(t) { /* the picture at t seconds */ },   // may return a Promise
  duration: 12,                 // optional: its own length in seconds, finite, > 0
  ready: loadEverything(),      // optional: a Promise, or a function returning one
  width: 480, height: 320,      // optional: a page that is part of the picture; without them, the stage
};
```

| Field | Type | Meaning |
| --- | --- | --- |
| `frame(t)` | function | Draw the complete picture for time `t ≥ 0` (below `duration` when there is one). If it returns a Promise, the picture is complete when it resolves. |
| `duration` | number | Optional. The page's own length in seconds. Without it a page has no end, like a still: its clip's media fragment (`title.html#t=0,4`) says how long it plays, and a range is given to check or render it alone. |
| `ready` | Promise \| () => Promise | Optional. Resolves when fonts, images, models and data are loaded. The host calls `frame` only after it settles. For web fonts, load each face used (`document.fonts.load('700 64px Fraunces')`), not only `document.fonts.ready`. |
| `width`, `height` | number | Optional. The page's size in CSS pixels, for a page that is part of the picture (a chart in a corner). Without them the page is its clip's `size` (§1), else the size of the stage, or 1920 × 1080 opened on its own. The host sizes the viewport to it; higher resolutions use device pixel ratio. |

The frame rate is not the page's: a film is timed in seconds, and the rate is chosen when it is rendered.

A page SHOULD set `window.film` before its `load` event. Hosts wait for it to appear (for at least 10 seconds
after `load`) before reporting the page as not a film.

## 3. The one rule: a frame is a function of t

For the same `t`, `frame` MUST produce the same picture, whatever was drawn before it and in whatever order frames
are requested. Hosts rely on this to scrub, to render frames in parallel, to render fractions of a frame for motion
blur, and to re-render one shot without the rest.

In practice:

- Read time from `t`. A host holds the page's clocks at `t` while it draws (§4), so `performance.now()`,
  `requestAnimationFrame` timestamps, `Date`, CSS animations and `Math.random` agree with it; timers and history
  do not.
- Repaint everything each call. Do not accumulate (`x += v`) across calls; if something has history (a trail, a
  physics run), compute it from `t`, or precompute it during `ready` and look it up.
- Tweens that record their start values the first time they run (GSAP `to`, `from`) remember whatever was on screen
  then, which depends on the order frames were drawn. Give every tween explicit start and end values (`fromTo`).
- Any library that runs its own clock is driven by `t` instead: `timeline.seek(t)`, `animation.currentTime = t * 1000`,
  `p5.redraw()`, `renderer.render(scene, camera)`, `video.currentTime = …` (awaiting `seeked`).

Notes for authors:

- `window.film` may be assigned from a module script (`<script type="module">`): modules run before `load`.
- A WebGL canvas is captured after `frame` returns. Draw inside `frame` and create the context with
  `preserveDrawingBuffer: true`, or the host may capture a cleared buffer.
- Lay the page out for its viewport (`innerWidth` × `innerHeight`, in CSS pixels): the same page can then be cut
  into films of other shapes. Hosts raise resolution with device pixel ratio, so a canvas should allocate
  `innerWidth × devicePixelRatio` pixels.
- Repeating a frame is not always bit-identical in a browser (layers are re-rasterized as they change). Hosts compare
  repeated frames with a tolerance, not byte for byte.

## 4. Hosts

Before any page script runs, a host sets `window.filmHost = { version: '0.1', name }`. When it is present the page
MUST NOT advance on its own (no self-running loop, no autoplay of media or sound). When it is absent the page is
being opened as an ordinary web page and SHOULD play itself, so every film is also a page you can just open:

```js
if (!window.filmHost) {
  const t0 = performance.now();
  const loop = () => { const t = (performance.now() - t0) / 1000; film.frame(film.duration ? t % film.duration : t); requestAnimationFrame(loop); };
  Promise.resolve(typeof film.ready === 'function' ? film.ready() : film.ready).then(loop);
}
```

A host:

- serves the page over HTTP (not `file://`), with its project (the folder of the film.html around it, else the
  page's own folder) as the root, so a page can load the project's assets;
- sizes the viewport to the page's `width × height`, or the stage's (times a device pixel ratio for higher
  resolutions);
- awaits `ready`, then calls `frame(t)` and awaits its result before capturing the viewport;
- MAY call `frame` concurrently in separate page instances, and at fractional frame times;
- reports uncaught errors and failed requests from the page.

From the first frame it draws, a host holds the page's clocks at the frame's `t`: `performance.now()` and
`requestAnimationFrame` timestamps read `t` in milliseconds, `Date` reads `t` after the epoch 2026-01-01T00:00:00Z,
CSS and Web Animations the page left running stand at `t` (a CSS transition, whose progress is history, is
finished), and `Math.random` restarts from a seed of `t` (while loading it runs from a fixed seed). Before the first
frame (`ready`, loading) the page runs on real time. The reference host's prelude is `FILM_CLOCK` in
`src/host.mjs`: `filmHost.time(t)` before `frame(t)`, `filmHost.settle(t)` after it.

A page may play footage with native `<video>` elements, silent, and set `currentTime` from `t`. The host makes
that exact: a media seek lands inside the frame it names, and the host waits until each video's new frame is on
screen before it captures.

## 5. Versioning

This is version 0.1. Attributes may be added (§1 says when); their absence must keep meaning what it means today.

## 6. 通用动效输入（motion.version = 1）

该扩展仍由 `film.html` 决定片段时间、位置及层序；没有第二条时间线。没有构件描述、没有 `motion` 属性的场景保持原有 `frame(t)` 调用。智能体可以使用构件、组合场景，或直接编写任意 HTML、CSS、SVG、Canvas、WebGL 场景，不要求字幕或预设。

### 构件描述

场景可声明唯一的 `<script id="film-motion" type="application/json">`。内容满足 `src/motion-schema.mjs` 导出的 `motionManifestSchema`（Draft-07），例如：

```html
<script id="film-motion" type="application/json">
{
  "version": 1,
  "id": "example.chart",
  "name": "数据图示",
  "description": "按绝对时间显示可编辑标题与结构化数值。",
  "paramsSchema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "additionalProperties": false,
    "required": ["title", "progress"],
    "properties": {
      "title": {"type": "string", "description": "画面标题"},
      "progress": {"type": "number", "minimum": 0, "maximum": 1, "description": "揭示进度"}
    }
  },
  "defaults": {"title": "季度趋势", "progress": 0},
  "dataSchema": {"type": "array", "items": {"type": "number"}},
  "data": [12, 24, 18]
}
</script>
```

`paramsSchema` 的根类型是 object，`defaults` 是满足它的完整默认值。`dataSchema` 和 `data` 可选；数据不是用分隔符编码的字符串。运行时使用 Ajv 的同一份完整 Draft-07 校验，不为浏览器实现另一套规则；只接受同步 Schema，不读取远程引用。关键字段应写 `description`。可用 `assets` 声明场景目录内的本地相对资源；这些显式依赖（包括含中文、空格的文件名）由既有依赖闭包纳入 Saved、历史和导出快照；不存在或越界的资源明确报错。HTML、CSS、ES module 的既有引用发现继续生效。

### 工程实例

页面片段正式支持 `motion` JSON 属性，仅适用于 iframe 页面。读取、写回和错误报告与其他影片字段共用 `film-doc.mjs`：

```html
<iframe id="chart" src="scenes/chart.html#t=0,6"
  motion='{"version":1,"params":{"title":"人工标题"},"tracks":[{"path":"params.progress","keyframes":[{"t":0,"value":0,"ease":"ease-in-out"},{"t":2,"value":1}]}],"markers":[{"id":"beat-1","t":1,"name":"强调"}],"locked":["params.title"]}'></iframe>
```

- `params` 深合并构件默认值；数组整体替换。`data` 整体覆盖默认结构化数据。
- `tracks` 中每轨由 `path` 和 `keyframes` 构成。路径如 `params.opacity`、`data.series.0.value`，必须已存在于合成输入；禁止原型路径。关键帧 `t` 为场景源秒，严格递增。区间外保持端点；时间不随播放历史累计。若目标 Schema 含 integer、enum、const 或 multipleOf 等离散约束，变化段必须显式指定 `ease: "step"`；含 patternProperties、dependencies、数组附加项或本地递归引用时同样检查；递归引用按 Schema 与剩余路径共同去重。父对象轨按内部约束保守处理。not、if、contains、anyOf、oneOf 与 uniqueItems 等条件、联合或非凸约束也保守要求变化段使用 step，不尝试求解条件分支或用有限采样证明全区间合法。编辑器通过共享 `motionTrackRequiresStep(manifest,path)` 判断，不维护第二套规则；最终求帧仍由 Ajv 严格校验。
- `ease` 描述当前关键帧到下一帧的出段，支持 `linear`、`ease-in`、`ease-out`、`ease-in-out`、`step` 和 `[x1,y1,x2,y2]` 三次贝塞尔。横向控制点在 0..1。
- 可选轨 `clock` 为 `{offset,speed,duration,loop}`：先 `(time-offset)*speed`，再截断或循环；`loop` 是 `repeat` 或 `pingpong`，循环必须指定正 `duration`。它只映射属性轨，不改变影片剪辑或音轨。
- `markers` 是 `{id,t,name?,data?}` 的可选集合，可表达步骤、字幕、音乐节拍或其他锚点。每次求帧返回所有 `t <= 当前源秒` 的锚点，先按时间再按标识排序；场景不能依赖一次性回调的触发历史。
- `locked` 是人工锁定的参数／数据路径。编辑操作必须比较编辑前后实例，保护值、覆盖路径的属性轨及锁本身；删除片段也不能绕过锁。明确的人工解锁是独立操作。锁不限制智能体选择其他创作方式。

### 求帧顺序与 SDK

SDK 是自包含的项目本地 ES module：`video-creation-motion/motion.mjs`，可被既有依赖闭包复制。宿主也在任意项目相对的 `__film/motion.mjs` 提供同一构建产物。直接打开场景的自主播放可调用 SDK `drawFrame(window.film,t,{document})`；宿主播放不自行启动循环。

声明构件的场景按以下顺序求帧：读取并校验构件 → 默认值与实例输入合成 → 属性轨采样 → 校验最终输入 → 可选 `await film.prepare(context)` → `await film.frame(t,context)` → 原有 DOM 人工 overrides。参数因此可以在 Canvas、WebGL 或程序化绘图之前使用。

```js
window.film = {
  duration: 6,
  frame(t, context) {
    const { params, data, viewport, events } = context;
    // 使用当前完整输入绘制；不依赖上一帧。
  }
};
```

`context` 为 `{version:1,time,filmTime,clipId,params,data,viewport:{width,height},events}`。`time` 与第一个参数同为场景源秒；`filmTime` 是影片秒；单页时默认等于 `time`。`viewport` 是该场景实际布局尺寸：无自有固定尺寸时跟随片段 `size` 或影片 stage。预览、首帧、缩略图、单页、时间线和导出通过相同 `drawFrame` 入口。既有 DOM overrides 保持最后应用，不转成第二套输入。

SDK 导出：`mix(a,b,p)`、`ease(p,kind)`、解析解 `spring(time,options)`、`stagger(index,{each,from})`、`mapTime(time,clock)`、`loopTime(time,duration,mode)`、`samplePath(points,p,{closed})`、`seeded(seed,index)`、`sampleTrack(track,time)`、`sampleMotion(manifest,motion,time)`、`readMotionManifest(document)`、`frameContext(time,options)`、`drawFrame(film,time,options)`。具体签名见 `src/motion.d.mts`。工程更新边界用 `freezeMotionInstance` 校验、复制并冻结实例；宿主仅复用不可变契约／实例的结构准入，不缓存时间、输入值或采样结果。`mix` 支持数字、相同维度向量、同键对象、十六进制颜色及同单位数值字符串；其他值按离散值保持。`samplePath` 是按弧长的二维折线，复杂曲线可由场景预采样为点；`mapTime` 可嵌套组合；弹簧不逐帧积分，种子不保留游标。
