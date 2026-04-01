// ============================================================================
// Model Router - Multi-model intelligent routing
// ============================================================================

import { ModelProvider, TaskNode, ModelConfig, ModelRoutingRule, TaskCategory, TaskPriority } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class ModelRouter {
  private models: Map<string, ModelConfig> = new Map();
  private routingRules: ModelRoutingRule[] = [];

  constructor(configPath?: string) {
    if (configPath && fs.existsSync(configPath)) {
      this.loadConfig(configPath);
    } else {
      this.initializeDefaults();
    }
  }

  /**
   * Load model configuration from JSON file
   */
  private loadConfig(configPath: string): void {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      if (config.models) {
        for (const [id, modelData] of Object.entries(config.models as Record<string, unknown>)) {
          const m = modelData as Record<string, unknown>;
          this.models.set(id, {
            id,
            name: id,
            provider: ModelProvider[m['provider']?.toString().toUpperCase() as keyof typeof ModelProvider] ?? ModelProvider.LOCAL,
            endpoint: m['endpoint'] as string,
            apiKey: m['apiKey'] as string | undefined,
            capabilities: (m['capabilities'] as string[]) ?? [],
            contextWindow: (m['contextWindow'] as number) ?? 4096,
            maxTokens: (m['maxTokens'] as number) ?? 4096,
            cost: {
              input: ((m['cost'] as Record<string, number>) ?? {})['input'] ?? 0,
              output: ((m['cost'] as Record<string, number>) ?? {})['output'] ?? 0,
              cacheRead: ((m['cost'] as Record<string, number>) ?? {})['cacheRead'],
              cacheWrite: ((m['cost'] as Record<string, number>) ?? {})['cacheWrite'],
            },
          });
        }
      }

      if (config.routing) {
        // Build routing rules from config
        const r = config.routing as Record<string, string[]>;
        if (r.lightTask?.length) {
          this.routingRules.push({
            category: TaskCategory.GENERAL,
            priority: TaskPriority.LOW,
            preferredProviders: r.lightTask.map(p => this.providerFromString(p)),
            fallbackProviders: [],
          });
        }
      }
    } catch (error) {
      console.error('Failed to load model config:', error);
      this.initializeDefaults();
    }
  }

  /**
   * Initialize default models
   */
  private initializeDefaults(): void {
    this.models.set('claude-3-5-sonnet', {
      id: 'claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: ModelProvider.ANTHROPIC,
      endpoint: 'https://api.anthropic.com/v1/messages',
      capabilities: ['thinking', 'vision', 'coding', 'general'],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 3, output: 15 },
    });

    this.models.set('minimax-m2.7', {
      id: 'minimax-m2.7',
      name: 'MiniMax M2.7',
      provider: ModelProvider.MINIMAX,
      endpoint: 'https://api.minimaxi.com/anthropic/v1',
      capabilities: ['thinking', 'coding', 'general'],
      contextWindow: 204800,
      maxTokens: 131072,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    });

    this.models.set('qwen-coder', {
      id: 'qwen-coder',
      name: 'Qwen Coder',
      provider: ModelProvider.BAILIAN,
      endpoint: 'https://coding.dashscope.com/v1',
      capabilities: ['coding', 'thinking'],
      contextWindow: 1000000,
      maxTokens: 8192,
      cost: { input: 0.001, output: 0.002 },
    });

    this.models.set('ollama-local', {
      id: 'ollama-local',
      name: 'Ollama Local',
      provider: ModelProvider.OLLAMA,
      endpoint: 'http://localhost:11434/api/generate',
      capabilities: ['coding', 'general'],
      contextWindow: 8192,
      maxTokens: 4096,
      cost: { input: 0, output: 0 },
    });
  }

  /**
   * Route a task to the appropriate model
   */
  route(task: TaskNode): ModelProvider {
    // Determine task complexity based on instructions
    const complexity = this.assessComplexity(task);

    // Find matching rule
    const rule = this.routingRules.find(
      r => r.category === task.category && r.priority <= task.priority
    );

    if (rule && rule.preferredProviders.length > 0) {
      // Return the first available provider in preference order
      for (const provider of rule.preferredProviders) {
        const model = this.getFirstModelByProvider(provider);
        if (model) {
          // Check if model supports the task requirements
          if (this.modelSupportsTask(model, task)) {
            return provider;
          }
        }
      }
    }

    // Fallback: route based on category and complexity
    return this.routeFallback(task.category, complexity);
  }

  /**
   * Assess task complexity based on instructions
   */
  private assessComplexity(task: TaskNode): 'low' | 'medium' | 'high' {
    const text = task.instructions.toLowerCase();
    const length = task.instructions.length;

    // High complexity indicators
    const highComplexity = [
      'architect', 'design', 'refactor', 'optimize', 'implement from scratch',
      'migration', 'restructure', 'multiple', 'complex', 'advanced',
    ];

    // Low complexity indicators
    const lowComplexity = [
      'fix', 'bug', 'typo', 'simple', 'quick', 'small', 'easy',
      'one line', 'update', 'change', 'rename',
    ];

    const highCount = highComplexity.filter(w => text.includes(w)).length;
    const lowCount = lowComplexity.filter(w => text.includes(w)).length;

    if (highCount > lowCount || length > 5000) return 'high';
    if (lowCount > highCount && length < 500) return 'low';
    return 'medium';
  }

  /**
   * Fallback routing based on category and complexity
   */
  private routeFallback(category: TaskCategory, complexity: 'low' | 'medium' | 'high'): ModelProvider {
    if (category === TaskCategory.CODING) {
      if (complexity === 'low') return ModelProvider.OLLAMA;
      if (complexity === 'medium') return ModelProvider.BAILIAN;
      return ModelProvider.ANTHROPIC;
    }

    if (category === TaskCategory.REVIEW || category === TaskCategory.REFACTOR) {
      return complexity === 'high' ? ModelProvider.ANTHROPIC : ModelProvider.MINIMAX;
    }

    if (complexity === 'low') return ModelProvider.OLLAMA;
    if (complexity === 'medium') return ModelProvider.BAILIAN;
    return ModelProvider.MINIMAX;
  }

  /**
   * Check if a model supports a task
   */
  private modelSupportsTask(model: ModelConfig, task: TaskNode): boolean {
    for (const cap of task.metadata?.requiredCapabilities as string[] ?? []) {
      if (!model.capabilities.includes(cap)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get first model config by provider
   */
  getFirstModelByProvider(provider: ModelProvider): ModelConfig | undefined {
    for (const model of this.models.values()) {
      if (model.provider === provider) {
        return model;
      }
    }
    return undefined;
  }

  /**
   * Get model configuration by ID
   */
  getModelConfig(modelId: string): ModelConfig | undefined;
  getModelConfig(provider: ModelProvider): ModelConfig | undefined;
  getModelConfig(idOrProvider: string | ModelProvider): ModelConfig | undefined {
    if (typeof idOrProvider === 'string') {
      return this.models.get(idOrProvider);
    }
    return this.getFirstModelByProvider(idOrProvider);
  }

  /**
   * Get all available models
   */
  getAllModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  /**
   * Generate a response using the specified model
   */
  async generate(provider: ModelProvider, prompt: string): Promise<string> {
    const model = this.getFirstModelByProvider(provider);
    if (!model) {
      throw new Error(`No model found for provider: ${provider}`);
    }

    // Simulate API call (real implementation would call actual endpoints)
    // This is where you would integrate with actual model APIs
    return this.simulateModelResponse(model, prompt);
  }

  /**
   * Simulate model response (placeholder for real API calls)
   */
  private async simulateModelResponse(model: ModelConfig, prompt: string): Promise<string> {
    // In production, this would make actual API calls
    // For now, return a simulation response
    return `[${model.name}] Response to: ${prompt.slice(0, 100)}...`;
  }

  /**
   * Convert string to ModelProvider enum
   */
  private providerFromString(str: string): ModelProvider {
    const normalized = str.toLowerCase().replace(/[_-]/g, '');
    const mapping: Record<string, ModelProvider> = {
      'anthropic': ModelProvider.ANTHROPIC,
      'claude': ModelProvider.ANTHROPIC,
      'ollama': ModelProvider.OLLAMA,
      'local': ModelProvider.LOCAL,
      'bailian': ModelProvider.BAILIAN,
      'qwen': ModelProvider.BAILIAN,
      'minimax': ModelProvider.MINIMAX,
      'deepseek': ModelProvider.DEEPSEEK,
      'openai': ModelProvider.OPENAI,
    };
    return mapping[normalized] ?? ModelProvider.LOCAL;
  }

  /**
   * Add or update a model configuration
   */
  setModel(id: string, config: ModelConfig): void {
    this.models.set(id, config);
  }

  /**
   * Get routing statistics
   */
  getRoutingStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const model of this.models.values()) {
      const provider = model.provider;
      stats[provider] = (stats[provider] ?? 0) + 1;
    }
    return stats;
  }
}
