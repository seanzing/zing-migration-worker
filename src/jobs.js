import { v4 as uuid } from 'uuid';
import { mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { runMigration } from './migrate-runner.js';
import { pushToGitHub } from './github.js';
import { createJobRecord, completeJobRecord, failJobRecord } from './supabase.js';

const MAX_CONCURRENT = 2;

// GitHub push mutex — serializes all GitHub operations across concurrent jobs.
// Playwright crawls run in parallel; only one job at a time pushes to GitHub.
let githubPushRunning = false;
const githubPushQueue = [];

export function queueGitHubPush(fn) {
  return new Promise((resolve, reject) => {
    githubPushQueue.push({ fn, resolve, reject });
    drainGitHubQueue();
  });
}

async function drainGitHubQueue() {
  if (githubPushRunning || githubPushQueue.length === 0) return;
  githubPushRunning = true;
  const { fn, resolve, reject } = githubPushQueue.shift();
  try {
    resolve(await fn());
  } catch (err) {
    reject(err);
  } finally {
    githubPushRunning = false;
    drainGitHubQueue();
  }
}

function generateSiteId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(__dirname, '../node_modules/.bin/wrangler');

async function deployToCloudflare(slug, siteDir, onLog) {
  const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!CF_TOKEN || !CF_ACCOUNT) {
    onLog('Warning: CLOUDFLARE_API_TOKEN/ACCOUNT_ID not set — skipping CF deploy');
    return null;
  }

  // Create project if needed
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slug, production_branch: 'main' }),
  });

  onLog('Deploying to Cloudflare Pages...');

  // Run wrangler with up to 3 retries (EPIPE is transient on large sites)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await new Promise((resolve) => {
      const proc = spawn(WRANGLER, ['pages', 'deploy', siteDir, '--project-name', slug, '--branch', 'main', '--commit-dirty=true'], {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT },
      });
      let out = '';
      proc.stdout.on('data', d => { out += d; d.toString().split('\n').filter(Boolean).forEach(onLog); });
      proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onLog));
      proc.on('close', code => resolve({ code, out }));
    });

    if (result.code === 0) {
      const previewUrl = `https://${slug}.pages.dev`;
      onLog(`✅ Deployed to ${previewUrl}`);
      return previewUrl;
    }
    if (attempt < 3) {
      onLog(`Wrangler attempt ${attempt} failed (code ${result.code}), retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    } else {
      onLog(`Warning: Wrangler deploy failed after 3 attempts — site files are in GitHub`);
      return null;
    }
  }
}

const jobs = new Map();
let runningCount = 0;
const queue = [];

export function createJob(url, slugOrNull, name) {
  const slug = slugOrNull || generateSiteId();
  const job = {
    id: uuid(),
    url,
    slug,
    name: name || '',
    status: 'queued',
    logs: [],
    subscribers: new Set(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
  };
  jobs.set(job.id, job);

  // Persist to Supabase immediately so job survives Railway blue-green restarts
  createJobRecord({ slug, name: name || '', sourceUrl: url }).catch(err => {
    console.warn(`[supabase] Failed to create job record for ${slug}: ${err.message}`);
  });

  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function getAllJobs() {
  return [...jobs.values()].map(j => ({
    id: j.id,
    url: j.url,
    slug: j.slug,
    name: j.name,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    result: j.result,
  }));
}

export function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'running') return false;
  jobs.delete(id);
  return true;
}

export function getJobCount() {
  return jobs.size;
}

function broadcast(job, line) {
  job.logs.push(line);
  for (const res of job.subscribers) {
    try {
      res.write(`data: ${line}\n\n`);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

export function enqueue(job) {
  queue.push(job);
  runNext();
}

function runNext() {
  while (runningCount < MAX_CONCURRENT && queue.length > 0) {
    runningCount++;
    const job = queue.shift();
    processJob(job).finally(() => {
      runningCount--;
      runNext();
    });
  }
}

async function processJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const outputDir = '/tmp/migrations';
  const siteOutputDir = join(outputDir, job.slug);
  // Always wipe the output dir before migrating — prevents stale files from
  // prior runs on the same Railway instance polluting the new migration.
  rmSync(siteOutputDir, { recursive: true, force: true });
  mkdirSync(siteOutputDir, { recursive: true });

  broadcast(job, `Starting migration for ${job.url} → ${job.slug}`);

  try {
    // Run the Playwright migration
    await runMigration({
      url: job.url,
      slug: job.slug,
      outputDir: outputDir,
      maxPages: 21,
      onLog: (line) => broadcast(job, line),
    });

    broadcast(job, 'Migration complete. Queuing GitHub push...');

    // Push to GitHub — serialized via mutex to avoid secondary rate limits
    const { filesUploaded } = await queueGitHubPush(async () => {
      broadcast(job, 'Pushing to GitHub...');
      return pushToGitHub(job.slug, siteOutputDir, (line) => broadcast(job, line));
    });
    broadcast(job, `Pushed ${filesUploaded} files to GitHub.`);

    // Deploy to Cloudflare Pages (non-fatal)
    const previewUrl = await deployToCloudflare(job.slug, siteOutputDir, (line) => broadcast(job, line));

    // Update Supabase record to draft + preview_url (non-fatal, 15s timeout)
    broadcast(job, 'Updating Supabase record...');
    try {
      await Promise.race([
        completeJobRecord({ slug: job.slug, previewUrl }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase timeout')), 15000)),
      ]);
      broadcast(job, 'Supabase record updated.');
    } catch (sbErr) {
      broadcast(job, `Warning: Supabase update skipped — ${sbErr.message}`);
    }

    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.result = { pagesWritten: filesUploaded, assetsDownloaded: 0, siteId: job.slug, previewUrl };
    broadcast(job, '[DONE]');

    // Close SSE connections
    for (const res of job.subscribers) {
      try { res.end(); } catch {}
    }
    job.subscribers.clear();

  } catch (err) {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.error = err.message;
    broadcast(job, `[ERROR] ${err.message}`);
    failJobRecord({ slug: job.slug, errorMsg: err.message }).catch(() => {});

    for (const res of job.subscribers) {
      try { res.end(); } catch {}
    }
    job.subscribers.clear();
  }
}
