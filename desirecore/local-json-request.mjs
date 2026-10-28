/** 仅供已核身份的本地长媒体请求使用；沿原 AbortSignal 等待，不另设较短的响应头期限。 */
import { request as httpRequest } from 'node:http';

export const MAX_LOCAL_JSON_BYTES = 256 << 10;

/**
 * 返回标准 Response，继续由既有客户端解析 HTTP 状态和 JSON；不跟随重定向、不执行媒体。
 * @param {URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function localJsonRequest(url, init = {}) {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash)
    return Promise.reject(new Error('本地长请求只接受已核身份的回环 HTTP 地址。'));
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string')
    return Promise.reject(new Error('本地长请求正文必须是已序列化的 JSON。'));
  const signal = init.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('请求已取消。', 'AbortError'));

  return new Promise((done, fail) => {
    let settled = false;
    /** @type {import('node:http').IncomingMessage | undefined} */
    let response;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const reject = (/** @type {unknown} */ error) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request.destroy();
      fail(error);
    };
    const abort = () => reject(signal?.reason ?? new DOMException('请求已取消。', 'AbortError'));
    const request = httpRequest(url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers)),
    }, async (incoming) => {
      response = incoming;
      try {
        if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400)
          throw new Error('本地长请求拒绝重定向。');
        const declared = incoming.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_LOCAL_JSON_BYTES))
          throw new Error('本地 JSON 响应超出回执预算。');
        /** @type {Buffer[]} */
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_LOCAL_JSON_BYTES) throw new Error('本地 JSON 响应超出回执预算。');
          chunks.push(chunk);
        }
        if (settled) return;
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item);
        const data = Buffer.concat(chunks);
        const result = new Response(data.length ? data : null, { status: incoming.statusCode ?? 502, headers });
        settled = true;
        cleanup();
        done(result);
      } catch (error) { reject(error); }
    });
    request.once('error', reject);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    request.end(body ?? undefined);
  });
}
