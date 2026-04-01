// ============================================================================
// Context Manager - Intelligent context pruning and management
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  ContextSummary,
  ContextChunk,
  Attachment,
} from '../types';

interface FileHotness {
  path: string;
  lastAccessed: Date;
  editCount: number;
  dependencyDepth: number;
}

export class ContextManager {
  private projectPath: string;
  private fileHotness: Map<string, FileHotness> = new Map();
  private messageHistory: Message[] = [];
  private maxTokens: number;

  constructor(projectPath: string, maxContextTokens: number = 180000) {
    this.projectPath = projectPath;
    this.maxTokens = maxContextTokens;
    this.scanProject();
  }

  /**
   * Initial scan of project files
   */
  private scanProject(): void {
    try {
      const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h'];
      this.walkDir(this.projectPath, extensions).forEach(file => {
        const stats = fs.statSync(file);
        this.fileHotness.set(file, {
          path: file,
          lastAccessed: stats.mtime,
          editCount: 0,
          dependencyDepth: 0,
        });
      });
    } catch (error) {
      console.error('Failed to scan project:', error);
    }
  }

  /**
   * Walk directory and find files with given extensions
   */
  private walkDir(dir: string, extensions: string[]): string[] {
    const files: string[] = [];
    const skipDirs = ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv'];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !skipDirs.includes(entry.name)) {
        files.push(...this.walkDir(fullPath, extensions));
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  /**
   * Add a message to history
   */
  addMessage(role: Message['role'], content: string, attachments?: Attachment[]): Message {
    const message: Message = {
      id: uuidv4(),
      role,
      content,
      tokens: this.estimateTokens(content),
      createdAt: new Date(),
      attachments,
    };
    this.messageHistory.push(message);
    return message;
  }

  /**
   * Prune context to fit within token limit
   * Strategy: by relevance score, dependency, modification time
   */
  pruneContext(messages: Message[], maxTokens?: number): Message[] {
    const limit = maxTokens ?? Math.floor(this.maxTokens * 0.8);
    let totalTokens = 0;
    const result: Message[] = [];

    // Score and sort messages
    const scored = messages.map((msg, idx) => ({
      msg,
      score: this.calculateRelevanceScore(msg, idx, messages.length),
    }));

    scored.sort((a, b) => b.score - a.score);

    // Add messages until we hit the limit
    for (const { msg } of scored) {
      if (totalTokens + msg.tokens > limit) {
        break;
      }
      result.push(msg);
      totalTokens += msg.tokens;
    }

    // Sort back to original order
    result.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));

    return result;
  }

  /**
   * Calculate relevance score for a message
   */
  private calculateRelevanceScore(
    message: Message,
    index: number,
    totalMessages: number
  ): number {
    let score = 0;

    // Recency factor (newer = higher)
    const recency = 1 - index / totalMessages;
    score += recency * 30;

    // Attachment factor (messages with attachments are more important)
    if (message.attachments && message.attachments.length > 0) {
      score += 20;
    }

    // Token efficiency (shorter messages with high info density)
    const infoDensity = message.attachments
      ? message.attachments.length * 10
      : message.content.split(/\s+/).length;
    score += Math.min(infoDensity, 30);

    // Tool results are very important
    if (message.role === 'tool') {
      score += 25;
    }

    // System messages have baseline importance
    if (message.role === 'system') {
      score += 15;
    }

    return score;
  }

  /**
   * Load context for a project
   */
  loadContext(): ContextSummary {
    const hotFiles: string[] = [];
    const staleFiles: string[] = [];
    const now = new Date();

    for (const [filePath, hotness] of this.fileHotness.entries()) {
      const hoursSinceAccess = (now.getTime() - hotness.lastAccessed.getTime()) / 3600000;
      if (hoursSinceAccess < 24) {
        hotFiles.push(filePath);
      } else if (hoursSinceAccess > 168) {
        // 7 days
        staleFiles.push(filePath);
      }
    }

    return {
      totalTokens: this.messageHistory.reduce((sum, m) => sum + m.tokens, 0),
      messageCount: this.messageHistory.length,
      fileReferences: hotFiles,
      activeFiles: hotFiles.slice(0, 20),
      hotFiles,
      staleFiles,
    };
  }

  /**
   * Split long context into chunks
   */
  splitContext(longContext: Message[]): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    let currentChunk: Message[] = [];
    let currentTokens = 0;
    const chunkSize = Math.floor(this.maxTokens * 0.6);

    for (const msg of longContext) {
      if (currentTokens + msg.tokens > chunkSize && currentChunk.length > 0) {
        chunks.push({
          id: uuidv4(),
          messages: [...currentChunk],
          totalTokens: currentTokens,
          relevanceScore: currentChunk.reduce((sum, m) => sum + this.calculateRelevanceScore(m, 0, 0), 0),
          fileReferences: currentChunk.flatMap(m => m.attachments?.map(a => a.path) ?? []),
        });
        currentChunk = [];
        currentTokens = 0;
      }
      currentChunk.push(msg);
      currentTokens += msg.tokens;
    }

    if (currentChunk.length > 0) {
      chunks.push({
        id: uuidv4(),
        messages: currentChunk,
        totalTokens: currentTokens,
        relevanceScore: currentChunk.reduce((sum, m) => sum + this.calculateRelevanceScore(m, 0, 0), 0),
        fileReferences: currentChunk.flatMap(m => m.attachments?.map(a => a.path) ?? []),
      });
    }

    return chunks;
  }

  /**
   * Update file access/change tracking
   */
  markFileAccessed(filePath: string): void {
    const hotness = this.fileHotness.get(filePath);
    if (hotness) {
      hotness.lastAccessed = new Date();
      hotness.editCount++;
    }
  }

  /**
   * Estimate tokens (rough: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Get message history
   */
  getHistory(): Message[] {
    return [...this.messageHistory];
  }

  /**
   * Clear old history
   */
  clearHistory(keepLast: number = 50): void {
    if (this.messageHistory.length > keepLast) {
      this.messageHistory = this.messageHistory.slice(-keepLast);
    }
  }
}
