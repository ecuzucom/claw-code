// ============================================================================
// OpenClaw Bridge - Integration with OpenClaw orchestration layer
// ============================================================================

import { EventEmitter } from 'events';
import {
  OpenClawEvent,
  OpenClawTask,
  OpenClawMessage,
  ContextSummary,
} from '../types';
import { TaskTree } from '../engine/TaskTree';
import { AgentPool } from '../engine/AgentPool';
import { ModelRouter } from './ModelRouter';

export interface OpenClawBridgeConfig {
  gatewayUrl: string;
  authToken?: string;
  sessionId?: string;
  autoReconnect: boolean;
  reconnectInterval: number;
}

export class OpenClawBridge extends EventEmitter {
  private config: OpenClawBridgeConfig;
  private connected: boolean = false;
  private reconnectTimer?: NodeJS.Timeout;
  private messageQueue: OpenClawMessage[] = [];

  // Core engine references
  private taskTree: TaskTree;
  private agentPool: AgentPool;
  private modelRouter: ModelRouter;

  constructor(
    config: OpenClawBridgeConfig,
    taskTree: TaskTree,
    agentPool: AgentPool,
    modelRouter: ModelRouter
  ) {
    super();
    this.config = config;
    this.taskTree = taskTree;
    this.agentPool = agentPool;
    this.modelRouter = modelRouter;
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Connect to OpenClaw gateway
   */
  async connect(): Promise<boolean> {
    try {
      // In production, this would establish WebSocket connection
      // to the OpenClaw gateway
      console.log(`[OpenClawBridge] Connecting to ${this.config.gatewayUrl}...`);

      // Simulate connection
      await this.simulateConnect();

      this.connected = true;
      this.emit('connected');
      console.log('[OpenClawBridge] Connected successfully');

      // Process queued messages
      await this.processQueue();

      // Setup auto-reconnect if enabled
      if (this.config.autoReconnect) {
        this.setupReconnect();
      }

      return true;
    } catch (error) {
      console.error('[OpenClawBridge] Connection failed:', error);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Simulate connection (placeholder for real WebSocket)
   */
  private async simulateConnect(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Disconnect from OpenClaw gateway
   */
  disconnect(): void {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.emit('disconnected');
  }

  /**
   * Setup auto-reconnect handler
   */
  private setupReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      if (!this.connected) {
        console.log('[OpenClawBridge] Attempting reconnection...');
        await this.connect();
      }
    }, this.config.reconnectInterval);
  }

  // ===========================================================================
  // Task Handling
  // ===========================================================================

  /**
   * Receive a task from OpenClaw
   */
  async receiveTask(task: OpenClawTask): Promise<string> {
    const taskNode = this.taskTree.createTask(task.prompt, {
      priority: task.priority,
      category: this.mapTaskType(task.type),
      metadata: {
        originalTaskId: task.id,
        model: task.model,
        context: task.context,
        files: task.files,
      },
    });

    console.log(`[OpenClawBridge] Received task ${taskNode.id}`);

    // Submit to agent pool
    const result = await this.agentPool.submit(taskNode.id);

    if (result) {
      console.log(`[OpenClawBridge] Task ${taskNode.id} completed`);
    }

    return taskNode.id;
  }

  /**
   * Report task result back to OpenClaw
   */
  async reportResult(taskId: string): Promise<void> {
    const task = this.taskTree.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const payload = {
      taskId,
      status: task.status,
      result: task.result,
      error: task.error,
      metadata: task.metadata,
    };

    if (this.connected) {
      await this.sendEvent('task', payload);
    } else {
      // Queue for later
      this.messageQueue.push({
        role: 'assistant',
        content: JSON.stringify(payload),
      });
    }
  }

  /**
   * Subscribe to OpenClaw events
   */
  async subscribeToEvents(eventTypes: string[]): Promise<void> {
    for (const type of eventTypes) {
      this.on(type, (payload: unknown) => {
        this.handleEvent(type, payload);
      });
    }
    console.log(`[OpenClawBridge] Subscribed to events: ${eventTypes.join(', ')}`);
  }

  /**
   * Handle incoming events
   */
  private handleEvent(type: string, payload: unknown): void {
    console.log(`[OpenClawBridge] Event: ${type}`, payload);

    switch (type) {
      case 'task':
        this.handleTaskEvent(payload as OpenClawTask);
        break;
      case 'message':
        this.handleMessageEvent(payload as OpenClawMessage);
        break;
      case 'heartbeat':
        this.handleHeartbeat(payload as { timestamp: Date });
        break;
      default:
        this.emit('unknownEvent', { type, payload });
    }
  }

  private handleTaskEvent(task: OpenClawTask): void {
    this.receiveTask(task);
  }

  private handleMessageEvent(message: OpenClawMessage): void {
    this.messageQueue.push(message);
    this.processQueue();
  }

  private handleHeartbeat(beat: { timestamp: Date }): void {
    // Respond to heartbeat
    this.sendEvent('heartbeat', { timestamp: new Date(), sessionId: this.config.sessionId });
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  /**
   * Send a message through OpenClaw
   */
  async sendMessage(message: OpenClawMessage): Promise<void> {
    if (this.connected) {
      await this.sendEvent('message', message);
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Process queued messages
   */
  private async processQueue(): Promise<void> {
    while (this.messageQueue.length > 0 && this.connected) {
      const message = this.messageQueue.shift();
      if (message) {
        await this.sendEvent('message', message);
      }
    }
  }

  /**
   * Send an event to OpenClaw gateway
   */
  private async sendEvent(type: string, payload: unknown): Promise<void> {
    if (!this.connected) {
      console.warn('[OpenClawBridge] Not connected, cannot send event');
      return;
    }

    const event: OpenClawEvent = {
      type: type as OpenClawEvent['type'],
      source: 'integrated-agent',
      timestamp: new Date(),
      payload,
      sessionId: this.config.sessionId,
    };

    // In production, this would send via WebSocket
    console.log(`[OpenClawBridge] Sending event: ${type}`, payload);
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Map OpenClaw task type to internal category
   */
  private mapTaskType(type: OpenClawTask['type']): import('../types').TaskCategory {
    const mapping: Record<string, import('../types').TaskCategory> = {
      coding: 'coding',
      review: 'review',
      general: 'general',
    } as Record<string, import('../types').TaskCategory>;
    return mapping[type] ?? 'general';
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection status
   */
  getStatus(): {
    connected: boolean;
    queuedMessages: number;
    gateway: string;
    sessionId?: string;
  } {
    return {
      connected: this.connected,
      queuedMessages: this.messageQueue.length,
      gateway: this.config.gatewayUrl,
      sessionId: this.config.sessionId,
    };
  }
}
