import type Database from 'better-sqlite3';
export function nativeTaskControl(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS royin_native_ppt_control (
    task_id TEXT PRIMARY KEY, active_token TEXT NOT NULL, auto_count INTEGER NOT NULL DEFAULT 0,
    canceled INTEGER NOT NULL DEFAULT 0, last_receipt TEXT)`);
  return {
    beginUser(taskId: string, token: string) {
      db.prepare(
        `INSERT INTO royin_native_ppt_control(task_id,active_token) VALUES(?,?)
        ON CONFLICT(task_id) DO UPDATE SET active_token=excluded.active_token,canceled=0`,
      ).run(taskId, token);
    },
    beginAutomatic(taskId: string, previousToken: string, token: string) {
      return (
        db
          .prepare(
            `UPDATE royin_native_ppt_control SET active_token=?,auto_count=auto_count+1
        WHERE task_id=? AND active_token=? AND canceled=0 AND auto_count<2`,
          )
          .run(token, taskId, previousToken).changes === 1
      );
    },
    cancel(taskId: string, token: string) {
      db.prepare('UPDATE royin_native_ppt_control SET canceled=1 WHERE task_id=? AND active_token=?').run(
        taskId,
        token,
      );
    },
    get(taskId: string) {
      return db.prepare('SELECT * FROM royin_native_ppt_control WHERE task_id=?').get(taskId) as
        | { active_token: string; auto_count: number; canceled: number; last_receipt: string | null }
        | undefined;
    },
    remember(taskId: string, token: string, receipt: string) {
      db.prepare(
        'UPDATE royin_native_ppt_control SET last_receipt=? WHERE task_id=? AND active_token=? AND canceled=0',
      ).run(receipt, taskId, token);
    },
  };
}
