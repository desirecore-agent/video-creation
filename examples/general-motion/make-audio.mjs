#!/usr/bin/env node
/** 原创合成声音：只使用确定性振荡器、包络和种子噪声，不读取或下载外部素材。 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rate = 24000;
const seconds = 24;
const clamp = (v) => Math.max(-1, Math.min(1, v));
function noise(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
}
export function audioBuffer(kind = 'product') {
  const count = rate * seconds;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  const rand = noise(kind === 'product' ? 104729 : 65537);
  const notes = kind === 'product' ? [220, 277.182631, 329.627557, 440] : [261.625565, 329.627557, 391.995436, 523.251131];
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const beat = t % 0.5;
    const bar = Math.floor(t / 2);
    const note = notes[bar % notes.length];
    const fade = Math.min(1, t / 0.08, (seconds - t) / 0.35);
    const kick = 0.42 * Math.sin(2 * Math.PI * (55 * beat + 48 * (1 - Math.exp(-beat * 24)) / 24)) * Math.exp(-beat * 17);
    const hat = rand() * Math.exp(-(t % 0.25) * 90) * 0.045;
    const pluck = Math.sin(2 * Math.PI * note * t) * Math.exp(-beat * 9) * 0.17;
    const pad = (Math.sin(2 * Math.PI * note * t) + Math.sin(2 * Math.PI * note * 1.5 * t)) * 0.025;
    wav.writeInt16LE(Math.round(clamp((kick + hat + pluck + pad) * fade) * 32767), 44 + i * 2);
  }
  return wav;
}
for (const [kind, rel] of [['product', 'product-demo/assets/original-music.wav'], ['lesson', 'optional-caption/assets/original-rhythm.wav']]) {
  await writeFile(fileURLToPath(new URL(rel, import.meta.url)), audioBuffer(kind));
}
