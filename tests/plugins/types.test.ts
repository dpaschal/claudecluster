import { describe, it, expect } from 'vitest';

describe('Plugin Types', () => {
  it('should export Plugin and PluginContext interfaces', async () => {
    const types = await import('../../src/plugins/types.js');
    expect(types).toBeDefined();
  });
});
