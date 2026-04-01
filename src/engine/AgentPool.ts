// ============================================================================
// Agent Pool - Multi-worker parallel task execution
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import {
  WorkerStatus,
  AgentPoolConfig,
  TaskNode,
  TaskResult,
  ModelProvider,
} from '../types';
import { ModelRouter } from '../orchestrator/ModelRouter';
import { TaskTree } from './TaskTree';
import { TaskStatus } from '../types';

interface Worker {
  id: string;
  status: WorkerStatus;
  taskQueue: string[];
  currentTaskId?: string;
  model: ModelProvider;
}

export class AgentPool {
  private workers: Map<string, Worker> = new Map();
  private config: AgentPoolConfig;
  private modelRouter: ModelRouter;
  private taskTree: TaskTree;

  constructor(
    config: AgentPoolConfig,
    modelRouter: ModelRouter,
    taskTree: TaskTree
  ) {
    this.config = config;
    this.modelRouter = modelRouter;
    this.taskTree = taskTree;
    this.initializeWorkers();
  }

  /**
   * Initialize the worker pool
   */
  private initializeWorkers(): void {
    for (let i = 0; i < this.config.maxWorkers; i++) {
      const workerId = `worker-${uuidv4().slice(0, 8)}`;
      this.workers.set(workerId, {
        id: workerId,
        status: { id: workerId, status: 'idle', completedTasks: 0, totalTokens: 0, model: 'minimax' },
        taskQueue: [],
        model: this.config.defaultModel,
      });
    }
  }

  /**
   * Submit a task to the pool
   */
  async submit(taskId: string): Promise<TaskResult | null> {
    const task = this.taskTree.getTask(taskId);
    if (!task) return null;

    // Find an idle worker
    const worker = this.findIdleWorker();
    if (!worker) {
      // Queue the task
      const firstIdle = Array.from(this.workers.values()).find(w => w.status.status !== 'error');
      if (firstIdle) {
        firstIdle.taskQueue.push(taskId);
      }
      return null;
    }

    return this.executeTask(worker, task);
  }

  /**
   * Find an idle worker
   */
  private findIdleWorker(): Worker | undefined {
    return Array.from(this.workers.values()).find(
      w => w.status.status === 'idle' && w.taskQueue.length === 0
    );
  }

  /**
   * Execute a task on a worker
   */
  private async executeTask(worker: Worker, task: TaskNode): Promise<TaskResult> {
    const startTime = Date.now();
    const workerStatus = worker.status;

    // Update worker status
    workerStatus.status = 'busy';
    workerStatus.currentTaskId = task.id;
    workerStatus.startedAt = new Date();

    // Update task status
    this.taskTree.updateStatus(task.id, TaskStatus.RUNNING);

    // Route to appropriate model
    const model = this.modelRouter.route(task);
    const modelConfig = this.modelRouter.getModelConfig(model);

    try {
      // Simulate task execution (real implementation would call the model API)
      const response = await this.modelRouter.generate(model, task.instructions);

      const result: TaskResult = {
        taskId: task.id,
        output: response,
        filesChanged: [],
        commandsExecuted: [],
        duration: Date.now() - startTime,
        tokenUsage: {
          input: Math.floor(task.instructions.length / 4),
          output: Math.floor(response.length / 4),
          total: Math.floor((task.instructions.length + response.length) / 4),
          cost: modelConfig ? (modelConfig.cost.input * task.instructions.length / 1000 + modelConfig.cost.output * response.length / 1000) : 0,
        },
      };

      // Update task and worker
      this.taskTree.updateStatus(task.id, TaskStatus.COMPLETED, result);
      workerStatus.status = 'idle';
      workerStatus.currentTaskId = undefined;
      workerStatus.completedTasks++;
      workerStatus.totalTokens += result.tokenUsage?.total ?? 0;

      return result;
    } catch (error) {
      this.taskTree.updateStatus(task.id, TaskStatus.FAILED, undefined, {
        taskId: task.id,
        message: error instanceof Error ? error.message : 'Unknown error',
        recoverable: true,
        failedAt: new Date(),
      });

      workerStatus.status = 'error';
      workerStatus.currentTaskId = undefined;

      throw error;
    }
  }

  /**
   * Get status of all workers
   */
  getWorkerStatuses(): WorkerStatus[] {
    return Array.from(this.workers.values()).map(w => w.status);
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    totalWorkers: number;
    idleWorkers: number;
    busyWorkers: number;
    errorWorkers: number;
    totalCompletedTasks: number;
    averageTokensPerTask: number;
  } {
    const statuses = this.getWorkerStatuses();
    const busyWorkers = statuses.filter(s => s.status === 'busy').length;
    const errorWorkers = statuses.filter(s => s.status === 'error').length;
    const totalCompleted = statuses.reduce((sum, s) => sum + s.completedTasks, 0);
    const totalTokens = statuses.reduce((sum, s) => sum + s.totalTokens, 0);

    return {
      totalWorkers: statuses.length,
      idleWorkers: statuses.length - busyWorkers - errorWorkers,
      busyWorkers,
      errorWorkers,
      totalCompletedTasks: totalCompleted,
      averageTokensPerTask: totalCompleted > 0 ? totalTokens / totalCompleted : 0,
    };
  }

  /**
   * Get the least loaded worker
   */
  getLeastLoadedWorker(): Worker | undefined {
    return Array.from(this.workers.values())
      .filter(w => w.status.status !== 'error')
      .sort((a, b) => a.taskQueue.length - b.taskQueue.length)[0];
  }

  /**
   * Drain the queue (move all pending tasks)
   */
  getQueuedTaskIds(): string[] {
    return Array.from(this.workers.values())
      .flatMap(w => w.taskQueue);
  }
}
