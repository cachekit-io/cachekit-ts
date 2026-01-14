import { describe, it, expect } from 'vitest';
import { withDegradation, withDegradationFn, degradationBehaviors } from './degradation';

describe('withDegradation', () => {
  it('returns result on success', async () => {
    const result = await withDegradation(() => Promise.resolve('value'), 'fallback');
    expect(result).toBe('value');
  });

  it('returns fallback on error', async () => {
    const result = await withDegradation(() => Promise.reject(new Error()), 'fallback');
    expect(result).toBe('fallback');
  });
});

describe('withDegradationFn', () => {
  it('returns result on success', async () => {
    const result = await withDegradationFn(() => Promise.resolve('value'), () => 'fallback');
    expect(result).toBe('value');
  });

  it('calls fallback function on error', async () => {
    const result = await withDegradationFn(
      () => Promise.reject(new Error('test error')),
      (err) => `caught: ${err.message}`
    );
    expect(result).toBe('caught: test error');
  });
});

describe('degradationBehaviors', () => {
  it('getFailsNull returns null on failure', async () => {
    const result = await degradationBehaviors.getFailsNull();
    expect(result).toBeNull();
  });

  it('setFailsSkip returns undefined on failure', async () => {
    const result = await degradationBehaviors.setFailsSkip();
    expect(result).toBeUndefined();
  });

  it('wrapFailsCompute executes compute function', async () => {
    const computeFn = async () => 'computed-value';
    const result = await degradationBehaviors.wrapFailsCompute(computeFn)();
    expect(result).toBe('computed-value');
  });
});
