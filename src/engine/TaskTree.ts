// ============================================================================
// TaskTree - Hierarchical task management with rollback/undo support
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { TaskNode, TaskStatus, TaskResult, TaskError, TaskPriority, TaskCategory } from '../types';
import { Sandbox } from './Sandbox';

export class TaskTree {
  private tasks: Map<string, TaskNode> = new Map();
  private rootTasks: Set<string> = new Set();
  private sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Create a new task node
   */
  createTask(
    instructions: string,
    options: {
      parent?: string;
      priority?: TaskPriority;
      category?: TaskCategory;
      metadata?: Record<string, unknown>;
    } = {}
  ): TaskNode {
    const id = uuidv4();
    const now = new Date();

    const task: TaskNode = {
      id,
      status: TaskStatus.PENDING,
      priority: options.priority ?? TaskPriority.NORMAL,
      category: options.category ?? TaskCategory.GENERAL,
      instructions,
      parent: options.parent,
      children: [],
      createdAt: now,
      updatedAt: now,
      snapshots: [],
      metadata: options.metadata ?? {},
    };

    this.tasks.set(id, task);

    if (options.parent) {
      const parent = this.tasks.get(options.parent);
      if (parent) {
        parent.children.push(id);
      }
    } else {
      this.rootTasks.add(id);
    }

    return task;
  }

  /**
   * Update task status
   */
  updateStatus(id: string, status: TaskStatus, result?: TaskResult, error?: TaskError): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    task.status = status;
    task.updatedAt = new Date();

    if (status === TaskStatus.RUNNING) {
      task.startedAt = new Date();
    }

    if (status === TaskStatus.COMPLETED && result) {
      task.result = result;
      task.completedAt = new Date();
    }

    if (status === TaskStatus.FAILED && error) {
      task.error = error;
    }

    // Propagate status to children if needed
    if (status === TaskStatus.FAILED && task.children.length > 0) {
      this.propagateStatus(task.id, TaskStatus.CANCELLED);
    }

    return true;
  }

  /**
   * Propagate status changes to child tasks
   */
  private propagateStatus(parentId: string, status: TaskStatus): void {
    const parent = this.tasks.get(parentId);
    if (!parent) return;

    for (const childId of parent.children) {
      const child = this.tasks.get(childId);
      if (child && child.status === TaskStatus.PENDING) {
        child.status = status;
        child.updatedAt = new Date();
        this.propagateStatus(childId, status);
      }
    }
  }

  /**
   * Add a snapshot to a task before making changes
   */
  async snapshot(taskId: string, paths: string[]): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    for (const path of paths) {
      const snapshotId = await this.sandbox.createSnapshot(path);
      if (snapshotId) {
        task.snapshots.push(snapshotId);
      }
    }
  }

  /**
   * Rollback a task to its last successful state
   */
  async rollback(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.snapshots.length === 0) {
      return false;
    }

    const lastSnapshotId = task.snapshots[task.snapshots.length - 1];
    const success = await this.sandbox.restoreSnapshot(lastSnapshotId);

    if (success) {
      task.status = TaskStatus.ROLLED_BACK;
      task.updatedAt = new Date();
    }

    return success;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): TaskNode | undefined {
    return this.tasks.get(id);
  }

  /**
   * List all tasks filtered by status
   */
  listByStatus(status: TaskStatus): TaskNode[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  /**
   * List all root tasks (no parent)
   */
  listRootTasks(): TaskNode[] {
    return Array.from(this.rootTasks).map(id => this.tasks.get(id)!).filter(Boolean);
  }

  /**
   * Get all tasks as an array
   */
  getAllTasks(): TaskNode[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Restore a batch of tasks from persistence
   */
  restoreTasks(tasks: TaskNode[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      if (task.parent) {
        const parent = this.tasks.get(task.parent);
        if (parent && !parent.children.includes(task.id)) {
          parent.children.push(task.id);
        }
      } else {
        this.rootTasks.add(task.id);
      }
    }
  }

  /**
   * Get task tree as a printable structure
   */
  printTree(rootId?: string, depth: number = 0): string {
    const roots = rootId ? [this.tasks.get(rootId)!].filter(Boolean) : this.listRootTasks();
    let output = '';

    for (const task of roots) {
      const indent = '  '.repeat(depth);
      const statusIcon = this.getStatusIcon(task.status);
      const truncated = task.instructions.slice(0, 60) + (task.instructions.length > 60 ? '...' : '');
      output += `${indent}${statusIcon} [${task.id.slice(0, 8)}] ${truncated}\n`;

      for (const childId of task.children) {
        const child = this.tasks.get(childId);
        if (child) {
          output += this.printTree(child.id, depth + 1);
        }
      }
    }

    return output;
  }

  private getStatusIcon(status: TaskStatus): string {
    switch (status) {
      case TaskStatus.PENDING: return '⏳';
      case TaskStatus.RUNNING: return '🔄';
      case TaskStatus.COMPLETED: return '✅';
      case TaskStatus.FAILED: return '❌';
      case TaskStatus.ROLLED_BACK: return '↩️';
      case TaskStatus.CANCELLED: return '🚫';
      case TaskStatus.PAUSED: return '⏸️';
      default: return '❓';
    }
  }

  /**
   * Get statistics about the task tree
   */
  getStats(): {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byPriority: Record<TaskPriority, number>;
    averageDuration: number;
  } {
    const tasks = this.getAllTasks();
    const completed = tasks.filter(t => t.status === TaskStatus.COMPLETED && t.result);

    const byStatus = {} as Record<TaskStatus, number>;
    const byPriority = {} as Record<TaskPriority, number>;
    let totalDuration = 0;

    for (const task of tasks) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
    }

    for (const task of completed) {
      if (task.result) {
        totalDuration += task.result.duration;
      }
    }

    return {
      total: tasks.length,
      byStatus,
      byPriority,
      averageDuration: completed.length > 0 ? totalDuration / completed.length : 0,
    };
  }
}
