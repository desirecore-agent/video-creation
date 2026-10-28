import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { parseVtt } from './transcripts.mjs';
import { clipCues } from './captions.mjs';
import {
  FILM_SUBTITLE_DEFAULT, FILM_SUBTITLE_EMPHASIS_DEFAULT, FILM_SUBTITLE_EMPHASIS_SCHEMA, FILM_SUBTITLE_HOME_Y, FILM_SUBTITLE_LOOKS, FILM_SUBTITLE_PORTRAIT_Y, FILM_SUBTITLE_SIZE_PCT,
  filmSubtitleAt, filmSubtitleCss, filmSubtitleCssText, filmSubtitleFrameHtml, filmSubtitleLanguageOf,
  filmSubtitleDisplayRuns, filmSubtitleEmphasisCss, filmSubtitleRuns, filmSubtitleShown, filmSubtitleSrt, filmSubtitleStyleFor, filmSubtitleVtt, filmSubtitleWords, matchFilmSubtitleLook,
  parseFilmSubtitleStyle, sameFilmSubtitleLanguage,
} from './film-subtitle.mjs';

const D = FILM_SUBTITLE_DEFAULT;

test('语义强调外观有受限Schema，旧样式使用默认且不会接收任意CSS', () => {
  const validate = new Ajv().compile(FILM_SUBTITLE_EMPHASIS_SCHEMA);
  assert.equal(validate({ color: '#ffcc00', weight: 800 }), true);
  assert.equal(validate(null), true);
  assert.equal(validate({ color: 'red;position:fixed', weight: 800 }), false);
  assert.equal(validate({ color: '#ffd400', weight: 901 }), false);
  assert.equal(validate({ color: '#ffd400', html: '<b>' }), false);
  assert.deepEqual(parseFilmSubtitleStyle({}).emphasis, FILM_SUBTITLE_EMPHASIS_DEFAULT);
  assert.deepEqual(parseFilmSubtitleStyle({ emphasis: { color: 'red;position:fixed', weight: NaN } }).emphasis, FILM_SUBTITLE_EMPHASIS_DEFAULT);
  assert.deepEqual(filmSubtitleEmphasisCss(parseFilmSubtitleStyle({ emphasis: { color: '#abc', weight: 800 } })), { color: '#abc', fontWeight: '800' });
  assert.deepEqual(filmSubtitleEmphasisCss({ ...D, font: { ...D.font, weight: 900 } }), { color: '#ffd400', fontWeight: '900' });
  assert.deepEqual(filmSubtitleEmphasisCss(parseFilmSubtitleStyle({ emphasis: null })), {});
});

test('共享分段只强调指定UTF16范围，保留重复词、emoji和karaoke原有空白', () => {
  const text = 'a  a 😀!';
  const cue = { startMs: 0, durMs: 1000, text, speaker: 'a', emphasis: [{ from: 3, to: 4 }, { from: 5, to: 7 }],
    words: [{ text: 'a', startMs: 0, durMs: 500 }, { text: 'a', startMs: 500, durMs: 500 }] };
  const runs = filmSubtitleDisplayRuns(cue, 700, true);
  assert.equal(runs.map((run) => run.text).join(''), `a：${text}`);
  assert.equal(runs.flatMap((run) => run.parts).filter((part) => part.emphasis).map((part) => part.text).join(''), 'a😀');
  assert.equal(runs[0].parts.some((part) => part.emphasis), false, '说话人不是原文中的第一个同名词');
  assert.deepEqual(runs.filter((run) => run.active).map((run) => run.text), ['a']);
  const bad = [{ from: 1, to: 3 }, { from: -1, to: 1 }, { from: 2, to: 99 }, { from: 0.5, to: 2 }, null];
  assert.deepEqual(filmSubtitleRuns('😀<x>', bad).filter((part) => part.emphasis), []);
  assert.deepEqual(filmSubtitleDisplayRuns({ ...cue, text: '😀abc', emphasis: [{ from: 1, to: 3 }], words: [{ text: 'abc', startMs: 0, durMs: 1000 }] }, 500, true)
    .flatMap((run) => run.parts).filter((part) => part.emphasis), [], '裁片不能使原本非法的代理对范围重新变合法');
});

test('局部强调烧录安全转义，且与独立karaoke高亮叠加而非全句强调', () => {
  const cue = { startMs: 0, durMs: 1000, text: 'Tom & <Jerry>', emphasis: [{ from: 7, to: 12 }] };
  const html = filmSubtitleFrameHtml([cue], D, { w: 1080, h: 1920 }, 500);
  const css = filmSubtitleCssText(filmSubtitleEmphasisCss(D));
  assert.ok(html.includes(`Tom &amp; &lt;<span data-emphasis="true" style="${css}">Jerry</span>&gt;`));
  assert.equal((html.match(/data-emphasis=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<Jerry>/);
  const style = { ...D, karaoke: { mode: 'box', color: '#ffd400' } };
  const active = filmSubtitleFrameHtml([{ ...cue, text: 'aa bb', emphasis: [{ from: 1, to: 2 }] }], style, { w: 100, h: 100 }, 100);
  assert.match(active, /color:#000000/);
  assert.match(active, /a<span data-emphasis="true" style="font-weight:700">a<\/span><\/span> bb/);
  assert.deepEqual(filmSubtitleEmphasisCss(style, true), { fontWeight: '700' });
});

test('VTT强调保留词时间和纯文本，SRT降级为纯文本，译文去除原文范围', () => {
  const cue = { startMs: 1000, durMs: 2000, text: 'a a 😀', emphasis: [{ from: 2, to: 3 }, { from: 4, to: 6 }], timing: 'measured',
    alignment: { matchedWords: 3, totalWords: 3 }, words: [{ text: 'a', startMs: 1000, durMs: 500 }, { text: 'a', startMs: 1500, durMs: 500 }, { text: '😀', startMs: 2000, durMs: 1000 }], alt: { en: 'other words' } };
  const output = filmSubtitleVtt([cue]);
  assert.match(output, /a <00:00:01\.500><c\.emphasis>a<\/c> <00:00:02\.000><c\.emphasis>😀<\/c>/);
  const [line] = parseVtt(output).lines;
  assert.equal(line.text, cue.text);
  assert.deepEqual(line.emphasis, cue.emphasis);
  assert.deepEqual(line.marks, [{ index: 0, startMs: 1000 }, { index: 2, startMs: 1500 }, { index: 4, startMs: 2000 }]);
  assert.equal(line.timing, 'measured');
  assert.equal(filmSubtitleSrt([cue]), '1\n00:00:01,000 --> 00:00:03,000\na a 😀\n');
  for (const bilingual of [false, true]) assert.equal(filmSubtitleShown([cue], { language: 'en', bilingual })[0].emphasis, undefined);
  assert.deepEqual(filmSubtitleShown([cue], { language: null, bilingual: false })[0].emphasis, cue.emphasis);
});

test('a stored style is read field by field; the earlier { look, size } shape still reads', () => {
  assert.deepEqual(parseFilmSubtitleStyle(null), D);
  const old = parseFilmSubtitleStyle({ on: false, look: 'bar', size: 'lg' });
  assert.equal(old.on, false);
  assert.deepEqual(old.box, FILM_SUBTITLE_LOOKS.bar.box);
  assert.equal(old.font.sizePct, FILM_SUBTITLE_SIZE_PCT.lg);
  /* null turns a layer off; a missing one keeps the default */
  assert.equal(parseFilmSubtitleStyle({ stroke: null }).stroke, null);
  assert.deepEqual(parseFilmSubtitleStyle({}).stroke, D.stroke);
  assert.equal(parseFilmSubtitleStyle({ karaoke: { mode: 'nope' } }).karaoke?.mode, 'box');
  assert.equal(parseFilmSubtitleStyle({ align: 'middle', maxWidthPct: 5 }).align, 'center');
  assert.equal(parseFilmSubtitleStyle({ maxWidthPct: 5 }).maxWidthPct, 10);
});

test('a look is picked while the style is exactly it, at any size', () => {
  assert.equal(matchFilmSubtitleLook(D), 'outline');
  const bar = { ...D, ...FILM_SUBTITLE_LOOKS.bar };
  assert.equal(matchFilmSubtitleLook({ ...bar, font: { ...bar.font, sizePct: 7 } }), 'bar');
  assert.equal(matchFilmSubtitleLook({ ...bar, fill: '#ff0000' }), null);
});

test('the CSS grows away from the nearest edge and keeps the stroke outside the letters', () => {
  const low = filmSubtitleCss(D, { fontSize: '20px' });
  assert.equal(low.box.transform, 'translate(-50%, -100%)');
  assert.equal(low.text.marginBottom, '-0.725em');
  assert.equal(low.text.paintOrder, 'stroke fill');
  const high = filmSubtitleCss({ ...D, pos: { x: 0.5, y: 0.1 } }, { fontSize: '20px' });
  assert.equal(high.box.transform, 'translate(-50%, 0)');
  assert.ok(high.text.marginTop);
  const mid = filmSubtitleCss({ ...D, pos: { x: 0.5, y: 0.5 }, ...FILM_SUBTITLE_LOOKS.bar }, { fontSize: '20px' });
  assert.equal(mid.box.transform, 'translate(-50%, -50%)');
  assert.equal(mid.text.background, 'rgba(0,0,0,0.62)');
  assert.equal(filmSubtitleCss({ ...D, font: { ...D.font, family: 'Press Start 2P' } }, { fontSize: '1px' }).text.fontFamily.split(',')[0], '"Press Start 2P"');
  assert.equal(filmSubtitleCssText({ WebkitTextStrokeWidth: '1px', paintOrder: 'stroke fill' }), '-webkit-text-stroke-width:1px;paint-order:stroke fill');
});

test('on a vertical frame an unmoved subtitle rises above the feed\'s own buttons', () => {
  assert.equal(filmSubtitleStyleFor(D, { w: 1080, h: 1920 }).pos.y, FILM_SUBTITLE_PORTRAIT_Y);
  assert.equal(filmSubtitleStyleFor(D, { w: 1920, h: 1080 }).pos.y, FILM_SUBTITLE_HOME_Y);
  const moved = { ...D, pos: { x: 0.5, y: 0.5 } };
  assert.equal(filmSubtitleStyleFor(moved, { w: 1080, h: 1920 }), moved);
});

test('the shown line: the later one where two overlap; the picked language, or both', () => {
  const cues = [{ startMs: 0, durMs: 2000, text: 'a', alt: { fr: 'A' } }, { startMs: 1500, durMs: 1000, text: 'b' }];
  assert.equal(filmSubtitleAt(cues, 1600)?.text, 'b');
  assert.equal(filmSubtitleAt(cues, 2500), null);
  assert.deepEqual(filmSubtitleShown(cues, { language: 'fr', bilingual: false }).map((c) => c.text), ['A', 'b']);
  assert.deepEqual(filmSubtitleShown(cues, { language: 'fr', bilingual: true }).map((c) => c.text), ['a\nA', 'b']);
  assert.equal(filmSubtitleLanguageOf('今日はいい天気ですね'), 'ja');
  assert.equal(filmSubtitleLanguageOf('Hello there'), null);
  assert.ok(sameFilmSubtitleLanguage('pt', 'pt-BR'));
  assert.ok(!sameFilmSubtitleLanguage('zh', 'zh-TW'));
});

test('word highlight: the word being said, by its share of the line', () => {
  const cue = { startMs: 0, durMs: 1000, text: 'aa bb' };
  assert.deepEqual(filmSubtitleWords(cue, 100).filter((w) => w.active).map((w) => w.text), ['aa']);
  assert.deepEqual(filmSubtitleWords(cue, 700).filter((w) => w.active).map((w) => w.text), ['bb']);
  const timed = { ...cue, words: [{ text: 'aa', startMs: 0, durMs: 900 }, { text: 'bb', startMs: 900, durMs: 100 }] };
  assert.deepEqual(filmSubtitleWords(timed, 700).map((w) => w.text), ['aa', ' ', 'bb']);
  assert.equal(filmSubtitleWords(timed, 700)[0].active, true);
});

test('files: overlapping lines give way, speakers stay apart from the text', () => {
  const cues = [{ startMs: 1000, durMs: 2000, text: 'one', speaker: 'Ann' }, { startMs: 2500, durMs: 500, text: 'two' }, { startMs: 4000, durMs: 0, text: 'gone' }];
  assert.equal(filmSubtitleSrt(cues), '1\n00:00:01,000 --> 00:00:02,500\nAnn:one\n\n2\n00:00:02,500 --> 00:00:03,000\ntwo\n');
  assert.equal(filmSubtitleVtt(cues), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Ann>one\n\n00:00:02.500 --> 00:00:03.000\ntwo\n');
  assert.equal(filmSubtitleSrt([]), '');
});

test('burn-in HTML: the escaped line, nothing when off or silent', () => {
  const cues = [{ startMs: 0, durMs: 1000, text: 'Tom & <Jerry>' }];
  const html = filmSubtitleFrameHtml(cues, D, { w: 1920, h: 1080 }, 500);
  assert.match(html, /^<div style="position:absolute;left:0;top:0;width:1920px;height:1080px;/);
  assert.match(html, /font-size:43px/);
  assert.match(html, /Tom &amp; &lt;Jerry&gt;/);
  assert.equal(filmSubtitleFrameHtml(cues, D, { w: 1920, h: 1080 }, 1500), '');
  assert.equal(filmSubtitleFrameHtml(cues, { ...D, on: false }, { w: 1920, h: 1080 }, 500), '');
  const karaoke = filmSubtitleFrameHtml([{ startMs: 0, durMs: 1000, text: 'aa bb' }], { ...D, karaoke: { mode: 'color', color: '#ff0000' } }, { w: 100, h: 100 }, 100);
  assert.match(karaoke, /<span style="color:#ff0000">aa<\/span> bb/);
});


test('translation declares estimated timing and frame HTML carries the same provenance without a visible badge', () => {
  const cue = { startMs: 10000, durMs: 2000, text: '一百元', timing: 'measured', alignment: { matchedWords: 2, totalWords: 2 },
    words: [{ text: '一百', startMs: 10000, durMs: 1000 }, { text: '元', startMs: 11000, durMs: 1000 }], alt: { en: '100 yuan' } };
  const [translated] = filmSubtitleShown([cue], { language: 'en', bilingual: false });
  assert.equal(translated.timing, 'estimated');
  assert.equal(translated.alignment, undefined);
  assert.equal(translated.words, undefined);
  const html = filmSubtitleFrameHtml([cue], D, { w: 1280, h: 720 }, 10500);
  assert.match(html, /data-timing-origin="measured"/);
  assert.match(filmSubtitleVtt([cue]), /openfilm-timing:measured:2\/2/);
});


test('exported measured VTT retains film-time word anchors on parse and playback', () => {
  const cue = { startMs: 10000, durMs: 2000, text: '一百元', timing: 'measured', alignment: { matchedWords: 2, totalWords: 2 },
    words: [{ text: '一百', startMs: 10000, durMs: 1000 }, { text: '元', startMs: 11000, durMs: 1000 }] };
  const exported = filmSubtitleVtt([cue]);
  assert.match(exported, /一百<00:00:11\.000>元/);
  const [line] = parseVtt(exported).lines;
  assert.equal(line.timing, 'measured');
  assert.deepEqual(line.marks, [{ index: 0, startMs: 10000 }, { index: 2, startMs: 11000 }]);
  const [played] = clipCues([line], { fromMs: 0, startMs: 0, durMs: 12000, speed: 1 }, { cut: true });
  assert.deepEqual(played.words, cue.words);
  assert.deepEqual(filmSubtitleWords(played, 10500).filter((word) => word.active).map((word) => word.text), ['一百']);
  assert.deepEqual(filmSubtitleWords(played, 11500).filter((word) => word.active).map((word) => word.text), ['元']);
});

test('text-only or unmappable VTT exports explicitly lose measured timing and coverage', () => {
  const base = { startMs: 1000, durMs: 2000, text: 'One & <two>', timing: 'measured', alignment: { matchedWords: 2, totalWords: 2 } };
  for (const cue of [base, { ...base, words: [{ text: 'Different', startMs: 1000, durMs: 2000 }] },
    { ...base, words: [{ text: '<two>', startMs: 1000, durMs: 2000 }] },
    { ...base, words: [{ text: 'One', startMs: 1000, durMs: 1000 }, { text: '& <two>', startMs: 1000, durMs: 1000 }] }]) {
    const output = filmSubtitleVtt([cue]);
    assert.match(output, /openfilm-timing:estimated\n/);
    assert.doesNotMatch(output, /openfilm-timing:measured|:2\/2/);
    const [line] = parseVtt(output).lines;
    assert.equal(line.text, base.text);
    assert.equal(line.timing, 'estimated');
    assert.equal(line.alignment, undefined);
    assert.equal(line.marks, undefined);
  }
});
