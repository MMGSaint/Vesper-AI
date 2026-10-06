import { describe, expect, it } from 'vitest';
import { createMcpProjection } from '../../src/vesper/mcp.ts';

function registry() {
  const tools = new Map<string, any>();
  return {
    list: () => [{ name:'read_test', description:'test', permission:'read', parameters:{type:'object',properties:{}} }],
    invoke: async (input:any) => ({ result:{ok:true,summary:'done',data:{tool:input.name},epistemic:'checked'}, decision:{reason:'ok'} }),
  } as any;
}

describe('MCP projection', () => {
  it('exposes registry tools using MCP tools/list shape', async () => {
    const result = await createMcpProjection(registry(), 'default').handle({jsonrpc:'2.0',id:1,method:'tools/list'});
    expect(result.result?.tools).toHaveLength(1);
    expect((result.result?.tools as any[])[0].inputSchema.type).toBe('object');
  });

  it('routes tools/call through the existing registry', async () => {
    const result = await createMcpProjection(registry(), 'default').handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_test',arguments:{}}});
    expect((result.result?.content as any[])[0].text).toBe('done');
  });
});
