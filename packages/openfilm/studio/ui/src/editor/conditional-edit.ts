/** 条件编辑被拒后，刷新也不可用时恢复本地原状态；不吞掉原提交错误。 */
export async function recoverConditionalEdit(refresh: () => Promise<boolean>, restore: () => void): Promise<boolean> {
  try { if (await refresh()) return true; } catch { /* 请求失败不表示乐观编辑已经落盘。 */ }
  restore();
  return false;
}
