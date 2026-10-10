import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_POLICY,
  MAX_MODEL_ENV_VAR,
  MIN_MODEL_ENV_VAR,
  applyModelPolicy,
  resolveModelPolicy,
} from './modelPolicy.js';

describe('applyModelPolicy — the default sonnet floor', () => {
  it('raises haiku to sonnet, which is the whole point', () => {
    const decision = applyModelPolicy('haiku');

    expect(decision.model).toBe('sonnet');
    // The reason is what reaches diagnostics.jsonl, where the question months
    // later is "why did this agent run on something its file does not name".
    expect(decision.reason).toContain('haiku');
    expect(decision.reason).toContain('sonnet');
  });

  it('leaves sonnet and opus exactly as declared', () => {
    // Both bounds are INCLUSIVE. A policy that quietly moved opus down, or
    // sonnet up, would be a different policy than the one documented.
    expect(applyModelPolicy('sonnet')).toEqual({ model: 'sonnet' });
    expect(applyModelPolicy('opus')).toEqual({ model: 'opus' });
  });

  it('leaves inherit alone, because it defers to the operator', () => {
    // 25 of the 156 catalog agents say `inherit`. It means "whatever this
    // deployment's engine defaults to" — clamping it would be the policy
    // overriding the person who set the policy.
    expect(applyModelPolicy('inherit')).toEqual({ model: 'inherit' });
  });

  it('leaves an unrecognised word alone rather than guessing its rank', () => {
    // A tier this code cannot rank is a tier it must not rewrite: an author
    // naming some future model would otherwise be silently downgraded.
    expect(applyModelPolicy('sonnet-9-ultra')).toEqual({ model: 'sonnet-9-ultra' });
  });

  it('says nothing for an agent that declares no model', () => {
    // 8 agents omit it. Inventing one here would pin them to a tier no author
    // chose, which is the same overreach as rewriting an unknown word.
    expect(applyModelPolicy(undefined)).toEqual({ model: undefined });
  });

  it('is case- and whitespace-insensitive about the declaration', () => {
    expect(applyModelPolicy('  Haiku ').model).toBe('sonnet');
  });
});

describe('applyModelPolicy — a narrower range', () => {
  it('lowers a model above the ceiling', () => {
    const decision = applyModelPolicy('opus', { min: 'haiku', max: 'sonnet' });

    expect(decision.model).toBe('sonnet');
    expect(decision.reason).toContain('ceiling');
  });

  it('accepts haiku when the deployment lowers its own floor', () => {
    expect(applyModelPolicy('haiku', { min: 'haiku', max: 'opus' })).toEqual({ model: 'haiku' });
  });
});

describe('resolveModelPolicy', () => {
  it('defaults to sonnet through opus, which excludes haiku', () => {
    expect(resolveModelPolicy({})).toEqual(DEFAULT_MODEL_POLICY);
    expect(DEFAULT_MODEL_POLICY).toEqual({ min: 'sonnet', max: 'opus' });
  });

  it('reads an override from the environment', () => {
    const policy = resolveModelPolicy({ [MIN_MODEL_ENV_VAR]: 'haiku', [MAX_MODEL_ENV_VAR]: 'sonnet' });

    expect(policy).toEqual({ min: 'haiku', max: 'sonnet' });
  });

  it('throws on a tier it does not know, rather than falling back to the default', () => {
    // Failing open would make every later "why did this run on haiku" question
    // unanswerable: the operator would have stated a rule and been ignored.
    expect(() => resolveModelPolicy({ [MIN_MODEL_ENV_VAR]: 'sonet' })).toThrow(/not a known model tier/);
  });

  it('throws on an inverted range instead of producing one nothing satisfies', () => {
    expect(() =>
      resolveModelPolicy({ [MIN_MODEL_ENV_VAR]: 'opus', [MAX_MODEL_ENV_VAR]: 'haiku' }),
    ).toThrow(/range is empty/);
  });

  it('treats an empty variable as unset', () => {
    expect(resolveModelPolicy({ [MIN_MODEL_ENV_VAR]: '   ' })).toEqual(DEFAULT_MODEL_POLICY);
  });
});
