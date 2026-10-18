import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyVideoProbe } from './platform-smoke.mjs';

const good = () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 180, avg_frame_rate: '12/1', nb_frames: '12' }], format: { duration: '1.000000' } });
test('runtime acceptance rejects a missing, truncated, wrongly-sized or wrongly-timed video', () => {
  assert.equal(verifyVideoProbe(good()).frames, 12);
  for (const broken of [
    { streams: [], format: { duration: '1' } },
    { ...good(), streams: [{ ...good().streams[0], nb_frames: '1' }] },
    { ...good(), streams: [{ ...good().streams[0], width: 1920 }] },
    { ...good(), streams: [{ ...good().streams[0], avg_frame_rate: '30/1' }] },
    { ...good(), format: { duration: '30' } },
  ]) assert.throws(() => verifyVideoProbe(broken));
});
