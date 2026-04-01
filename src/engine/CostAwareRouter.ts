// ============================================================================
// Cost-Aware Router - Budget-conscious model selection
// ============================================================================

import {
  ModelProvider,
  TaskNode,
  TaskCategory,
  TaskPriority,
  ModelConfig,
} from '../types';
import { ModelRouter } from '../orchestrator/ModelRouter';
import { Persistence } from './Persistence';

interface CostBudget {
  daily: { limit: number; spent: number; resetAt: Date };
  monthly: { limit: number; spent: number; resetAt: Date };
}

interface RouteDecision {
  model: ModelConfig;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  estimatedLatencyMs: number;
  confidence: number;
  routingReason: string;
  budgetOk: boolean;
}

export class CostAwareRouter {
  private modelRouter: ModelRouter;
  private persistence: Persistence;
  private budgets: CostBudget = {
    daily: { limit: 10, spent: 0, resetAt: this.getDailyReset() },
    monthly: { limit: 100, spent: 0, resetAt: this.getMonthlyReset() },
  };
  private dailyTokenLimit: number = 100000;
  private monthlyTokenLimit: number = 1000000;

  constructor(modelRouter: ModelRouter, persistence: Persistence) {
    this.modelRouter = modelRouter;
    this.persistence = persistence;

    // Load budgets from persistence
    this.loadBudgets();
  }

  // ===========================================================================
  // Budget Management
  // ===========================================================================

  private getDailyReset(): Date {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  private getMonthlyReset(): Date {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth;
  }

  private loadBudgets(): void {
    const dailyStatus = this.persistence.getBudgetStatus('daily');
    if (dailyStatus) {
      this.budgets.daily.spent = dailyStatus.currentSpend;
      this.budgets.daily.limit = dailyStatus.limit;
      this.budgets.daily.resetAt = dailyStatus.periodEnd;
    } else {
      this.setBudget('daily', this.budgets.daily.limit);
    }

    const monthlyStatus = this.persistence.getBudgetStatus('monthly');
    if (monthlyStatus) {
      this.budgets.monthly.spent = monthlyStatus.currentSpend;
      this.budgets.monthly.limit = monthlyStatus.limit;
      this.budgets.monthly.resetAt = monthlyStatus.periodEnd;
    } else {
      this.setBudget('monthly', this.budgets.monthly.limit);
    }

    // Check if we need to reset daily budget
    if (new Date() > this.budgets.daily.resetAt) {
      this.resetBudget('daily');
    }

    // Check if we need to reset monthly budget
    if (new Date() > this.budgets.monthly.resetAt) {
      this.resetBudget('monthly');
    }
  }

  setBudget(type: 'daily' | 'monthly', limit: number): void {
    const now = new Date();
    const resetAt = type === 'daily' ? this.getDailyReset() : this.getMonthlyReset();

    this.persistence.setCostBudget(type, type, limit, now, resetAt);

    if (type === 'daily') {
      this.budgets.daily.limit = limit;
    } else {
      this.budgets.monthly.limit = limit;
    }
  }

  private resetBudget(type: 'daily' | 'monthly'): void {
    if (type === 'daily') {
      this.budgets.daily.spent = 0;
      this.budgets.daily.resetAt = this.getDailyReset();
      this.persistence.setCostBudget('daily', 'daily', this.budgets.daily.limit, new Date(), this.budgets.daily.resetAt);
    } else {
      this.budgets.monthly.spent = 0;
      this.budgets.monthly.resetAt = this.getMonthlyReset();
      this.persistence.setCostBudget('monthly', 'monthly', this.budgets.monthly.limit, new Date(), this.budgets.monthly.resetAt);
    }
  }

  private checkBudget(cost: number): boolean {
    this.checkBudgetReset();

    if (this.budgets.daily.spent + cost > this.budgets.daily.limit) {
      return false;
    }
    if (this.budgets.monthly.spent + cost > this.budgets.monthly.limit) {
      return false;
    }
    return true;
  }

  private checkBudgetReset(): void {
    const now = new Date();
    if (now > this.budgets.daily.resetAt) {
      this.resetBudget('daily');
    }
    if (now > this.budgets.monthly.resetAt) {
      this.resetBudget('monthly');
    }
  }

  recordSpend(cost: number): void {
    this.budgets.daily.spent += cost;
    this.budgets.monthly.spent += cost;
    this.persistence.recordSpend('daily', cost);
    this.persistence.recordSpend('monthly', cost);
  }

  getBudgetStatus(): {
    daily: { limit: number; spent: number; remaining: number; resetAt: Date };
    monthly: { limit: number; spent: number; remaining: number; resetAt: Date };
  } {
    this.checkBudgetReset();
    return {
      daily: {
        limit: this.budgets.daily.limit,
        spent: this.budgets.daily.spent,
        remaining: Math.max(0, this.budgets.daily.limit - this.budgets.daily.spent),
        resetAt: this.budgets.daily.resetAt,
      },
      monthly: {
        limit: this.budgets.monthly.limit,
        spent: this.budgets.monthly.spent,
        remaining: Math.max(0, this.budgets.monthly.limit - this.budgets.monthly.spent),
        resetAt: this.budgets.monthly.resetAt,
      },
    };
  }

  // ===========================================================================
  // Token Estimation
  // ===========================================================================

  private estimateTokens(task: TaskNode): { input: number; output: number } {
    // Rough estimate: ~4 chars per token
    const inputTokens = Math.ceil(task.instructions.length / 4);

    // Estimate output based on task complexity
    const complexity = this.assessComplexity(task);
    let outputMultiplier: number;

    switch (complexity) {
      case 'low': outputMultiplier = 0.5; break;
      case 'medium': outputMultiplier = 1.5; break;
      case 'high': outputMultiplier = 4; break;
      default: outputMultiplier = 1;
    }

    return {
      input: inputTokens,
      output: Math.ceil(inputTokens * outputMultiplier),
    };
  }

  private assessComplexity(task: TaskNode): 'low' | 'medium' | 'high' {
    const text = task.instructions.toLowerCase();
    const length = task.instructions.length;

    const highComplexity = [
      'architect', 'design', 'refactor', 'optimize', 'implement from scratch',
      'migration', 'restructure', 'complex', 'advanced', 'full stack',
      'database schema', 'api design', 'system design',
    ];
    const lowComplexity = [
      'fix', 'bug', 'typo', 'simple', 'quick', 'small', 'easy',
      'one line', 'update', 'change', 'rename', 'format',
    ];

    const highCount = highComplexity.filter(w => text.includes(w)).length;
    const lowCount = lowComplexity.filter(w => text.includes(w)).length;

    if (highCount > lowCount || length > 5000) return 'high';
    if (lowCount > highCount && length < 500) return 'low';
    return 'medium';
  }

  // ===========================================================================
  // Cost-Aware Routing
  // ===========================================================================

  /**
   * Route a task to the best model considering cost, latency, and quality
   */
  route(task: TaskNode): RouteDecision {
    // Get base routing from ModelRouter
    const baseProvider = this.modelRouter.route(task);
    const candidates = this.getCandidateModels(task);

    // Score each candidate
    const scored = candidates.map(model => this.scoreModel(model, task));

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    // Pick the best that fits budget
    for (const entry of scored) {
      if (entry.estimatedCost <= this.getCheapestAvailableBudget()) {
        return this.makeDecision(entry.model, task);
      }
    }

    // Fallback: cheapest option
    const cheapest = scored[scored.length - 1];
    return this.makeDecision(cheapest.model, task);
  }

  private scoreModel(model: ModelConfig, task: TaskNode): {
    model: ModelConfig;
    score: number;
    estimatedCost: number;
    estimatedLatencyMs: number;
  } {
    const tokens = this.estimateTokens(task);
    const inputCost = model.cost.input * tokens.input / 1000;
    const outputCost = model.cost.output * tokens.output / 1000;
    const estimatedCost = inputCost + outputCost;

    // Latency estimate (rough: tokens per second varies by model)
    const tokensPerSecond = this.getTokensPerSecond(model);
    const estimatedLatencyMs = (tokens.input + tokens.output) / tokensPerSecond * 1000;

    // Quality score based on model capabilities
    let qualityScore = 50;
    if (model.capabilities.includes('thinking')) qualityScore += 20;
    if (model.capabilities.includes('coding')) qualityScore += 15;
    if (task.category === TaskCategory.CODING && model.capabilities.includes('coding')) qualityScore += 15;

    // Cost score (cheaper = higher score, capped)
    const costScore = Math.max(0, 100 - estimatedCost * 10);

    // Latency score (faster = higher score)
    const latencyScore = Math.max(0, 100 - estimatedLatencyMs / 100);

    // Context availability score (more context = higher)
    const contextScore = Math.min(100, model.contextWindow / 1000);

    // Weighted final score
    const score = qualityScore * 0.4 + costScore * 0.3 + latencyScore * 0.2 + contextScore * 0.1;

    return {
      model,
      score,
      estimatedCost,
      estimatedLatencyMs,
    };
  }

  private getTokensPerSecond(model: ModelConfig): number {
    // Rough estimates based on model type
    switch (model.provider) {
      case ModelProvider.ANTHROPIC:
        return 100;
      case ModelProvider.MINIMAX:
        return 150;
      case ModelProvider.BAILIAN:
        return 200;
      case ModelProvider.OLLAMA:
        return 50; // Local is usually slower
      default:
        return 80;
    }
  }

  private getCheapestAvailableBudget(): number {
    this.checkBudgetReset();
    const dailyRemaining = this.budgets.daily.limit - this.budgets.daily.spent;
    const monthlyRemaining = this.budgets.monthly.limit - this.budgets.monthly.spent;
    return Math.min(dailyRemaining, monthlyRemaining);
  }

  private getCandidateModels(task: TaskNode): ModelConfig[] {
    const allModels = this.modelRouter.getAllModels();
    const complexity = this.assessComplexity(task);

    // Filter by capability requirements
    const requiredCaps = task.metadata?.requiredCapabilities as string[] ?? [];

    return allModels.filter(m => {
      // Check capability match
      for (const cap of requiredCaps) {
        if (!m.capabilities.includes(cap)) return false;
      }

      // Context size check
      const tokens = this.estimateTokens(task);
      if (tokens.input + tokens.output > m.contextWindow) return false;

      return true;
    });
  }

  private makeDecision(model: ModelConfig, task: TaskNode): RouteDecision {
    const tokens = this.estimateTokens(task);
    const inputCost = model.cost.input * tokens.input / 1000;
    const outputCost = model.cost.output * tokens.output / 1000;
    const estimatedCost = inputCost + outputCost;

    const tokensPerSecond = this.getTokensPerSecond(model);
    const estimatedLatencyMs = (tokens.input + tokens.output) / tokensPerSecond * 1000;

    const budgetOk = this.checkBudget(estimatedCost);

    let routingReason = '';
    switch (this.assessComplexity(task)) {
      case 'low':
        routingReason = 'Simple task → prioritizing cost efficiency';
        break;
      case 'medium':
        routingReason = 'Medium task → balancing cost and quality';
        break;
      case 'high':
        routingReason = 'Complex task → prioritizing quality';
        break;
    }

    return {
      model,
      estimatedInputTokens: tokens.input,
      estimatedOutputTokens: tokens.output,
      estimatedCost,
      estimatedLatencyMs,
      confidence: 0.8,
      routingReason,
      budgetOk,
    };
  }

  // ===========================================================================
  // Post-Route Recording
  // ===========================================================================

  /**
   * Record actual usage after a model call
   */
  recordUsage(modelId: string, provider: string, tokens: number, cost: number, durationMs: number, success: boolean): void {
    this.recordSpend(cost);

    this.persistence.recordModelUsage({
      modelId,
      provider,
      tokens,
      cost,
      durationMs,
      success,
    });

    this.persistence.logAudit({
      level: 'INFO',
      category: 'model_usage',
      message: `Model ${modelId} used: ${tokens} tokens, $${cost.toFixed(4)}, ${durationMs}ms`,
      details: { modelId, tokens, cost, durationMs, success },
      durationMs,
    });
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getCostReport(): {
    totalCost: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    dailySpend: number;
    monthlySpend: number;
    budgetRemaining: { daily: number; monthly: number };
  } {
    const stats = this.persistence.getModelStats();

    let totalCost = 0;
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};

    for (const s of stats) {
      totalCost += s.totalCost;
      byModel[s.modelId] = s.totalCost;
      byProvider[s.provider] = (byProvider[s.provider] ?? 0) + s.totalCost;
    }

    return {
      totalCost,
      byProvider,
      byModel,
      dailySpend: this.budgets.daily.spent,
      monthlySpend: this.budgets.monthly.spent,
      budgetRemaining: {
        daily: this.budgets.daily.limit - this.budgets.daily.spent,
        monthly: this.budgets.monthly.limit - this.budgets.monthly.spent,
      },
    };
  }
}
