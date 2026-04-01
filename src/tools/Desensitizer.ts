// ============================================================================
// Desensitizer - Auto-detect and mask secrets, API keys, passwords
// ============================================================================

import { SecretFinding } from '../types';

interface Pattern {
  type: SecretFinding['type'];
  regex: RegExp;
  description: string;
  minLength: number;
  maxLength: number;
}

export class Desensitizer {
  private patterns: Pattern[];

  constructor() {
    this.patterns = this.initializePatterns();
  }

  /**
   * Initialize detection patterns for various secret types
   */
  private initializePatterns(): Pattern[] {
    return [
      // API Keys
      {
        type: 'api_key',
        regex: /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
        description: 'API Key',
        minLength: 20,
        maxLength: 100,
      },
      // Bearer Tokens
      {
        type: 'bearer',
        regex: /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
        description: 'Bearer Token',
        minLength: 20,
        maxLength: 200,
      },
      // AWS Keys
      {
        type: 'aws_key',
        regex: /(?:aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key))\s*[:=]\s*['"]?([A-Za-z0-9\/+=]{20,})['"]?/gi,
        description: 'AWS Access Key',
        minLength: 20,
        maxLength: 50,
      },
      // AWS Secret
      {
        type: 'aws_key',
        regex: /AWS_SECRET_ACCESS_KEY\s*[:=]\s*['"]?([a-zA-Z0-9\/+=]{40})['"]?/gi,
        description: 'AWS Secret Access Key',
        minLength: 40,
        maxLength: 50,
      },
      // Private Keys
      {
        type: 'private_key',
        regex: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|GPG)?\s*PRIVATE\s+KEY-----/gi,
        description: 'Private Key',
        minLength: 100,
        maxLength: 5000,
      },
      // Passwords in URLs
      {
        type: 'password',
        regex: /:\/\/[^:]+:[^@]+@[^\/]+/gi,
        description: 'Password in URL',
        minLength: 10,
        maxLength: 200,
      },
      // Generic Secret
      {
        type: 'other',
        regex: /(?:secret|token|auth|credential)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{16,})['"]?/gi,
        description: 'Generic Secret/Token',
        minLength: 16,
        maxLength: 200,
      },
      // JWT
      {
        type: 'token',
        regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/gi,
        description: 'JWT Token',
        minLength: 50,
        maxLength: 500,
      },
      // Slack Token
      {
        type: 'token',
        regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/gi,
        description: 'Slack Token',
        minLength: 50,
        maxLength: 100,
      },
      // GitHub Token
      {
        type: 'token',
        regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/gi,
        description: 'GitHub Token',
        minLength: 40,
        maxLength: 100,
      },
      // Database Connection Strings
      {
        type: 'api_key',
        regex: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@[^\s]+/gi,
        description: 'Database Connection String',
        minLength: 30,
        maxLength: 500,
      },
    ];
  }

  /**
   * Scan text and find all secrets
   */
  scan(text: string): { masked: string; findings: SecretFinding[] } {
    const findings: SecretFinding[] = [];
    let masked = text;

    for (const pattern of this.patterns) {
      // Reset regex lastIndex
      pattern.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        const raw = match[0];
        const startIndex = match.index;
        const endIndex = startIndex + raw.length;

        // Skip if already found
        if (findings.some(f => f.startIndex === startIndex)) {
          continue;
        }

        // Extract the secret value (not the key name)
        const secretValue = this.extractSecretValue(raw, pattern.type);

        findings.push({
          type: pattern.type,
          raw,
          masked: this.mask(secretValue, pattern.type),
          startIndex,
          endIndex,
          confidence: this.calculateConfidence(raw, secretValue, pattern),
        });
      }
    }

    // Sort by position
    findings.sort((a, b) => a.startIndex - b.startIndex);

    // Apply masking
    masked = this.applyMasking(text, findings);

    return { masked, findings };
  }

  /**
   * Mask all secrets in text
   */
  maskAll(text: string): string {
    const { masked } = this.scan(text);
    return masked;
  }

  /**
   * Extract the actual secret value from a match
   */
  private extractSecretValue(raw: string, type: SecretFinding['type']): string {
    switch (type) {
      case 'bearer':
        return raw.replace(/bearer\s+/i, '');
      case 'password':
        const urlMatch = raw.match(/:([^\s@]+)@/);
        return urlMatch ? urlMatch[1] : raw;
      case 'private_key':
        return raw;
      case 'token':
        return raw;
      case 'aws_key':
        if (raw.includes('AWS_SECRET_ACCESS_KEY')) {
          const parts = raw.split(/[:=]/);
          return parts[parts.length - 1]?.trim().replace(/['"]/g, '') ?? raw;
        }
        const kvMatch = raw.match(/:['"]?([A-Za-z0-9\/+=]{20,})['"]?/);
        return kvMatch ? kvMatch[1] : raw;
      default:
        const parts = raw.split(/[:=]/);
        return parts.length > 1 ? parts[parts.length - 1]?.trim().replace(/['"]/g, '') ?? raw : raw;
    }
  }

  /**
   * Mask a secret value
   */
  private mask(value: string, type: SecretFinding['type']): string {
    if (value.length <= 8) {
      return '*'.repeat(value.length);
    }

    const visibleChars = Math.min(4, Math.floor(value.length * 0.2));
    const maskedLength = value.length - visibleChars;
    return '*'.repeat(maskedLength) + value.slice(-visibleChars);
  }

  /**
   * Calculate confidence score for a finding
   */
  private calculateConfidence(
    raw: string,
    value: string,
    pattern: Pattern
  ): number {
    let confidence = 0.5;

    // High confidence if length is typical for the type
    if (value.length >= pattern.minLength && value.length <= pattern.maxLength) {
      confidence += 0.3;
    }

    // Check for entropy (randomness indicates real secret)
    const entropy = this.calculateEntropy(value);
    if (entropy > 3.5) {
      confidence += 0.15;
    }

    // Context clues
    if (/\b(production|staging|real|actual)\b/i.test(raw)) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Calculate Shannon entropy of a string
   */
  private calculateEntropy(str: string): number {
    const frequencies = new Map<string, number>();
    for (const char of str) {
      frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    }

    let entropy = 0;
    const len = str.length;
    for (const count of frequencies.values()) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }

    return entropy;
  }

  /**
   * Apply masking to text
   */
  private applyMasking(text: string, findings: SecretFinding[]): string {
    let result = text;
    let offset = 0;

    for (const finding of findings) {
      const start = finding.startIndex + offset;
      const end = start + finding.raw.length;
      const before = result.slice(0, start);
      const after = result.slice(end);

      // Replace raw with masked version
      const maskedRaw = this.replaceSecret(raw => this.mask(this.extractSecretValue(raw, finding.type), finding.type), finding.raw);
      result = before + maskedRaw + after;

      offset += maskedRaw.length - finding.raw.length;
    }

    return result;
  }

  /**
   * Replace secret in raw string
   */
  private replaceSecret(replacer: (raw: string) => string, raw: string): string {
    // Simple replacement - in production would handle more complex cases
    return replacer(raw);
  }

  /**
   * Get patterns being used
   */
  getPatterns(): { type: string; description: string }[] {
    return this.patterns.map(p => ({
      type: p.type,
      description: p.description,
    }));
  }
}
