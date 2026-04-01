// ============================================================================
// Docker Sandbox - Container-level isolation for command execution
// ============================================================================

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { SandboxConfig, FileSnapshot, SandboxResult } from '../types';

const execAsync = promisify(exec);

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  createdAt: Date;
  status: 'running' | 'stopped';
  taskId?: string;
}

export class DockerSandbox {
  private config: SandboxConfig;
  private containers: Map<string, DockerContainer> = new Map();
  private snapshots: Map<string, FileSnapshot> = new Map();
  private dockerAvailable: boolean | null = null;
  private defaultImage: string = 'ubuntu:22.04';

  constructor(config: SandboxConfig) {
    this.config = config;
    this.checkDockerAvailability();
  }

  // ===========================================================================
  // Docker Availability Check
  // ===========================================================================

  private async checkDockerAvailability(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;

    try {
      await execAsync('docker info', { timeout: 5000 });
      this.dockerAvailable = true;
      console.log('[DockerSandbox] Docker is available');
    } catch {
      this.dockerAvailable = false;
      console.warn('[DockerSandbox] Docker is not available, falling back to exec sandbox');
    }

    return this.dockerAvailable;
  }

  private async ensureDocker(): Promise<boolean> {
    if (this.dockerAvailable === null) {
      await this.checkDockerAvailability();
    }
    return this.dockerAvailable ?? false;
  }

  // ===========================================================================
  // Container Lifecycle
  // ===========================================================================

  /**
   * Create a new isolated container for a task
   */
  async createContainer(taskId: string, options: {
    image?: string;
    memoryLimit?: string;
    cpuLimit?: number;
    networkMode?: 'bridge' | 'none' | 'host';
    readonlyRootfs?: boolean;
  } = {}): Promise<DockerContainer | null> {
    const dockerOk = await this.ensureDocker();
    if (!dockerOk) {
      console.warn('[DockerSandbox] Cannot create container: Docker unavailable');
      return null;
    }

    const containerId = `agent-${taskId.slice(0, 8)}-${uuidv4().slice(0, 8)}`;
    const image = options.image ?? this.defaultImage;
    const memoryLimit = options.memoryLimit ?? '512m';
    const cpuLimit = options.cpuLimit ?? 1.0;
    const networkMode = options.networkMode ?? 'none';

    try {
      // Pull image if needed
      try {
        await execAsync(`docker pull ${image}`, { timeout: 120000 });
      } catch {
        // Image might already exist
      }

      // Create and start container
      const cmd = [
        'docker', 'run', '-d',
        '--name', containerId,
        '--rm', // Auto-remove when stopped
        '--memory', memoryLimit,
        '--cpus', cpuLimit.toString(),
        '--network', networkMode,
        '--read-only', options.readonlyRootfs ? 'true' : 'false',
        '--user', '1000:1000', // Non-root user
        '--pids-limit', '100',
        '--security-opt', 'no-new-privileges',
        image,
        'sleep', '3600', // Keep container alive
      ];

      const { stdout } = await execAsync(cmd.join(' '), { timeout: 30000 });
      const dockerId = stdout.trim();

      const container: DockerContainer = {
        id: dockerId,
        name: containerId,
        image,
        createdAt: new Date(),
        status: 'running',
        taskId,
      };

      this.containers.set(containerId, container);
      console.log(`[DockerSandbox] Created container ${containerId} for task ${taskId}`);

      return container;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to create container:`, error);
      return null;
    }
  }

  /**
   * Stop and remove a container
   */
  async destroyContainer(containerId: string): Promise<boolean> {
    try {
      await execAsync(`docker stop ${containerId}`, { timeout: 10000 });
      this.containers.delete(containerId);
      console.log(`[DockerSandbox] Destroyed container ${containerId}`);
      return true;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to destroy container ${containerId}:`, error);
      // Force remove if still exists
      try {
        await execAsync(`docker rm -f ${containerId}`, { timeout: 5000 });
        this.containers.delete(containerId);
      } catch {
        // Ignore
      }
      return false;
    }
  }

  /**
   * Get container logs
   */
  async getContainerLogs(containerId: string, lines: number = 50): Promise<string> {
    try {
      const { stdout } = await execAsync(`docker logs --tail ${lines} ${containerId}`, { timeout: 5000 });
      return stdout;
    } catch {
      return '';
    }
  }

  // ===========================================================================
  // Command Execution in Container
  // ===========================================================================

  /**
   * Execute a command inside a container
   */
  async executeInContainer(
    containerId: string,
    command: string,
    cwd: string = '/workspace',
    timeoutSeconds?: number
  ): Promise<SandboxResult> {
    const startTime = Date.now();
    const timeout = timeoutSeconds ?? this.config.timeoutSeconds;

    // Validate command first
    const check = this.isCommandAllowed(command);
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
      // Escape command for Docker exec
      const escapedCmd = command.replace(/'/g, "'\\''");

      // Execute inside container
      const { stdout, stderr } = await execAsync(
        `docker exec ${containerId} sh -c 'cd ${cwd} && ${escapedCmd}'`,
        {
          timeout: timeout * 1000,
          maxBuffer: this.config.memoryLimitMB * 1024 * 1024,
        }
      );

      return {
        success: true,
        stdout: stdout.slice(0, 100000),
        stderr: stderr.slice(0, 100000),
        exitCode: 0,
        duration: Date.now() - startTime,
        filesChanged: [],
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

  // ===========================================================================
  // Workspace Management
  // ===========================================================================

  /**
   * Copy files into a container's workspace
   */
  async copyToWorkspace(containerId: string, hostPath: string, containerPath: string = '/workspace'): Promise<boolean> {
    try {
      await execAsync(`docker cp ${hostPath} ${containerId}:${containerPath}`, { timeout: 30000 });
      return true;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to copy to container:`, error);
      return false;
    }
  }

  /**
   * Copy files from container workspace to host
   */
  async copyFromWorkspace(containerId: string, containerPath: string, hostPath: string): Promise<boolean> {
    try {
      await execAsync(`docker cp ${containerId}:${containerPath} ${hostPath}`, { timeout: 30000 });
      return true;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to copy from container:`, error);
      return false;
    }
  }

  // ===========================================================================
  // File Snapshots (Host-side for recovery)
  // ===========================================================================

  /**
   * Create a snapshot of a directory before modifications
   */
  async createDirectorySnapshot(hostPath: string, taskId: string): Promise<string | null> {
    try {
      const snapshotDir = path.join(process.cwd(), 'data', 'snapshots', taskId);
      if (!fs.existsSync(snapshotDir)) {
        fs.mkdirSync(snapshotDir, { recursive: true });
      }

      const snapshotId = uuidv4();
      const snapshotPath = path.join(snapshotDir, `${snapshotId}.tar.gz`);

      // Create tar archive of the directory
      execSync(`tar -czf "${snapshotPath}" -C "${path.dirname(hostPath)}" "${path.basename(hostPath)}"`, {
        timeout: 30000,
      });

      const stats = fs.statSync(snapshotPath);

      const snapshot: FileSnapshot = {
        id: snapshotId,
        taskId,
        path: hostPath,
        content: snapshotPath, // Store path to tar, not content
        hash: crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex'),
        createdAt: new Date(),
        size: stats.size,
      };

      this.snapshots.set(snapshotId, snapshot);
      console.log(`[DockerSandbox] Created snapshot ${snapshotId} for ${hostPath} (${stats.size} bytes)`);

      return snapshotId;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to create snapshot:`, error);
      return null;
    }
  }

  /**
   * Restore a directory from a snapshot
   */
  async restoreDirectorySnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      console.error(`[DockerSandbox] Snapshot not found: ${snapshotId}`);
      return false;
    }

    try {
      const tempDir = path.join(process.cwd(), 'data', 'snapshots', '__temp_restore__');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Extract to temp
      execSync(`tar -xzf "${snapshot.content}" -C "${tempDir}"`, { timeout: 30000 });

      // Get the extracted directory name
      const extractedEntries = fs.readdirSync(tempDir);
      if (extractedEntries.length === 0) {
        throw new Error('Extracted directory is empty');
      }

      // Copy to original location
      const extractedPath = path.join(tempDir, extractedEntries[0]);
      const targetPath = snapshot.path;

      // Backup current state
      const backupPath = targetPath + '.bak';
      if (fs.existsSync(targetPath)) {
        execSync(`mv "${targetPath}" "${backupPath}"`);
      }

      execSync(`mv "${extractedPath}" "${targetPath}"`);

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });

      console.log(`[DockerSandbox] Restored snapshot ${snapshotId} to ${targetPath}`);
      return true;
    } catch (error) {
      console.error(`[DockerSandbox] Failed to restore snapshot:`, error);
      return false;
    }
  }

  // ===========================================================================
  // Command Validation (same as Sandbox)
  // ===========================================================================

  isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();

    for (const blocked of this.config.blockedPatterns) {
      const regex = new RegExp(blocked.pattern, 'i');
      if (regex.test(trimmed)) {
        return {
          allowed: false,
          reason: `Blocked pattern: ${blocked.description} (${blocked.severity})`,
        };
      }
    }

    const baseCmd = this.extractBaseCommand(trimmed).toLowerCase();
    if (!this.config.allowedCommands.includes(baseCmd)) {
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

  private extractBaseCommand(command: string): string {
    const parts = command.split(/\s+/);
    return parts[0].replace(/^[/\\]*/, '').split(path.sep).pop() ?? parts[0];
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Get all active containers
   */
  getActiveContainers(): DockerContainer[] {
    return Array.from(this.containers.values()).filter(c => c.status === 'running');
  }

  /**
   * Get snapshot statistics
   */
  getSnapshotStats(): { count: number; totalSize: number } {
    let totalSize = 0;
    for (const snapshot of this.snapshots.values()) {
      totalSize += snapshot.size;
    }
    return {
      count: this.snapshots.size,
      totalSize,
    };
  }

  /**
   * Cleanup old containers and snapshots
   */
  async cleanup(): Promise<void> {
    // Stop all running containers
    for (const container of this.containers.values()) {
      if (container.status === 'running') {
        await this.destroyContainer(container.id);
      }
    }

    // Cleanup snapshot directory
    const snapshotDir = path.join(process.cwd(), 'data', 'snapshots');
    if (fs.existsSync(snapshotDir)) {
      try {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }
}
