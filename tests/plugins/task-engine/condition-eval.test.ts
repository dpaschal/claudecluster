import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../../../src/plugins/task-engine/condition-eval.js';

describe('Condition Evaluator', () => {
  const parentContext = {
    build: { exitCode: 0, stdout: 'Build OK\n0 failures', stderr: '', state: 'completed' },
    test: { exitCode: 1, stdout: '3 failures', stderr: 'Error', state: 'failed' },
  };

  it('evaluates simple exit code check', () => {
    expect(evaluateCondition('parent.build.exitCode === 0', parentContext)).toBe(true);
    expect(evaluateCondition('parent.test.exitCode === 0', parentContext)).toBe(false);
  });

  it('evaluates string includes', () => {
    expect(evaluateCondition("parent.build.stdout.includes('0 failures')", parentContext)).toBe(true);
    expect(evaluateCondition("parent.test.stdout.includes('0 failures')", parentContext)).toBe(false);
  });

  it('evaluates compound conditions', () => {
    expect(evaluateCondition(
      "parent.build.exitCode === 0 && parent.build.stdout.includes('OK')",
      parentContext,
    )).toBe(true);
  });

  it('evaluates regex', () => {
    expect(evaluateCondition('/\\d+ failures/.test(parent.test.stdout)', parentContext)).toBe(true);
  });

  it('returns true for null/empty condition', () => {
    expect(evaluateCondition(null, parentContext)).toBe(true);
    expect(evaluateCondition('', parentContext)).toBe(true);
    expect(evaluateCondition(undefined, parentContext)).toBe(true);
  });

  it('returns false on evaluation error', () => {
    expect(evaluateCondition('nonexistent.foo.bar', parentContext)).toBe(false);
  });

  it('cannot access process or require', () => {
    expect(evaluateCondition("typeof process !== 'undefined'", parentContext)).toBe(false);
    expect(evaluateCondition("typeof require !== 'undefined'", parentContext)).toBe(false);
  });

  it('times out on infinite loops', () => {
    expect(evaluateCondition('(() => { while(true){} })()', parentContext)).toBe(false);
  });

  it('supports workflow context', () => {
    const workflowCtx = { version: '1.2.3' };
    expect(evaluateCondition(
      "workflow.context.version === '1.2.3'",
      parentContext,
      workflowCtx,
    )).toBe(true);
  });

  it('prevents code generation from strings', () => {
    // eval() and Function() should be blocked
    expect(evaluateCondition("eval('1+1') === 2", parentContext)).toBe(false);
  });
});
