// ============================================================================
// Persistence Layer - SQLite via sql.js (no native compilation required)
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { TaskNode, TaskStatus, TaskCategory, WorkerStatus } from '../types';

export class Persistence {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private autoSave: boolean = true;
  private saveInterval?: NodeJS.Timeout;
  private pending: Set<string> = new Set();

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(process.cwd(), 'data', 'integrated-agent.db');
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Initialize SQL.js
    const SQL = await initSqlJs();

    // Load existing database or create new
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
      console.log(`[Persistence] Loaded database from ${this.dbPath}`);
    } else {
      this.db = new SQL.Database();
      console.log(`[Persistence] Created new database at ${this.dbPath}`);
    }

    this.createTables();
    this.startAutoSave();
  }

  private createTables(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        category TEXT NOT NULL,
        instructions TEXT NOT NULL,
        parent TEXT,
        children TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        snapshots TEXT NOT NULL DEFAULT '[]',
        worker_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        task_id TEXT,
        worker_id TEXT,
        message TEXT NOT NULL,
        details TEXT,
        duration_ms INTEGER
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS model_stats (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        total_calls INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cost_budget (
        id TEXT PRIMARY KEY,
        budget_type TEXT NOT NULL,
        limit_amount REAL NOT NULL,
        current_spend REAL NOT NULL DEFAULT 0,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)
    `);
  }

  private startAutoSave(): void {
    this.saveInterval = setInterval(() => {
      if (this.pending.size > 0) {
        this.save();
      }
    }, 5000);
  }

  // ===========================================================================
  // Task Persistence
  // ===========================================================================

  saveTask(task: TaskNode): void {
    if (!this.db) return;
    this.pending.add(task.id);

    this.db.run(`
      INSERT OR REPLACE INTO tasks
      (id, status, priority, category, instructions, parent, children,
       created_at, updated_at, started_at, completed_at, result, error,
       snapshots, worker_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      task.id,
      task.status,
      task.priority,
      task.category,
      task.instructions,
      task.parent ?? null,
      JSON.stringify(task.children),
      task.createdAt.toISOString(),
      task.updatedAt.toISOString(),
      task.startedAt?.toISOString() ?? null,
      task.completedAt?.toISOString() ?? null,
      task.result ? JSON.stringify(task.result) : null,
      task.error ? JSON.stringify(task.error) : null,
      JSON.stringify(task.snapshots),
      task.workerId ?? null,
      JSON.stringify(task.metadata),
    ]);
  }

  loadTasks(): TaskNode[] {
    if (!this.db) return [];

    const results = this.db.exec(`
      SELECT * FROM tasks ORDER BY created_at ASC
    `);

    if (results.length === 0 || !results[0]) return [];

    const columns = results[0].columns;
    const tasks: TaskNode[] = [];

    for (const row of results[0].values) {
      const task = this.rowToTask(columns, row);
      if (task) tasks.push(task);
    }

    return tasks;
  }

  loadTasksByStatus(status: TaskStatus): TaskNode[] {
    if (!this.db) return [];

    const stmt = this.db.prepare('SELECT * FROM tasks WHERE status = ?');
    stmt.bind([status]);

    const tasks: TaskNode[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      tasks.push(this.taskFromRow(row as Record<string, unknown>));
    }
    stmt.free();

    return tasks;
  }

  private rowToTask(columns: string[], row: unknown[]): TaskNode | null {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return this.taskFromRow(obj);
  }

  private taskFromRow(row: Record<string, unknown>): TaskNode {
    return {
      id: row['id'] as string,
      status: row['status'] as TaskStatus,
      priority: row['priority'] as number,
      category: row['category'] as TaskCategory,
      instructions: row['instructions'] as string,
      parent: row['parent'] as string | undefined,
      children: JSON.parse(row['children'] as string),
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
      startedAt: row['started_at'] ? new Date(row['started_at'] as string) : undefined,
      completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : undefined,
      result: row['result'] ? JSON.parse(row['result'] as string) : undefined,
      error: row['error'] ? JSON.parse(row['error'] as string) : undefined,
      snapshots: JSON.parse(row['snapshots'] as string),
      workerId: row['worker_id'] as string | undefined,
      metadata: JSON.parse(row['metadata'] as string),
    };
  }

  deleteTask(taskId: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
  }

  // ===========================================================================
  // Audit Log
  // ===========================================================================

  logAudit(entry: {
    level: string;
    category: string;
    taskId?: string;
    workerId?: string;
    message: string;
    details?: unknown;
    durationMs?: number;
  }): void {
    if (!this.db) return;

    this.db.run(`
      INSERT INTO audit_log
      (timestamp, level, category, task_id, worker_id, message, details, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      new Date().toISOString(),
      entry.level,
      entry.category,
      entry.taskId ?? null,
      entry.workerId ?? null,
      entry.message,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.durationMs ?? null,
    ]);
  }

  queryAudit(options: {
    taskId?: string;
    workerId?: string;
    level?: string;
    since?: Date;
    limit?: number;
  }): Array<{
    id: number;
    timestamp: Date;
    level: string;
    category: string;
    taskId?: string;
    workerId?: string;
    message: string;
    details?: unknown;
    durationMs?: number;
  }> {
    if (!this.db) return [];

    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (options.taskId) {
      sql += ' AND task_id = ?';
      params.push(options.taskId);
    }
    if (options.workerId) {
      sql += ' AND worker_id = ?';
      params.push(options.workerId);
    }
    if (options.level) {
      sql += ' AND level = ?';
      params.push(options.level);
    }
    if (options.since) {
      sql += ' AND timestamp >= ?';
      params.push(options.since.toISOString());
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(options.limit ?? 1000);

    const results = this.db.exec(sql, params);
    if (results.length === 0 || !results[0]) return [];

    const columns = results[0].columns;
    return results[0].values.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return {
        id: obj['id'] as number,
        timestamp: new Date(obj['timestamp'] as string),
        level: obj['level'] as string,
        category: obj['category'] as string,
        taskId: obj['task_id'] as string | undefined,
        workerId: obj['worker_id'] as string | undefined,
        message: obj['message'] as string,
        details: obj['details'] ? JSON.parse(obj['details'] as string) : undefined,
        durationMs: obj['duration_ms'] as number | undefined,
      };
    });
  }

  // ===========================================================================
  // Model Statistics
  // ===========================================================================

  recordModelUsage(stats: {
    modelId: string;
    provider: string;
    tokens: number;
    cost: number;
    durationMs: number;
    success: boolean;
  }): void {
    if (!this.db) return;

    this.db.run(`
      INSERT INTO model_stats
      (model_id, provider, total_calls, total_tokens, total_cost, total_duration_ms,
       success_count, failure_count, last_used)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(model_id) DO UPDATE SET
        total_calls = total_calls + 1,
        total_tokens = total_tokens + ?,
        total_cost = total_cost + ?,
        total_duration_ms = total_duration_ms + ?,
        success_count = success_count + ?,
        failure_count = failure_count + ?,
        last_used = CURRENT_TIMESTAMP
    `, [
      stats.modelId,
      stats.provider,
      stats.tokens,
      stats.cost,
      stats.durationMs,
      stats.success ? 1 : 0,
      stats.success ? 0 : 1,
      stats.tokens,
      stats.cost,
      stats.durationMs,
      stats.success ? 1 : 0,
      stats.success ? 0 : 1,
    ]);
  }

  getModelStats(): Array<{
    modelId: string;
    provider: string;
    totalCalls: number;
    totalTokens: number;
    totalCost: number;
    totalDurationMs: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgLatencyMs: number;
    lastUsed?: Date;
  }> {
    if (!this.db) return [];

    const results = this.db.exec('SELECT * FROM model_stats ORDER BY total_cost DESC');
    if (results.length === 0 || !results[0]) return [];

    const columns = results[0].columns;
    return results[0].values.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      const totalCalls = obj['total_calls'] as number;
      const successCount = obj['success_count'] as number;
      const totalDurationMs = obj['total_duration_ms'] as number;
      return {
        modelId: obj['model_id'] as string,
        provider: obj['provider'] as string,
        totalCalls,
        totalTokens: obj['total_tokens'] as number,
        totalCost: obj['total_cost'] as number,
        totalDurationMs,
        successCount,
        failureCount: obj['failure_count'] as number,
        successRate: totalCalls > 0 ? successCount / totalCalls : 0,
        avgLatencyMs: totalCalls > 0 ? totalDurationMs / totalCalls : 0,
        lastUsed: obj['last_used'] ? new Date(obj['last_used'] as string) : undefined,
      };
    });
  }

  // ===========================================================================
  // Cost Budget
  // ===========================================================================

  setCostBudget(id: string, type: 'daily' | 'monthly', limit: number, start: Date, end: Date): void {
    if (!this.db) return;

    this.db.run(`
      INSERT OR REPLACE INTO cost_budget
      (id, budget_type, limit_amount, current_spend, period_start, period_end)
      VALUES (?, ?, ?, 0, ?, ?)
    `, [id, type, limit, start.toISOString(), end.toISOString()]);
  }

  recordSpend(budgetId: string, amount: number): void {
    if (!this.db) return;

    this.db.run(`
      UPDATE cost_budget SET current_spend = current_spend + ?
      WHERE id = ? AND current_spend + ? <= limit_amount
    `, [amount, budgetId, amount]);
  }

  getBudgetStatus(budgetId: string): {
    id: string;
    budgetType: string;
    limit: number;
    currentSpend: number;
    remaining: number;
    periodStart: Date;
    periodEnd: Date;
    overBudget: boolean;
  } | null {
    if (!this.db) return null;

    const stmt = this.db.prepare('SELECT * FROM cost_budget WHERE id = ?');
    stmt.bind([budgetId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    const limit = row['limit_amount'] as number;
    const spend = row['current_spend'] as number;

    return {
      id: row['id'] as string,
      budgetType: row['budget_type'] as string,
      limit,
      currentSpend: spend,
      remaining: Math.max(0, limit - spend),
      periodStart: new Date(row['period_start'] as string),
      periodEnd: new Date(row['period_end'] as string),
      overBudget: spend > limit,
    };
  }

  // ===========================================================================
  // Persistence Control
  // ===========================================================================

  save(): void {
    if (!this.db) return;
    this.pending.clear();
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  close(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    this.save();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getStats(): {
    tasks: number;
    auditEntries: number;
    modelStats: number;
    budgets: number;
    dbPath: string;
  } {
    if (!this.db) {
      return { tasks: 0, auditEntries: 0, modelStats: 0, budgets: 0, dbPath: this.dbPath };
    }

    const taskCount = this.db.exec('SELECT COUNT(*) FROM tasks')[0]?.values[0]?.[0] ?? 0;
    const auditCount = this.db.exec('SELECT COUNT(*) FROM audit_log')[0]?.values[0]?.[0] ?? 0;
    const modelCount = this.db.exec('SELECT COUNT(*) FROM model_stats')[0]?.values[0]?.[0] ?? 0;
    const budgetCount = this.db.exec('SELECT COUNT(*) FROM cost_budget')[0]?.values[0]?.[0] ?? 0;

    return {
      tasks: taskCount as number,
      auditEntries: auditCount as number,
      modelStats: modelCount as number,
      budgets: budgetCount as number,
      dbPath: this.dbPath,
    };
  }
}
