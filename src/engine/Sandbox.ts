// ============================================================================
// Security Sandbox - Command whitelist, file snapshots, rollback
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  SandboxConfig,
  FileSnapshot,
  SandboxResult,
  BlockedPattern,
} from '../types';

const execAsync = promisify(exec);

export class Sandbox {
  private config: SandboxConfig;
  private snapshots: Map<string, FileSnapshot> = new Map();
  private commandHistory: { cmd: string; allowed: boolean; ts: Date }[] = [];

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  // ===========================================================================
  // Command Validation
  // ===========================================================================

  /**
   * Check if a command is allowed to execute
   */
  isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();

    // Check against blocked regex patterns
    for (const blocked of this.config.blockedPatterns) {
      const regex = new RegExp(blocked.pattern, 'i');
      if (regex.test(trimmed)) {
        return {
          allowed: false,
          reason: `Blocked pattern detected: ${blocked.description} (${blocked.severity})`,
        };
      }
    }

    // Extract the base command
    const baseCmd = this.extractBaseCommand(trimmed).toLowerCase();

    // Check if in allowed list
    if (!this.config.allowedCommands.includes(baseCmd)) {
      // Allow if it's a path-based command that matches allowed
      const allowedWithPath = this.config.allowedCommands.some(
        allowed => trimmed.startsWith(allowed + ' ') || trimmed.startsWith(allowed + '/')
      );
      if (!allowedWithPath) {
        return {
          allowed: false,
          reason: `Command '${baseCmd}' is not in the allowed list`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Extract the base command (first word/token)
   */
  private extractBaseCommand(command: string): string {
    // Handle compound commands like "git commit -m"
    const parts = command.split(/\s+/);
    return parts[0].replace(/^[/\\]*/, '').split(path.sep).pop() ?? parts[0];
  }

  // ===========================================================================
  // File Snapshots
  // ===========================================================================

  /**
   * Create a snapshot of a file before modification
   */
  async createSnapshot(filePath: string): Promise<string | null> {
    try {
      // Resolve the absolute path
      const absolutePath = path.resolve(filePath);

      // Check if file exists
      if (!fs.existsSync(absolutePath)) {
        return null;
      }

      // Check file size
      const stats = fs.statSync(absolutePath);
      if (stats.size > this.config.maxFileSize) {
        throw new Error(`File too large: ${stats.size} > ${this.config.maxFileSize}`);
      }

      // Read content
      const content = fs.readFileSync(absolutePath, 'utf-8');

      // Calculate hash
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      // Create snapshot
      const snapshotId = uuidv4();
      const snapshot: FileSnapshot = {
        id: snapshotId,
        taskId: '',
        path: absolutePath,
        content,
        hash,
        createdAt: new Date(),
        size: stats.size,
      };

      this.snapshots.set(snapshotId, snapshot);

      // Cleanup old snapshots if over retention limit
      this.cleanupSnapshots();

      return snapshotId;
    } catch (error) {
      console.error(`Failed to create snapshot for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Restore a file from a snapshot
   */
  async restoreSnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      console.error(`Snapshot not found: ${snapshotId}`);
      return false;
    }

    try {
      fs.writeFileSync(snapshot.path, snapshot.content, 'utf-8');
      return true;
    } catch (error) {
      console.error(`Failed to restore snapshot ${snapshotId}:`, error);
      return false;
    }
  }

  /**
   * Create snapshots for multiple files
   */
  async snapshotMultiple(filePaths: string[]): Promise<string[]> {
    const results = await Promise.all(
      filePaths.map(p => this.createSnapshot(p))
    );
    return results.filter((id): id is string => id !== null);
  }

  /**
   * Cleanup old snapshots to respect retention limit
   */
  private cleanupSnapshots(): void {
    if (this.snapshots.size > this.config.snapshotRetention) {
      const sorted = Array.from(this.snapshots.entries())
        .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());

      const toDelete = sorted.slice(0, this.snapshots.size - this.config.snapshotRetention);
      for (const [id] of toDelete) {
        this.snapshots.delete(id);
      }
    }
  }

  // ===========================================================================
  // Command Execution
  // ===========================================================================

  /**
   * Execute a command in the sandbox
   */
  async execute(command: string, cwd: string): Promise<SandboxResult> {
    const startTime = Date.now();
    const check = this.isCommandAllowed(command);

    this.commandHistory.push({
      cmd: command,
      allowed: check.allowed,
      ts: new Date(),
    });

    if (!check.allowed) {
      return {
        success: false,
        stdout: '',
        stderr: check.reason ?? 'Command not allowed',
        exitCode: 1,
        duration: Date.now() - startTime,
        filesChanged: [],
        blockedCommands: [command],
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: this.config.timeoutSeconds * 1000,
        maxBuffer: this.config.memoryLimitMB * 1024 * 1024,
        windowsHide: true,
      });

      return {
        success: true,
        stdout: stdout.slice(0, 100000), // Cap at 100KB
        stderr: stderr.slice(0, 100000),
        exitCode: 0,
        duration: Date.now() - startTime,
        filesChanged: this.detectFileChanges(command),
        blockedCommands: [],
      };
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string; stdout?: string; stderr?: string };
      return {
        success: false,
        stdout: err.stdout?.slice(0, 100000) ?? '',
        stderr: err.message?.slice(0, 100000) ?? '',
        exitCode: err.code ?? 1,
        duration: Date.now() - startTime,
        filesChanged: [],
        blockedCommands: [],
      };
    }
  }

  /**
   * Detect which files a command might have changed
   */
  private detectFileChanges(command: string): string[] {
    const patterns = [
      /(?:>>?|2>\s*>?)\s*([^\s]+)/g,           // Redirections
      /(?:cp|mv|rm|touch|mkdir)\s+(?:[^\s]+\s+)*([^\s]+(?:\s+[^\s]+)?)/g,
    ];

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = command.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) files.push(match[1]);
      }
    }
    return [...new Set(files)];
  }

  // ===========================================================================
  // Audit
  // ===========================================================================

  /**
   * Get command execution history
   */
  getHistory(limit: number = 100): { cmd: string; allowed: boolean; ts: Date }[] {
    return this.commandHistory.slice(-limit);
  }

  /**
   * Get recent blocked commands
   */
  getBlockedCommands(): string[] {
    return this.commandHistory
      .filter(h => !h.allowed)
      .map(h => h.cmd);
  }

  /**
   * Get snapshot statistics
   */
  getSnapshotStats(): { count: number; totalSize: number; oldest: Date | null } {
    const snapshots = Array.from(this.snapshots.values());
    return {
      count: snapshots.length,
      totalSize: snapshots.reduce((sum, s) => sum + s.size, 0),
      oldest: snapshots.length > 0 ? snapshots[0].createdAt : null,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
