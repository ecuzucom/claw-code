// ============================================================================
// Integrated OpenClaw + Claude Code Core - Entry Point (v2)
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { Sandbox } from './engine/Sandbox';
import { DockerSandbox } from './engine/DockerSandbox';
import { Persistence } from './engine/Persistence';
import { TaskTree } from './engine/TaskTree';
import { AgentPool } from './engine/AgentPool';
import { ContextManager } from './engine/ContextManager';
import { CostAwareRouter } from './engine/CostAwareRouter';
import { ModelRouter } from './orchestrator/ModelRouter';
import { OpenClawBridge, OpenClawBridgeConfig } from './orchestrator/OpenClawBridge';
import { Desensitizer } from './tools/Desensitizer';
import { AuditLog, AuditCategory } from './engine/AuditLog';
import { TaskCategory, TaskPriority, ModelProvider } from './types';

// ========================================================================
// Configuration
// ========================================================================

const PROJECT_PATH = process.cwd();
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Load configs
const sandboxConfig = JSON.parse(
  fs.readFileSync(path.join(CONFIG_DIR, 'sandbox-rules.json'), 'utf-8')
);

// ========================================================================
// Global instances (initialized in main())
// ========================================================================

let sandbox!: Sandbox;
let dockerSandbox!: DockerSandbox;
let persistence!: Persistence;
let taskTree!: TaskTree;
let agentPool!: AgentPool;
let contextManager!: ContextManager;
let costAwareRouter!: CostAwareRouter;
let modelRouter!: ModelRouter;
let openClawBridge!: OpenClawBridge;
let desensitizer!: Desensitizer;
let auditLog!: AuditLog;

// ========================================================================
// Main Initialization
// ========================================================================

async function main() {
  // 1. Persistence Layer (SQLite)
  persistence = new Persistence(path.join(DATA_DIR, 'integrated-agent.db'));
  await persistence.initialize();
  console.log('✅ Persistence initialized');
  const persistStats = persistence.getStats();
  console.log(`   DB: ${persistStats.tasks} tasks, ${persistStats.auditEntries} audit entries`);

  // 2. Audit Log
  auditLog = new AuditLog(persistence, path.join(DATA_DIR, 'audit'));
  auditLog.info(AuditCategory.SYSTEM, 'Integrated Agent starting');
  console.log('✅ Audit Log initialized');

  // 3. Security Sandbox (exec-based fallback)
  sandbox = new Sandbox(sandboxConfig);
  console.log('✅ Sandbox initialized');

  // 4. Docker Sandbox (container-level isolation)
  dockerSandbox = new DockerSandbox(sandboxConfig);
  console.log('✅ Docker Sandbox initialized');

  // 5. Task Tree (with persistence)
  taskTree = new TaskTree(sandbox);

  // Restore tasks from persistence
  const savedTasks = persistence.loadTasks();
  taskTree.restoreTasks(savedTasks);
  console.log(`✅ Task Tree initialized (restored ${savedTasks.length} tasks)`);

  // 6. Model Router
  modelRouter = new ModelRouter(path.join(CONFIG_DIR, 'models.json'));
  console.log(`✅ Model Router initialized (${modelRouter.getAllModels().length} models)`);

  // 7. Cost-Aware Router (with budget tracking)
  costAwareRouter = new CostAwareRouter(modelRouter, persistence);
  const budgetStatus = costAwareRouter.getBudgetStatus();
  console.log(`✅ Cost-Aware Router initialized`);
  console.log(`   Daily budget: $${budgetStatus.daily.spent.toFixed(2)} / $${budgetStatus.daily.limit}`);

  // 8. Agent Pool
  agentPool = new AgentPool(
    {
      maxWorkers: 4,
      defaultModel: ModelProvider.MINIMAX,
      idleTimeout: 300000,
      maxRetries: 3,
    },
    modelRouter,
    taskTree
  );
  console.log('✅ Agent Pool initialized (4 workers)');

  // 9. Context Manager
  contextManager = new ContextManager(PROJECT_PATH, 180000);
  console.log('✅ Context Manager initialized');

  // 10. OpenClaw Bridge
  openClawBridge = new OpenClawBridge(
    {
      gatewayUrl: process.env.OPENCLAW_GATEWAY ?? 'ws://127.0.0.1:18789',
      authToken: process.env.OPENCLAW_TOKEN,
      sessionId: process.env.OPENCLAW_SESSION_ID,
      autoReconnect: true,
      reconnectInterval: 5000,
    } as OpenClawBridgeConfig,
    taskTree,
    agentPool,
    modelRouter
  );
  console.log('✅ OpenClaw Bridge initialized');

  // 11. Desensitizer
  desensitizer = new Desensitizer();
  console.log('✅ Desensitizer initialized');

  // ====================================================================
  // Event Handlers
  // ====================================================================

  openClawBridge.on('connected', () => {
    auditLog.info(AuditCategory.SYSTEM, 'Connected to OpenClaw Gateway');
    console.log('\n🔗 Connected to OpenClaw Gateway');
  });

  openClawBridge.on('disconnected', () => {
    auditLog.warn(AuditCategory.SYSTEM, 'Disconnected from OpenClaw Gateway');
    console.log('\n🔌 Disconnected from OpenClaw Gateway');
  });

  openClawBridge.on('error', (error: Error) => {
    auditLog.error(AuditCategory.SYSTEM, `Bridge error: ${error.message}`);
    console.error('\n❌ Bridge Error:', error.message);
  });

  // ====================================================================
  // Auto-Save Hook
  // ====================================================================

  // Auto-save task state every 30 seconds
  setInterval(() => {
    const tasks = taskTree.getAllTasks();
    for (const task of tasks) {
      if (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
        persistence.saveTask(task);
      }
    }
  }, 30000);

  // Auto-save on exit
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // ====================================================================
  // Demo
  // ====================================================================
  await demo();

  // ====================================================================
  // Start Server (for module usage)
  // ====================================================================
  console.log('\n🚀 Integrated Agent is ready');
}

// ========================================================================
// Graceful Shutdown
// ========================================================================

function gracefulShutdown() {
  console.log('\n[Shutdown] Saving state...');
  const tasks = taskTree.getAllTasks();
  for (const task of tasks) {
    persistence.saveTask(task);
  }
  persistence.close();
  auditLog.close();
  process.exit(0);
}

// ========================================================================
// Demo
// ========================================================================

async function demo() {
  console.log('\n========================================');
  console.log('Integrated OpenClaw + Claude Code v2 Demo');
  console.log('========================================\n');

  // Demo 1: Cost-Aware Routing
  console.log('🧭 Cost-Aware Routing Demo:');
  const task1 = taskTree.createTask(
    'Implement a binary search tree with insert, delete, and search operations in TypeScript',
    { category: TaskCategory.CODING, priority: TaskPriority.HIGH }
  );

  const decision = costAwareRouter.route(task1);
  console.log(`   Task: "${task1.instructions.slice(0, 50)}..."`);
  console.log(`   Selected: ${decision.model.name} (${decision.model.provider})`);
  console.log(`   Est. cost: $${decision.estimatedCost.toFixed(4)}`);
  console.log(`   Est. latency: ${decision.estimatedLatencyMs.toFixed(0)}ms`);
  console.log(`   Reason: ${decision.routingReason}`);
  console.log(`   Budget OK: ${decision.budgetOk ? '✅' : '❌'}`);

  // Demo 2: Sandbox Security
  console.log(`\n🔒 Sandbox Security Demo:`);
  const allowed = sandbox.isCommandAllowed('npm install express');
  console.log(`   "npm install express" → ${allowed.allowed ? '✅ ALLOWED' : '❌ BLOCKED'}`);

  const blocked = sandbox.isCommandAllowed('rm -rf /');
  console.log(`   "rm -rf /" → ${blocked.allowed ? '✅ ALLOWED' : '❌ BLOCKED: ' + blocked.reason}`);

  const dockerCheck = await dockerSandbox['checkDockerAvailability']();
  console.log(`   Docker available: ${dockerCheck ? '✅' : '❌ (falling back to exec sandbox)'}`);

  // Demo 3: Desensitizer
  console.log(`\n🔐 Desensitizer Demo:`);
  const secretText = 'API_KEY=sk-abc123xyzSECRETKEY AWS_KEY=AKIAIOSFODNN7EXAMPLE';
  const { masked, findings } = desensitizer.scan(secretText);
  console.log(`   Original: ${secretText}`);
  console.log(`   Masked:   ${masked}`);
  console.log(`   Findings: ${findings.length > 0 ? findings.map(f => `${f.type} (${(f.confidence * 100).toFixed(0)}%)`).join(', ') : 'none'}`);

  // Demo 4: Cost Budget
  console.log(`\n💰 Cost Budget Demo:`);
  const report = costAwareRouter.getCostReport();
  console.log(`   Total cost: $${report.totalCost.toFixed(4)}`);
  console.log(`   By provider: ${Object.entries(report.byProvider).map(([k, v]) => `${k}=$${v.toFixed(4)}`).join(', ')}`);
  console.log(`   Daily remaining: $${report.budgetRemaining.daily.toFixed(2)}`);
  console.log(`   Monthly remaining: $${report.budgetRemaining.monthly.toFixed(2)}`);

  // Demo 5: Audit Log
  console.log(`\n📋 Audit Log Demo:`);
  auditLog.taskStart(task1.id, 'worker-001', task1.instructions);
  auditLog.commandBlocked('worker-001', 'rm -rf /', 'Blocked pattern detected');
  auditLog.modelCall('minimax-m2.7', 'minimax', 500, 0.0025, 1500, true);

  const securityEvents = auditLog.getSecurityEvents();
  console.log(`   Security events: ${securityEvents.length}`);
  console.log(`   Task events: ${auditLog.query({ categories: [AuditCategory.TASK] }).length}`);

  // Demo 6: Task Tree
  console.log(`\n📊 Task Tree Stats:`);
  const stats = taskTree.getStats();
  console.log(`   Total tasks: ${stats.total}`);
  console.log(`   Pending: ${(stats.byStatus as Record<string,number>)['PENDING'] ?? 0}`);
  console.log(`   Running: ${(stats.byStatus as Record<string,number>)['RUNNING'] ?? 0}`);
  console.log(`   Completed: ${(stats.byStatus as Record<string,number>)['COMPLETED'] ?? 0}`);

  // Demo 7: Worker Pool
  console.log(`\n👥 Agent Pool Stats:`);
  const poolStats = agentPool.getStats();
  console.log(`   Workers: ${poolStats.totalWorkers} (idle: ${poolStats.idleWorkers}, busy: ${poolStats.busyWorkers})`);
  console.log(`   Completed: ${poolStats.totalCompletedTasks}`);
  console.log(`   Avg tokens/task: ${poolStats.averageTokensPerTask.toFixed(0)}`);

  // Demo 8: Persistence
  console.log(`\n💾 Persistence Stats:`);
  const persistFinal = persistence.getStats();
  console.log(`   DB path: ${persistFinal.dbPath}`);
  console.log(`   Tasks: ${persistFinal.tasks}`);
  console.log(`   Audit entries: ${persistFinal.auditEntries}`);
  console.log(`   Model stats: ${persistFinal.modelStats}`);

  console.log('\n========================================');
  console.log('Demo complete! ✅');
  console.log('========================================\n');
}

// ========================================================================
// Export for use as module
// ========================================================================

export {
  sandbox,
  dockerSandbox,
  persistence,
  taskTree,
  agentPool,
  contextManager,
  costAwareRouter,
  modelRouter,
  openClawBridge,
  desensitizer,
  auditLog,
  AuditCategory,
};

export function getSandbox(): Sandbox { return sandbox; }
export function getDockerSandbox(): DockerSandbox { return dockerSandbox; }
export function getPersistence(): Persistence { return persistence; }
export function getTaskTree(): TaskTree { return taskTree; }
export function getAgentPool(): AgentPool { return agentPool; }
export function getContextManager(): ContextManager { return contextManager; }
export function getCostAwareRouter(): CostAwareRouter { return costAwareRouter; }
export function getModelRouter(): ModelRouter { return modelRouter; }
export function getOpenClawBridge(): OpenClawBridge { return openClawBridge; }
export function getDesensitizer(): Desensitizer { return desensitizer; }
export function getAuditLog(): AuditLog { return auditLog; }

// ========================================================================
// Run
// ========================================================================

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
