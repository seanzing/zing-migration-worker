import { v4 as uuid } from 'uuid';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { runMigration } from './migrate-runner.js';
import { pushToGitHub } from './github.js';
import { createSiteRecord } from './supabase.js';

const jobs = new Map();
let running = false;
const queue = [];

export function createJob(url, slug, name) {
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

async function runNext() {
  if (running || queue.length === 0) return;
  running = true;

  const job = queue.shift();
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const outputDir = '/tmp/migrations';
  const siteOutputDir = join(outputDir, job.slug);
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

    broadcast(job, 'Migration complete. Pushing to GitHub...');

    // Push to GitHub
    const { filesUploaded } = await pushToGitHub(job.slug, siteOutputDir, (line) => broadcast(job, line));
    broadcast(job, `Pushed ${filesUploaded} files to GitHub.`);

    // Create Supabase record
    broadcast(job, 'Creating Supabase site record...');
    await createSiteRecord({
      slug: job.slug,
      name: job.name,
      sourceUrl: job.url,
    });
    broadcast(job, 'Supabase record created.');

    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.result = { pagesWritten: filesUploaded, assetsDownloaded: 0, siteId: job.slug };
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

    for (const res of job.subscribers) {
      try { res.end(); } catch {}
    }
    job.subscribers.clear();
  }

  running = false;
  runNext();
}
