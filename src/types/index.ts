// ============================================================================
// Type Definitions for Integrated OpenClaw + Claude Code Architecture
// ============================================================================

export enum TaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  ROLLED_BACK = 'ROLLED_BACK',
  CANCELLED = 'CANCELLED',
  PAUSED = 'PAUSED',
}

export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OLLAMA = 'ollama',
  BAILIAN = 'bailian',
  MINIMAX = 'minimax',
  DEEPSEEK = 'deepseek',
  OPENAI = 'openai',
  LOCAL = 'local',
}

export enum TaskPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

export enum TaskCategory {
  CODING = 'coding',
  REVIEW = 'review',
  REFACTOR = 'refactor',
  BUILD = 'build',
  TEST = 'test',
  DEPLOY = 'deploy',
  DOCS = 'docs',
  RESEARCH = 'research',
  GENERAL = 'general',
}

// ========================================================================
// Task & Task Tree
// ========================================================================

export interface TaskNode {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: TaskCategory;
  instructions: string;
  parent?: string;
  children: string[];
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: TaskResult;
  error?: TaskError;
  snapshots: string[];
  workerId?: string;
  metadata: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  output: string;
  filesChanged: string[];
  commandsExecuted: string[];
  duration: number;
  tokenUsage?: TokenUsage;
}

export interface TaskError {
  taskId: string;
  message: string;
  stack?: string;
  recoverable: boolean;
  failedAt: Date;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  total: number;
  cost: number;
}

// ========================================================================
// Agent Pool
// ========================================================================

export interface WorkerStatus {
  id: string;
  status: 'idle' | 'busy' | 'error';
  currentTaskId?: string;
  model: string;
  startedAt?: Date;
  completedTasks: number;
  totalTokens: number;
}

export interface AgentPoolConfig {
  maxWorkers: number;
  defaultModel: ModelProvider;
  idleTimeout: number;
  maxRetries: number;
}

// ========================================================================
// Model Configuration
// ========================================================================

export interface ModelConfig {
  id: string;
  name: string;
  provider: ModelProvider;
  endpoint: string;
  apiKey?: string;
  capabilities: string[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelRoutingRule {
  category: TaskCategory;
  priority: TaskPriority;
  preferredProviders: ModelProvider[];
  fallbackProviders: ModelProvider[];
  maxContextUsage?: number;
}

// ========================================================================
// Context Management
// ========================================================================

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tokens: number;
  createdAt: Date;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  filename: string;
  path: string;
  type: 'file' | 'image' | 'code' | 'url';
  size: number;
  tokenEstimate?: number;
}

export interface ContextSummary {
  totalTokens: number;
  messageCount: number;
  fileReferences: string[];
  activeFiles: string[];
  hotFiles: string[];
  staleFiles: string[];
}

export interface ContextChunk {
  id: string;
  messages: Message[];
  totalTokens: number;
  relevanceScore: number;
  fileReferences: string[];
}

// ========================================================================
// Sandbox & Security
// ========================================================================

export interface SandboxConfig {
  allowedCommands: string[];
  blockedPatterns: BlockedPattern[];
  maxFileSize: number;
  snapshotRetention: number;
  blockedExtensions: string[];
  allowedNetworkHosts: string[];
  blockedNetworkHosts: string[];
  timeoutSeconds: number;
  memoryLimitMB: number;
}

export interface BlockedPattern {
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

export interface FileSnapshot {
  id: string;
  taskId: string;
  path: string;
  content: string;
  hash: string;
  createdAt: Date;
  size: number;
}

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  filesChanged: string[];
  blockedCommands: string[];
}

// ========================================================================
// OpenClaw Bridge
// ========================================================================

export interface OpenClawEvent {
  type: 'task' | 'message' | 'notification' | 'error' | 'heartbeat';
  source: string;
  timestamp: Date;
  payload: unknown;
  sessionId?: string;
}

export interface OpenClawTask {
  id: string;
  type: 'coding' | 'review' | 'general';
  prompt: string;
  context?: ContextSummary;
  files?: string[];
  model?: ModelProvider;
  priority?: TaskPriority;
  metadata?: Record<string, unknown>;
}

export interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Attachment[];
}

// ========================================================================
// Tools
// ========================================================================

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  filesAffected?: string[];
  tokensUsed?: number;
}

export interface SecretFinding {
  type: 'api_key' | 'password' | 'token' | 'private_key' | 'bearer' | 'aws_key' | 'other';
  raw: string;
  masked: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
}

// ========================================================================
// Orchestration
// ========================================================================

export interface OrchestrationPlan {
  taskId: string;
  steps: OrchestrationStep[];
  estimatedTokens: number;
  estimatedDuration: number;
  requiredCapabilities: string[];
}

export interface OrchestrationStep {
  stepId: string;
  type: 'agent' | 'tool' | 'review' | 'merge';
  agentType?: 'planner' | 'coder' | 'reviewer' | 'tester' | 'deployer';
  instructions: string;
  model?: ModelProvider;
  dependsOn: string[];
  estimatedTokens: number;
}
