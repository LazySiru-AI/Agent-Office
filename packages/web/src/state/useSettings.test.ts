import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  parseStoredSettings,
  validateSettings,
  type RunSettings,
} from './useSettings.js';
import { readStorage, writeStorage } from '../theme/useTheme.js';

/**
 * `parseStoredSettings` and `validateSettings` are the decision logic this
 * hook is built from (see the file header in `useSettings.ts`), and are
 * exercised here as plain functions — no React render, no DOM, per the task
 * constraints. `readStorage`/`writeStorage` (re-exported test targets from
 * `useTheme.ts`, not re-implemented in this file) are exercised the same way
 * `useTheme.test.ts` already exercises them, for the same reason: this file's
 * Node environment has no `window` at all, so "storage throws" is tested by
 * stubbing one in.
 */

function withField<K extends keyof RunSettings>(base: RunSettings, key: K, value: RunSettings[K]): RunSettings {
  return { ...base, [key]: value };
}

describe('parseStoredSettings — defaults', () => {
  it('returns DEFAULT_SETTINGS when nothing is stored', () => {
    expect(parseStoredSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns DEFAULT_SETTINGS for an empty-object payload', () => {
    expect(parseStoredSettings('{}')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseStoredSettings — a stored value wins', () => {
  it('a fully valid stored object is returned as-is', () => {
    const stored: RunSettings = {
      provider: 'claude-code',
      concurrency: 5,
      assignmentTimeoutMs: 120_000,
      runTokenBudget: 50_000,
      maxCostUsd: 2.5,
    };
    expect(parseStoredSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it('a stored provider overrides the default', () => {
    expect(parseStoredSettings(JSON.stringify({ provider: 'anthropic' })).provider).toBe('anthropic');
  });

  it('a stored concurrency within range overrides the default', () => {
    expect(parseStoredSettings(JSON.stringify({ concurrency: 7 })).concurrency).toBe(7);
  });

  it('a stored assignmentTimeoutMs overrides the default', () => {
    expect(parseStoredSettings(JSON.stringify({ assignmentTimeoutMs: 30_000 })).assignmentTimeoutMs).toBe(30_000);
  });

  it('a stored runTokenBudget overrides the default (absent) value', () => {
    expect(parseStoredSettings(JSON.stringify({ runTokenBudget: 1_000 })).runTokenBudget).toBe(1_000);
  });

  it('a stored maxCostUsd overrides the default (absent) value', () => {
    expect(parseStoredSettings(JSON.stringify({ maxCostUsd: 0.5 })).maxCostUsd).toBe(0.5);
  });
});

describe('parseStoredSettings — per-field fallback, not whole-object fallback', () => {
  it('an out-of-range concurrency falls back to the default while a valid provider next to it survives', () => {
    const result = parseStoredSettings(JSON.stringify({ provider: 'claude-code', concurrency: 999 }));
    expect(result.provider).toBe('claude-code');
    expect(result.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
  });

  it('a non-numeric assignmentTimeoutMs falls back to the default while other fields survive', () => {
    const result = parseStoredSettings(
      JSON.stringify({ provider: 'openai', assignmentTimeoutMs: 'soon', concurrency: 4 }),
    );
    expect(result.provider).toBe('openai');
    expect(result.concurrency).toBe(4);
    expect(result.assignmentTimeoutMs).toBe(DEFAULT_SETTINGS.assignmentTimeoutMs);
  });

  it('a blank provider falls back to the default while a valid concurrency next to it survives', () => {
    const result = parseStoredSettings(JSON.stringify({ provider: '', concurrency: 6 }));
    expect(result.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(result.concurrency).toBe(6);
  });

  it('a negative runTokenBudget falls back to absent rather than being trusted', () => {
    const result = parseStoredSettings(JSON.stringify({ runTokenBudget: -5 }));
    expect(result.runTokenBudget).toBeUndefined();
  });

  it('a non-integer runTokenBudget falls back to absent rather than being trusted', () => {
    const result = parseStoredSettings(JSON.stringify({ runTokenBudget: 12.5 }));
    expect(result.runTokenBudget).toBeUndefined();
  });

  it('a zero or negative maxCostUsd falls back to absent rather than being trusted', () => {
    expect(parseStoredSettings(JSON.stringify({ maxCostUsd: 0 })).maxCostUsd).toBeUndefined();
    expect(parseStoredSettings(JSON.stringify({ maxCostUsd: -1 })).maxCostUsd).toBeUndefined();
  });

  it('a non-string provider (e.g. a stray number) falls back to the default', () => {
    expect(parseStoredSettings(JSON.stringify({ provider: 42 })).provider).toBe(DEFAULT_SETTINGS.provider);
  });
});

describe('parseStoredSettings — malformed payloads', () => {
  it('non-JSON garbage falls back to DEFAULT_SETTINGS entirely, rather than throwing', () => {
    expect(() => parseStoredSettings('{not json')).not.toThrow();
    expect(parseStoredSettings('{not json')).toEqual(DEFAULT_SETTINGS);
  });

  it('a JSON array falls back to DEFAULT_SETTINGS (not a record, nothing to read field-by-field)', () => {
    expect(parseStoredSettings('[1,2,3]')).toEqual(DEFAULT_SETTINGS);
  });

  it('a bare JSON primitive falls back to DEFAULT_SETTINGS', () => {
    expect(parseStoredSettings('"just a string"')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('42')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('null')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('validateSettings — provider', () => {
  it('a non-empty provider produces no error', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'provider', 'scripted')).provider).toBeUndefined();
  });

  it('an empty or whitespace-only provider is rejected with an actionable message', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'provider', ''))).toEqual(
      expect.objectContaining({ provider: expect.stringContaining('provider') as unknown }),
    );
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'provider', '   ')).provider).toBeDefined();
  });
});

describe('validateSettings — concurrency, both boundaries', () => {
  it(`accepts the lower boundary (${MIN_CONCURRENCY})`, () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', MIN_CONCURRENCY)).concurrency).toBeUndefined();
  });

  it(`accepts the upper boundary (${MAX_CONCURRENCY})`, () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', MAX_CONCURRENCY)).concurrency).toBeUndefined();
  });

  it('rejects one below the lower boundary', () => {
    const errors = validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', MIN_CONCURRENCY - 1));
    expect(errors.concurrency).toBeDefined();
    expect(errors.concurrency).toContain(String(MIN_CONCURRENCY));
    expect(errors.concurrency).toContain(String(MAX_CONCURRENCY));
  });

  it('rejects one above the upper boundary', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', MAX_CONCURRENCY + 1)).concurrency).toBeDefined();
  });

  it('rejects zero', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', 0)).concurrency).toBeDefined();
  });

  it('rejects a non-integer concurrency', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', 3.5)).concurrency).toBeDefined();
  });

  it('rejects NaN (what an emptied numeric input produces)', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'concurrency', NaN)).concurrency).toBeDefined();
  });
});

describe('validateSettings — assignmentTimeoutMs', () => {
  it('accepts any positive whole number of milliseconds', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'assignmentTimeoutMs', 1)).assignmentTimeoutMs).toBeUndefined();
    expect(
      validateSettings(withField(DEFAULT_SETTINGS, 'assignmentTimeoutMs', 3_600_000)).assignmentTimeoutMs,
    ).toBeUndefined();
  });

  it('rejects zero', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'assignmentTimeoutMs', 0)).assignmentTimeoutMs).toBeDefined();
  });

  it('rejects a negative timeout', () => {
    expect(
      validateSettings(withField(DEFAULT_SETTINGS, 'assignmentTimeoutMs', -1_000)).assignmentTimeoutMs,
    ).toBeDefined();
  });

  it('rejects a non-integer timeout', () => {
    expect(
      validateSettings(withField(DEFAULT_SETTINGS, 'assignmentTimeoutMs', 100.5)).assignmentTimeoutMs,
    ).toBeDefined();
  });
});

describe('validateSettings — runTokenBudget (optional)', () => {
  it('undefined (no budget) is valid', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'runTokenBudget', undefined)).runTokenBudget).toBeUndefined();
  });

  it('accepts a positive whole number', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'runTokenBudget', 1)).runTokenBudget).toBeUndefined();
  });

  it('rejects zero', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'runTokenBudget', 0)).runTokenBudget).toBeDefined();
  });

  it('rejects a negative budget', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'runTokenBudget', -100)).runTokenBudget).toBeDefined();
  });

  it('rejects a non-integer budget', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'runTokenBudget', 100.5)).runTokenBudget).toBeDefined();
  });
});

describe('validateSettings — maxCostUsd (optional)', () => {
  it('undefined (no budget) is valid', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'maxCostUsd', undefined)).maxCostUsd).toBeUndefined();
  });

  it('accepts a small positive fractional value', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'maxCostUsd', 0.01)).maxCostUsd).toBeUndefined();
  });

  it('rejects zero', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'maxCostUsd', 0)).maxCostUsd).toBeDefined();
  });

  it('rejects a negative budget', () => {
    expect(validateSettings(withField(DEFAULT_SETTINGS, 'maxCostUsd', -1)).maxCostUsd).toBeDefined();
  });
});

describe('validateSettings — a fully valid RunSettings produces no errors at all', () => {
  it('DEFAULT_SETTINGS itself validates clean', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
  });

  it('a fully populated, in-range RunSettings validates clean', () => {
    const settings: RunSettings = {
      provider: 'claude-code',
      concurrency: MAX_CONCURRENCY,
      assignmentTimeoutMs: 600_000,
      runTokenBudget: 100_000,
      maxCostUsd: 10,
    };
    expect(validateSettings(settings)).toEqual({});
  });
});

describe('storage helpers guard against a throwing localStorage (agent-office.settings)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('readStorage returns undefined instead of throwing when localStorage.getItem throws', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('storage disabled (private browsing)');
        },
      },
    };

    expect(() => readStorage('agent-office.settings')).not.toThrow();
    expect(readStorage('agent-office.settings')).toBeUndefined();
  });

  it('writeStorage swallows errors instead of throwing when localStorage.setItem throws', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        setItem: () => {
          throw new Error('storage disabled (private browsing)');
        },
      },
    };

    expect(() => writeStorage('agent-office.settings', JSON.stringify(DEFAULT_SETTINGS))).not.toThrow();
  });

  it('a throwing localStorage still resolves to DEFAULT_SETTINGS via parseStoredSettings(readStorage(...))', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    };

    expect(parseStoredSettings(readStorage('agent-office.settings'))).toEqual(DEFAULT_SETTINGS);
  });
});
