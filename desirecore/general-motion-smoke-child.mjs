/** 验收拥有的正式 CLI 服务：stdin EOF 正常关闭；文件入口避免 fork 继承 --eval 等执行参数。 */
const { command } = await import(process.argv[2]);
const app = await command(process.argv.slice(3));
if (!app || typeof app.close !== 'function') throw new Error('正式启动没有返回可关闭的服务生命周期');
let closing = false;
process.stdin.once('end', async () => {
  if (closing) return;
  closing = true;
  try { await app.close(); process.exit(0); }
  catch (error) { process.stderr.write(String(error?.message ?? error) + '\n'); process.exit(1); }
});
process.stdin.resume();
