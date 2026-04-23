import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigration({ url, slug, outputDir, maxPages = 21, onLog }) {
  return new Promise((resolve, reject) => {
    const script = join(__dirname, 'migrate-duda.mjs');
    const proc = spawn('node', [
      script,
      '--url', url,
      '--slug', slug,
      '--output-dir', outputDir,
      '--pages', String(maxPages),
    ], {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onLog));
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onLog));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Migration exited with code ${code}`));
    });
  });
}
