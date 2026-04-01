# Integrated OpenClaw + Claude Code Core Architecture (v2)

> 将 Claude Code 的核心工程模块与 OpenClaw orchestration 层整合，打造**私有化可控、全链路工程化、成本感知**的 AI 编码/开发管家。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Orchestration Layer                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │  Message    │  │   Task       │  │    OpenClaw Bridge      │  │
│  │  Bus       │──▶│  Router     │──│  (WebSocket to Gateway) │  │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Cost-Aware Router (成本感知路由)                       │
│  按复杂度 + 成本 + 延迟 + 质量 综合决策，自动选最优模型               │
│  支持日/月预算上限，超限自动降级到便宜模型                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Pool (4 Workers)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  │
│  │  Worker 1  │  │  Worker 2   │  │  Worker 3   │  │ Worker 4 │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────────┘
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   TaskTree      │  │  Context Mgr    │  │   Sandbox       │
│  • 7状态机       │  │  • 智能裁剪     │  │  • 命令白名单   │
│  • 快照/回滚     │  │  • 热度排序     │  │  • Docker 隔离  │
│  • 父子依赖      │  │  • 分块加载     │  │  • 快照恢复     │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Persistence Layer (SQLite)                      │
│  任务状态 │ 审计日志 │ 模型统计 │ 成本预算 全部持久化               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Audit Log (持久化审计)                          │
│  安全事件 │ 成本事件 │ 任务事件 │ 文件变更 → 可导出 JSON/CSV       │
└─────────────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. Persistence (`src/engine/Persistence.ts`)
SQLite 持久化层，sql.js 实现（无需 native 编译）。

```typescript
// 任务持久化
persistence.saveTask(task);

// 重启后恢复
const tasks = persistence.loadTasks();
taskTree.restoreTasks(tasks);

// 审计日志查询
persistence.logAudit({ level: 'INFO', category: 'task', message: '...' });
const events = persistence.queryAudit({ taskId: 'xxx', since: new Date() });

// 模型使用统计
persistence.recordModelUsage({ modelId: 'minimax-m2.7', tokens: 500, cost: 0.002, ... });
```

### 2. CostAwareRouter (`src/engine/CostAwareRouter.ts`)
成本感知路由，支持日/月预算控制。

```typescript
// 设置预算
costAwareRouter.setBudget('daily', 10);  // $10/天

// 路由决策（考虑成本+质量+延迟）
const decision = costAwareRouter.route(task);
// → { model: qwen-coder, estimatedCost: $0.0001, budgetOk: true, ... }

// 查看成本报告
const report = costAwareRouter.getCostReport();
// → { totalCost, byProvider, byModel, dailySpend, monthlySpend, ... }
```

### 3. DockerSandbox (`src/engine/DockerSandbox.ts`)
容器级安全隔离，支持 Docker 时自动启用。

```typescript
// 创建隔离容器
const container = await dockerSandbox.createContainer(taskId);

// 容器内执行命令（完全隔离）
const result = await dockerSandbox.executeInContainer(
  container.id, 'npm install', '/workspace'
);

// 创建目录快照
await dockerSandbox.createDirectorySnapshot('/project/src', taskId);

// 回滚
await dockerSandbox.restoreDirectorySnapshot(snapshotId);
```

### 4. AuditLog (`src/engine/AuditLog.ts`)
结构化审计日志，支持安全事件追踪和合规报表。

```typescript
// 记录事件
auditLog.taskStart(taskId, workerId, instructions);
auditLog.taskComplete(taskId, workerId, durationMs, filesChanged);
auditLog.taskFail(taskId, workerId, errorMsg);
auditLog.commandBlocked(workerId, 'rm -rf /', 'dangerous pattern');
auditLog.costBudgetWarning('daily', 0.9, 1.00);

// 查询
const events = auditLog.query({ since: new Date(), categories: ['SECURITY'] });
const report = auditLog.generateReport(new Date('2026-01-01'));

// 导出
auditLog.exportToCSV('/path/to/report.csv');
```

### 5. TaskTree (`src/engine/TaskTree.ts`)
层次化任务树 + 快照/回滚。

### 6. Sandbox (`src/engine/Sandbox.ts`)
exec 沙箱（Docker 不可用时 fallback）。

### 7. ModelRouter (`src/orchestrator/ModelRouter.ts`)
5 模型路由：Claude / MiniMax / Qwen / Ollama / DeepSeek。

## Docker 一键部署

```bash
# 开发环境
docker-compose up -d

# 查看日志
docker-compose logs -f integrated-agent

# 访问 Grafana (admin/admin123)
open http://localhost:3000

# Prometheus metrics
open http://localhost:9090
```

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 运行演示
npm start
```

## 项目结构

```
integrated-agent/
├── src/
│   ├── index.ts                    # 入口 (v2)
│   ├── orchestrator/
│   │   ├── OpenClawBridge.ts      # OpenClaw 网关集成
│   │   └── ModelRouter.ts         # 多模型路由
│   ├── engine/
│   │   ├── AgentPool.ts           # 多 Worker 池
│   │   ├── TaskTree.ts            # 任务树（7状态）
│   │   ├── ContextManager.ts      # 上下文裁剪
│   │   ├── Sandbox.ts             # exec 沙箱
│   │   ├── DockerSandbox.ts       # Docker 容器隔离
│   │   ├── Persistence.ts         # SQLite 持久化
│   │   ├── CostAwareRouter.ts     # 成本感知路由
│   │   └── AuditLog.ts            # 审计日志
│   ├── tools/
│   │   └── Desensitizer.ts        # 敏感信息脱敏
│   └── types/
│       └── index.ts               # TypeScript 类型
├── config/
│   ├── models.json                 # 模型配置
│   └── sandbox-rules.json          # 安全规则
├── docker-compose.yml              # Docker 部署
├── Dockerfile                      # 生产镜像
└── docker/
    ├── prometheus.yml              # Prometheus 配置
    └── grafana/                   # Grafana provision
```

## v2 新增特性

| 特性 | 说明 |
|------|------|
| **SQLite 持久化** | 任务/审计/模型统计全部持久化，重启可续跑 |
| **Docker 沙箱** | 容器级隔离，网络/资源完全隔离 |
| **成本感知路由** | 按日$10/月$100预算自动控制成本 |
| **持久化审计日志** | 安全事件/成本事件全链路记录，可导出 CSV |
| **自动快照/回滚** | 文件修改前自动快照，失败一键恢复 |
| **Prometheus + Grafana** | Token消耗/任务成功率/延迟实时监控 |
| **Graceful Shutdown** | SIGINT/SIGTERM 时自动保存状态 |

## License

MIT
