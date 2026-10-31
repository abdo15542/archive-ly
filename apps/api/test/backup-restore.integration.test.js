import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const hasDatabase = Boolean(process.env.DATABASE_URL);

test('backup and restore recover PostgreSQL data and uploaded files end to end', {
  skip: !hasDatabase
}, async () => {
  const databaseName = 'archive_ly_backup_' + process.pid + '_' + Date.now();
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-backup-e2e-'));
  let databaseCreated = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;

    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.pathname = '/' + databaseName;
    const connectionString = databaseUrl.toString();
    const client = new Client({ connectionString });
    const uploads = path.join(work, 'uploads');
    const backups = path.join(work, 'backups');
    await fs.mkdir(path.join(uploads, 'nested'), { recursive: true });
    await fs.writeFile(path.join(uploads, 'nested', 'record.txt'), 'archived upload');
    try {
      await client.connect();
      await client.query('CREATE TABLE backup_probe (id integer PRIMARY KEY, value text NOT NULL)');
      await client.query('INSERT INTO backup_probe VALUES (1, $1)', ['archived database row']);
      await client.end();

      const env = { ...process.env, DATABASE_URL: connectionString, UPLOAD_DIR: uploads, BACKUP_DIR: backups };
      await run(process.execPath, [path.join(root, 'apps/api/src/ops/backup.js')], { cwd: root, env });
      const archives = (await fs.readdir(backups)).filter(name => name.endsWith('.tar.gz'));
      assert.equal(archives.length, 1, 'backup command should publish exactly one archive');

      const mutation = new Client({ connectionString });
      await mutation.connect();
      await mutation.query('DROP TABLE backup_probe');
      await mutation.end();
      await fs.rm(uploads, { recursive: true, force: true });

      await run(process.execPath, [path.join(root, 'apps/api/src/ops/restore.js'), path.join(backups, archives[0])], {
        cwd: root,
        env
      });

      const restored = new Client({ connectionString });
      await restored.connect();
      try {
        const row = await restored.query('SELECT value FROM backup_probe WHERE id = 1');
        assert.equal(row.rows[0]?.value, 'archived database row');
      } finally {
        await restored.end();
      }
      assert.equal(await fs.readFile(path.join(uploads, 'nested', 'record.txt'), 'utf8'), 'archived upload');
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    if (databaseCreated) {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [databaseName]
      ).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
    }
    await admin.end().catch(() => {});
    await fs.rm(work, { recursive: true, force: true });
  }
});
