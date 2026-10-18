/** 标准 stdio JSON-RPC MCP 门面。无 shell、无第二套 Agent，会话与权限继续归平台。 */
import { createInterface } from 'node:readline';
import { Ajv } from 'ajv';
import { projectClient } from './client.mjs';

const revision = { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'inspect 返回的真实影片 revision。' };
const jobId = { type: 'string', pattern: '^[a-f0-9]{12}$', description: '此项目的真实导出记录 ID。' };
export const tools = [
  { name: 'video_inspect', description: '读取绑定影片的项目路径、revision、时间线和检查问题。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'video_patch', description: '以真实基线修改影片；冲突时重读，保护同期人工编辑。操作沿用影片内核的 Op 契约。', inputSchema: { type: 'object', required: ['base', 'ops'], properties: { base: revision, ops: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'object' }, description: '按 clip ID 定位的明确编辑操作。' } }, additionalProperties: false } },
  { name: 'video_check', description: '抽取绑定影片的帧并检查确定性、字体、素材与音频；生成本地检查产物。', inputSchema: { type: 'object', properties: { range: { type: 'string', pattern: '^\\d+(\\.\\d+)?(-\\d+(\\.\\d+)?)?$', description: '可选秒数或起止秒数，如 2.5 或 0-3。' } }, additionalProperties: false } },
  { name: 'video_render', description: '提交固定本地输入快照的视频导出，立即返回任务回执；以 video_jobs 查询。', inputSchema: { type: 'object', properties: { fps: { type: 'integer', minimum: 1, maximum: 60, description: '导出帧率，默认取应用配置。' } }, additionalProperties: false } },
  { name: 'video_jobs', description: '读取绑定影片的持久导出记录、输入快照范围与实际输出。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'video_retry', description: '用户选择重试后，为失败/取消/中断的任务创建新导出，读取当前项目的新快照。', inputSchema: { type: 'object', required: ['id'], properties: { id: jobId }, additionalProperties: false } },
  { name: 'video_cancel', description: '取消绑定影片的精确导出任务。', inputSchema: { type: 'object', required: ['id'], properties: { id: jobId }, additionalProperties: false } },
];
const ajv = new Ajv({ allErrors: true });
const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

export async function callTool(config, folder, name, args = {}) {
  const validate = validators.get(name);
  if (!validate) throw new Error(`未知视频工具：${name}`);
  if (!validate(args)) throw new Error(`视频工具参数无效：${ajv.errorsText(validate.errors)}`);
  const client = await projectClient(config, folder);
  if (name === 'video_inspect') {
    const { text, value, ...summary } = await client.inspect();
    return summary;
  }
  if (name === 'video_patch') return client.patch(args.base, args.ops);
  if (name === 'video_jobs') return client.jobs();
  if (name === 'video_render') return client.render(args);
  if (name === 'video_retry') return client.retry(args.id);
  if (name === 'video_cancel') return client.cancel(args.id);
  const { look } = await import('../packages/openfilm/src/look.mjs');
  return look([client.project.path, ...(args.range ? [args.range] : [])], { count: 6 });
}

export function serveMcp(config, project, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const reply = (message) => output.write(`${JSON.stringify(message)}\n`);
  let chain = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let request;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('MCP message exceeds 1 MiB');
        request = JSON.parse(line);
      } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message' } }); return; }
      if (request.id === undefined) return;
      const result = (value) => reply({ jsonrpc: '2.0', id: request.id, result: value });
      try {
        if (request.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version');
        if (request.method === 'initialize') {
          const version = request.params?.protocolVersion;
          result({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(version) ? version : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'video-creation', title: '视频创作', version: '0.1.0' } });
        } else if (request.method === 'ping') result({});
        else if (request.method === 'tools/list') result({ tools });
        else if (request.method === 'tools/call') {
          try {
            const data = await callTool(config, project, request.params?.name, request.params?.arguments ?? {});
            const text = JSON.stringify(data);
            if (Buffer.byteLength(text) > 512 * 1024) throw new Error('结果超过 512 KiB，请缩小操作范围或读取项目文件。');
            result({ content: [{ type: 'text', text }], ...(data?.ok === false ? { isError: true } : {}) });
          } catch (error) { result({ isError: true, content: [{ type: 'text', text: error.message }] }); }
        } else reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      } catch (error) { reply({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } }); }
    }).catch((error) => process.stderr.write(`${error.message}\n`));
  });
  return new Promise((done) => lines.once('close', () => chain.then(done)));
}
