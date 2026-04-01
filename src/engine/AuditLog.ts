// ============================================================================
// AuditLog - Persistent, structured audit logging with persistence
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { Persistence } from './Persistence';

export enum AuditLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export enum AuditCategory {
  TASK = 'task',
  COMMAND = 'command',
  MODEL = 'model',
  SECURITY = 'security',
  SANDBOX = 'sandbox',
  SYSTEM = 'system',
  COST = 'cost',
  FILE = 'file',
}

export interface AuditEntry {
  id?: number;
  timestamp: Date;
  level: AuditLevel;
  category: AuditCategory;
  taskId?: string;
  workerId?: string;
  message: string;
  details?: unknown;
  durationMs?: number;
  userId?: string;
  ipAddress?: string;
  sessionId?: string;
}

export interface AuditQuery {
  since?: Date;
  until?: Date;
  levels?: AuditLevel[];
  categories?: AuditCategory[];
  taskId?: string;
  workerId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditReport {
  generatedAt: Date;
  period: { start: Date; end: Date };
  summary: {
    totalEntries: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
    uniqueTasks: number;
    uniqueWorkers: number;
  };
  securityEvents: AuditEntry[];
  costEvents: AuditEntry[];
  taskSummary: {
    totalTasks: number;
    completed: number;
    failed: number;
    totalDuration: number;
    avgDuration: number;
  };
  topErrors: Array<{ message: string; count: number; lastSeen: Date }>;
}

export class AuditLog {
  private persistence: Persistence;
  private fileLogger?: fs.WriteStream;
  private logDir: string;
  private sessionId: string;
  private buffer: AuditEntry[] = [];
  private flushInterval?: NodeJS.Timeout;
  private readonly BUFFER_SIZE = 50;
  private readonly FLUSH_INTERVAL_MS = 5000;

  constructor(persistence: Persistence, logDir?: string, sessionId?: string) {
    this.persistence = persistence;
    this.logDir = logDir ?? path.join(process.cwd(), 'data', 'audit');
    this.sessionId = sessionId ?? `session-${Date.now()}`;

    this.ensureLogDir();
    this.initFileLogger();
    this.startFlushInterval();
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private initFileLogger(): void {
    const logFile = path.join(
      this.logDir,
      `audit-${new Date().toISOString().slice(0, 10)}.log`
    );

    this.fileLogger = fs.createWriteStream(logFile, { flags: 'a' });
    this.fileLogger.write(
      JSON.stringify({
        type: 'session_start',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        version: '1.0',
      }) + '\n'
    );
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.FLUSH_INTERVAL_MS);
  }

  // ===========================================================================
  // Logging
  // ===========================================================================

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date(),
      sessionId: this.sessionId,
    };

    // Write to buffer
    this.buffer.push(fullEntry);

    // Write to file (immediate for important events)
    this.writeToFile(fullEntry);

    // Flush if buffer is full
    if (this.buffer.length >= this.BUFFER_SIZE) {
      this.flush();
    }
  }

  debug(category: AuditCategory, message: string, details?: unknown): void {
    this.log({ level: AuditLevel.DEBUG, category, message, details });
  }

  info(category: AuditCategory, message: string, details?: unknown): void {
    this.log({ level: AuditLevel.INFO, category, message, details });
  }

  warn(category: AuditCategory, message: string, details?: unknown): void {
    this.log({ level: AuditLevel.WARN, category, message, details });
  }

  error(category: AuditCategory, message: string, details?: unknown, durationMs?: number): void {
    this.log({ level: AuditLevel.ERROR, category, message, details, durationMs });
  }

  critical(category: AuditCategory, message: string, details?: unknown, durationMs?: number): void {
    this.log({ level: AuditLevel.CRITICAL, category, message, details, durationMs });
  }

  // Security events
  security(message: string, details?: unknown): void {
    this.log({ level: AuditLevel.WARN, category: AuditCategory.SECURITY, message, details });
  }

  securityCritical(message: string, details?: unknown): void {
    this.log({ level: AuditLevel.CRITICAL, category: AuditCategory.SECURITY, message, details });
  }

  // Task events
  taskStart(taskId: string, workerId: string, instructions: string): void {
    this.log({
      level: AuditLevel.INFO,
      category: AuditCategory.TASK,
      taskId,
      workerId,
      message: `Task started: ${instructions.slice(0, 100)}`,
      details: { instructions },
    });
  }

  taskComplete(taskId: string, workerId: string, durationMs: number, filesChanged: string[]): void {
    this.log({
      level: AuditLevel.INFO,
      category: AuditCategory.TASK,
      taskId,
      workerId,
      message: `Task completed in ${durationMs}ms, ${filesChanged.length} files changed`,
      details: { filesChanged },
      durationMs,
    });
  }

  taskFail(taskId: string, workerId: string, error: string, durationMs?: number): void {
    this.log({
      level: AuditLevel.ERROR,
      category: AuditCategory.TASK,
      taskId,
      workerId,
      message: `Task failed: ${error.slice(0, 200)}`,
      details: { error },
      durationMs,
    });
  }

  // Command events
  commandAllowed(workerId: string, command: string): void {
    this.debug(AuditCategory.COMMAND, `Allowed: ${command}`, { workerId, command });
  }

  commandBlocked(workerId: string, command: string, reason: string): void {
    this.log({
      level: AuditLevel.WARN,
      category: AuditCategory.COMMAND,
      workerId,
      message: `Blocked: ${command} - ${reason}`,
      details: { command, reason },
    });
  }

  // Model events
  modelCall(modelId: string, provider: string, tokens: number, cost: number, latencyMs: number, success: boolean): void {
    this.log({
      level: AuditLevel.INFO,
      category: AuditCategory.MODEL,
      message: `Model ${modelId} (${provider}): ${tokens} tokens, $${cost.toFixed(4)}, ${latencyMs}ms, ${success ? 'success' : 'failed'}`,
      details: { modelId, provider, tokens, cost, latencyMs, success },
      durationMs: latencyMs,
    });
  }

  // Cost events
  costBudgetWarning(type: 'daily' | 'monthly', percentUsed: number, remaining: number): void {
    this.log({
      level: AuditLevel.WARN,
      category: AuditCategory.COST,
      message: `${type} budget at ${(percentUsed * 100).toFixed(1)}%, $${remaining.toFixed(2)} remaining`,
      details: { type, percentUsed, remaining },
    });
  }

  costBudgetExceeded(type: 'daily' | 'monthly'): void {
    this.log({
      level: AuditLevel.ERROR,
      category: AuditCategory.COST,
      message: `${type} budget EXCEEDED - automatic model降级 triggered`,
      details: { type },
    });
  }

  // File events
  fileChanged(taskId: string, path: string, action: 'create' | 'modify' | 'delete', snapshotId?: string): void {
    this.log({
      level: AuditLevel.INFO,
      category: AuditCategory.FILE,
      taskId,
      message: `File ${action}: ${path}${snapshotId ? ` (snapshot: ${snapshotId})` : ''}`,
      details: { path, action, snapshotId },
    });
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  private writeToFile(entry: AuditEntry): void {
    if (!this.fileLogger) return;

    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    });

    this.fileLogger.write(line + '\n');

    // Also persist to SQLite for queryability
    this.persistence.logAudit({
      level: entry.level,
      category: entry.category,
      taskId: entry.taskId,
      workerId: entry.workerId,
      message: entry.message,
      details: entry.details,
      durationMs: entry.durationMs,
    });
  }

  private flush(): void {
    // Write buffered entries to file
    if (this.buffer.length > 0 && this.fileLogger) {
      for (const entry of this.buffer) {
        const line = JSON.stringify({
          ...entry,
          timestamp: entry.timestamp.toISOString(),
        });
        this.fileLogger.write(line + '\n');
      }
      this.buffer = [];
    }
  }

  // ===========================================================================
  // Querying
  // ===========================================================================

  query(options: AuditQuery = {}): AuditEntry[] {
    const results = this.persistence.queryAudit({
      taskId: options.taskId,
      workerId: options.workerId,
      level: options.levels?.[0],
      since: options.since,
      limit: options.limit ?? 100,
    });

    return results.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level as AuditLevel,
      category: r.category as AuditCategory,
      taskId: r.taskId,
      workerId: r.workerId,
      message: r.message,
      details: r.details,
      durationMs: r.durationMs,
      sessionId: this.sessionId,
    }));
  }

  getSecurityEvents(since?: Date): AuditEntry[] {
    return this.query({
      since,
      categories: [AuditCategory.SECURITY],
      levels: [AuditLevel.WARN, AuditLevel.ERROR, AuditLevel.CRITICAL],
    });
  }

  getTaskHistory(taskId: string): AuditEntry[] {
    return this.query({ taskId });
  }

  getWorkerHistory(workerId: string, limit: number = 100): AuditEntry[] {
    return this.query({ workerId, limit });
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  generateReport(since: Date, until: Date = new Date()): AuditReport {
    const entries = this.query({
      since,
      until,
      limit: 10000,
    });

    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const taskIds = new Set<string>();
    const workerIds = new Set<string>();
    const taskDurations: number[] = [];
    const completedTasks = entries.filter(
      e => e.category === AuditCategory.TASK && e.message.includes('completed')
    ).length;
    const failedTasks = entries.filter(
      e => e.category === AuditCategory.TASK && e.message.includes('failed')
    ).length;

    for (const entry of entries) {
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      if (entry.taskId) taskIds.add(entry.taskId);
      if (entry.workerId) workerIds.add(entry.workerId);
      if (entry.durationMs && entry.category === AuditCategory.TASK) {
        taskDurations.push(entry.durationMs);
      }
    }

    // Top errors
    const errorMessages = entries
      .filter(e => e.level === AuditLevel.ERROR || e.level === AuditLevel.CRITICAL)
      .map(e => e.message);
    const errorCounts: Record<string, { count: number; lastSeen: Date }> = {};
    for (const msg of errorMessages) {
      if (!errorCounts[msg]) errorCounts[msg] = { count: 0, lastSeen: new Date(0) };
      errorCounts[msg].count++;
    }

    const topErrors = Object.entries(errorCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([message, data]) => ({ message, count: data.count, lastSeen: data.lastSeen }));

    const totalDuration = taskDurations.reduce((a, b) => a + b, 0);

    return {
      generatedAt: new Date(),
      period: { start: since, end: until },
      summary: {
        totalEntries: entries.length,
        byLevel,
        byCategory,
        uniqueTasks: taskIds.size,
        uniqueWorkers: workerIds.size,
      },
      securityEvents: this.getSecurityEvents(since),
      costEvents: this.query({ since, categories: [AuditCategory.COST] }),
      taskSummary: {
        totalTasks: taskIds.size,
        completed: completedTasks,
        failed: failedTasks,
        totalDuration,
        avgDuration: taskDurations.length > 0 ? totalDuration / taskDurations.length : 0,
      },
      topErrors,
    };
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  exportToJSON(filePath?: string): string {
    const entries = this.query({ limit: 100000 });
    const json = JSON.stringify(entries, null, 2);

    if (filePath) {
      fs.writeFileSync(filePath, json, 'utf-8');
    }

    return json;
  }

  exportToCSV(filePath: string): void {
    const entries = this.query({ limit: 100000 });

    const headers = ['timestamp', 'level', 'category', 'taskId', 'workerId', 'message', 'durationMs'];
    const lines = [
      headers.join(','),
      ...entries.map(e =>
        [
          e.timestamp.toISOString(),
          e.level,
          e.category,
          e.taskId ?? '',
          e.workerId ?? '',
          `"${e.message.replace(/"/g, '""')}"`,
          e.durationMs?.toString() ?? '',
        ].join(',')
      ),
    ];

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  close(): void {
    this.flush();

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    if (this.fileLogger) {
      this.fileLogger.write(
        JSON.stringify({
          type: 'session_end',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
      this.fileLogger.end();
    }
  }

  cleanupOldLogs(retentionDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let deleted = 0;
    const files = fs.readdirSync(this.logDir);

    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = path.join(this.logDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtime < cutoff) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    return deleted;
  }
}
