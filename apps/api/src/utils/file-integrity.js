import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveStoredFilePath(uploadDir, storedName) {
  if (typeof storedName !== 'string' || !STORED_NAME.test(storedName)) {
    throw new Error('Stored document filename is invalid');
  }
  const root = path.resolve(uploadDir);
  const resolved = path.resolve(root, storedName);
  if (path.dirname(resolved) !== root) throw new Error('Stored document path escapes upload directory');
  return resolved;
}

export async function verifyFileSha256(filePath, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error('Stored document checksum is invalid');
  }
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Stored document is not a regular file');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  const actual = Buffer.from(hash.digest('hex'), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}
