// @ts-check
/** Durable receipts for the local export queue. One small record per job; media stays in the output folder.
 * This is a restart/retry receipt, not a second task system and not checkpointed rendering.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** Persisted record contract (Draft-07); paths are local application data, never an application-page credential. */
export const exportJobRecordSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', required: ['version', 'job', 'source'], additionalProperties: false,
  properties: {
    version: { const: 1, description: 'Local export receipt format version.' },
    job: { type: 'object', required: ['id', 'project', 'status', 'ask'], description: 'Export request and observable progress; interrupted jobs require an explicit retry.' },
    source: {
      type: 'object', required: ['root', 'folder'], additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Absolute original project directory. A retry reads a new snapshot from this project.' },
        folder: { type: 'string', description: 'Absolute export destination originally chosen by the user.' },
      },
    },
  },
};

/** @typedef {{ root: string, folder: string }} ExportSource
 * @typedef {{ version: number, job: import('./exports.mjs').ExportJob, source: ExportSource }} ExportReceipt */

/** @param {string} dir */
export function createExportJobStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pathOf = (/** @type {string} */ id) => {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('invalid export receipt id');
    return join(dir, `${id}.json`);
  };
  return {
    /** @param {import('./exports.mjs').ExportJob} job @param {ExportSource} source */
    save(job, source) {
      const file = pathOf(job.id), temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify({ version: 1, job, source }, null, 2)}\n`, { mode: 0o600 });
        // Windows 的 FlushFileBuffers 要求可写句柄，不能对只读句柄 fsync。
        const fd = openSync(temp, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
    },
    load() {
      /** @type {ExportReceipt[]} */
      const records = [];
      for (const name of readdirSync(dir)) {
        if (!/^[a-f0-9]{12}\.json$/.test(name)) continue;
        const file = join(dir, name);
        /* A corrupt receipt must not silently disappear from the user's export history. */
        let record;
        try { record = JSON.parse(readFileSync(file, 'utf8')); }
        catch { throw new Error(`Export receipt could not be read: ${file}`); }
        if (record.version !== 1 || record.job?.id !== name.slice(0, -5) || !record.job?.project
          || !record.job?.ask || typeof record.source?.root !== 'string' || typeof record.source?.folder !== 'string') {
          throw new Error(`Export receipt is invalid: ${file}`);
        }
        records.push(record);
      }
      return records.sort((a, b) => b.job.at - a.job.at);
    },
  };
}
