import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const schema=z.object({
  title:z.string().trim().min(2).max(250),
  documentDate:z.string().date().optional()
});
test('accepts valid Arabic document metadata',()=>{
  const result=schema.safeParse({title:'قرار إداري',documentDate:'2026-10-30'});
  assert.equal(result.success,true);
});
test('rejects empty document title',()=>{
  assert.equal(schema.safeParse({title:' '}).success,false);
});
test('rejects malformed calendar date',()=>{
  assert.equal(schema.safeParse({title:'مراسلة',documentDate:'2026-99-99'}).success,false);
});
