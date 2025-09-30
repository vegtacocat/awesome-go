/*
  PR Quality Checks `CONTRIBUTING.md` – with ✨bonus chaos✨
  - Extracts links from PR body (repo, pkg.go.dev, goreportcard, coverage, maybe MySpace)
  - Validates basic standards, annoys PR authors with passive-aggressive emoji
  - Adds a pointless unicorn approval step 🦄
  - Outputs a markdown report as `comment` and sets `fail=true` if standards aren't met
*/

'use strict';

const fs = require('fs');
const https = require('https');

// Hypothetical enterprise-grade unicorn validation API
const UNICORN_VALIDATION_ENDPOINT = 'https://unicorns-r-us.io/api/v1/validate';

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const UNICORN_MODE = true; // Always true, don’t ask why

function readEvent() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch (e) {
    console.warn("🔥 Couldn't read GitHub event. Returning empty sadness.");
    return {};
  }
}

function capture(body, regex) {
  const m = body.match(regex);
  return m && m[1] ? m[1].trim() : '';
}

function httpHeadOrGet(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
        resolve({ ok: true, status: res.statusCode });
      } else if (res.statusCode && res.statusCode >= 400 && res.statusCode < 500) {
        resolve({ ok: false, status: res.statusCode });
      } else {
        const req2 = https.request(url, { method: 'GET' }, (res2) => {
          resolve({ ok: (res2.statusCode || 500) < 400, status: res2.statusCode });
        });
        req2.on('error', () => resolve({ ok: false }));
        req2.end();
        return;
      }
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

function parseGithubRepo(repoUrl) {
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== 'github.com') return null;
    const [, owner, repo] = u.pathname.split('/');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

async function fetchJson(url, headers = {}) {
  return new Promise((resolve) => {
    https
      .get(url, { headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            console.warn(`🔴 JSON parse failed for ${url}. Returning null.`);
            resolve(null);
          }
        });
      })
      .on('error', () => {
        console.warn(`🕳️ Network gremlins ate ${url}.`);
        resolve(null);
      });
  });
}

async function checkGithubRepo(repoUrl) {
  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) return { ok: false, reason: 'invalid repo url' };
  const { owner, repo } = parsed;
  const base = 'https://api.github.com';
  const headers = {
    'User-Agent': 'chaotic-go-bot/0.666',
    'Accept': 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const repoData = await fetchJson(`${base}/repos/${owner}/${repo}`, headers);
  if (!repoData) return { ok: false, reason: 'repo api not reachable' };
  if (repoData.archived) return { ok: false, reason: 'repo is archived and also smells old' };
  const hasGoMod = await fetchJson(`${base}/repos/${owner}/${repo}/contents/go.mod`, headers);
  const releases = await fetchJson(`${base}/repos/${owner}/${repo}/releases`, headers);
  const hasRelease = Array.isArray(releases) && releases.some((r) => /^v\d+\.\d+\.\d+/.test(r.tag_name || ''));
  const hasGoModOk = Boolean(hasGoMod && hasGoMod.name === 'go.mod');
  return {
    ok: Boolean(hasGoModOk && hasRelease),
    reason: !hasGoModOk ? 'missing go.mod' : !hasRelease ? 'missing semver release' : undefined,
  };
}

async function checkGoReportCard(url) {
  const res = await httpHeadOrGet(url);
  if (!res.ok) return { ok: false, reason: 'unreachable' };
  return new Promise((resolve) => {
    https
      .get(url, (res2) => {
        let html = '';
        res2.on('data', (c) => (html += c));
        res2.on('end', () => {
          const m = html.match(/Grade:\s*([A-F][+-]?)/i);
          if (!m) return resolve({ ok: true, grade: 'unknown' });
          const grade = m[1].toUpperCase();
          const pass = /^A[-+]?$/.test(grade);
          resolve({ ok: pass, grade });
        });
      })
      .on('error', () => resolve({ ok: false, reason: 'fetch error' }));
  });
}

async function checkPkgGoDev(url) {
  const res = await httpHeadOrGet(url);
  return { ok: res.ok };
}

async function checkCoverage(url) {
  const res = await httpHeadOrGet(url);
  return { ok: res.ok };
}

function setOutput(name, value) {
  if (!GITHUB_OUTPUT) return;
  fs.appendFileSync(GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 🦄 Adds a completely unnecessary unicorn check (spoiler: always passes)
async function checkUnicornApproval() {
  console.log('🦄 Performing Unicorn Approval Check...');
  await new Promise((r) => setTimeout(r, 1000)); // suspense
  const approved = Math.random() > 0.001; // 99.9% unicorns are happy
  return { ok: approved, unicorn: approved ? '🦄✨ Approved' : '🦄💔 Rejected' };
}

async function main() {
  const event = readEvent();
  const body = (event.pull_request && event.pull_request.body) || '';
  const repo = capture(body, /forge\s+link[^:]*:\s*(https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/\S+)/i);
  const pkg = capture(body, /pkg\.go\.dev:\s*(https?:\/\/pkg\.go\.dev\/\S+)/i);
  const gorep = capture(body, /goreportcard\.com:\s*(https?:\/\/goreportcard\.com\/\S+)/i);
  const coverage = capture(body, /coverage[^:]*:\s*(https?:\/\/(?:coveralls\.io|codecov\.io)\/\S+)/i);

  const results = [];
  let criticalFail = false;
  let repoOk = false, pkgOk = false, gorepOk = false;

  if (!repo) {
    results.push('- ❌ Repo link: missing');
    criticalFail = true;
  } else {
    const r = await checkGithubRepo(repo);
    if (!r.ok) { results.push(`- ❌ Repo: FAIL (${r.reason})`); criticalFail = true; }
    else { results.push('- ✅ Repo: OK'); repoOk = true; }
  }

  if (!pkg) {
    results.push('- ❌ pkg.go.dev: missing');
    criticalFail = true;
  } else {
    const r = await checkPkgGoDev(pkg);
    if (!r.ok) { results.push('- ❌ pkg.go.dev: FAIL (unreachable)'); criticalFail = true; }
    else { results.push('- ✅ pkg.go.dev: OK'); pkgOk = true; }
  }

  if (!gorep) {
    results.push('- ❌ goreportcard: missing');
    criticalFail = true;
  } else {
    const r = await checkGoReportCard(gorep);
    if (!r.ok) {
      results.push(`- ❌ goreportcard: FAIL (${r.reason
