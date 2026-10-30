import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const userSchema=z.object({
 fullName:z.string().trim().min(2).max(160),
 email:z.string().trim().email().max(254),
 password:z.string().min(10).max(128),
 role:z.enum(['admin','archivist','viewer','user'])
});
test('accepts a valid archivist account',()=>{
 assert.equal(userSchema.safeParse({fullName:'أمين الأرشيف',email:'archivist@example.com',password:'StrongPass123',role:'archivist'}).success,true);
});
test('rejects a weak password for a managed account',()=>{
 assert.equal(userSchema.safeParse({fullName:'مستخدم',email:'user@example.com',password:'123',role:'viewer'}).success,false);
});
test('rejects unknown user roles',()=>{
 assert.equal(userSchema.safeParse({fullName:'مستخدم',email:'user@example.com',password:'StrongPass123',role:'owner'}).success,false);
});
