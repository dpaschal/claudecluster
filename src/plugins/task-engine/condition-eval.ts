import vm from 'node:vm';

const TIMEOUT_MS = 100;

export function evaluateCondition(
  condition: string | null | undefined,
  parentResults: Record<string, { exitCode: number; stdout: string; stderr: string; state: string }>,
  workflowContext?: Record<string, unknown>,
): boolean {
  if (!condition || condition.trim() === '') return true;

  try {
    const sandbox = Object.freeze({
      parent: Object.freeze(
        Object.fromEntries(
          Object.entries(parentResults).map(([k, v]) => [k, Object.freeze({ ...v })]),
        ),
      ),
      workflow: Object.freeze({
        context: Object.freeze(workflowContext ?? {}),
      }),
    });

    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    const result = vm.runInContext(`(${condition})`, context, { timeout: TIMEOUT_MS });
    return Boolean(result);
  } catch {
    return false;
  }
}
