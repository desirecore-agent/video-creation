/** 仅供已核身份的本地长请求使用；沿原 AbortSignal 等待，不另设较短的响应头期限。 */
import { request as httpRequest } from 'node:http';

export const MAX_LOCAL_JSON_BYTES = 256 << 10;

/**
 * 返回标准 Response，继续由既有客户端解析 HTTP 状态和 JSON；不跟随重定向、不执行媒体。
 * @param {URL} url
 * @param {RequestInit} [init]
 * @param {{ maxBytes?: number }} [options] 内部调用者选择的有界响应预算；媒体准备仍默认256KiB。
 * @returns {Promise<Response>}
 */
export function localJsonRequest(url, init = {}, { maxBytes = MAX_LOCAL_JSON_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
    return Promise.reject(new Error('本地JSON响应预算必须为1字节至8MiB的整数。'));
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
      // 已收到明确HTTP失败时保留状态；2xx断流仍只表示未取得完整结果。
      fail(response?.statusCode >= 400 ? Object.assign(error instanceof Error ? error : new Error(String(error)), { status: response.statusCode }) : error);
    };
    const abort = () => reject(signal?.reason ?? new DOMException('请求已取消。', 'AbortError'));
    const budgetError = () => Object.assign(new Error(`本地 JSON 响应超出回执预算（${maxBytes} 字节）。`), { code: 'LOCAL_JSON_RESPONSE_BUDGET', maxBytes });
    const request = httpRequest(url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers)),
    }, async (incoming) => {
      response = incoming;
      try {
        if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400)
          throw new Error('本地长请求拒绝重定向。');
        const declared = incoming.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw budgetError();
        /** @type {Buffer[]} */
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) throw budgetError();
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
