'use strict';

const axios = require('axios');
const AdmZip = require('adm-zip');
const path   = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function parseJsonSafe(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```json/gi, '').replace(/```/gi, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  try {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}') + 1;
    if (s >= 0 && e > s) return JSON.parse(cleaned.slice(s, e));
  } catch (_) {}
  return null;
}

// Convert  https://github.com/user/repo  →  https://github.com/user/repo/archive/refs/heads/main.zip
function repoZipUrl(githubUrl) {
  const clean = String(githubUrl || '').trim().replace(/\/$/, '');
  // Try main first; fallback handled in downloadAndReadRepo
  return `${clean}/archive/refs/heads/main.zip`;
}

function repoZipUrlFallback(githubUrl) {
  const clean = String(githubUrl || '').trim().replace(/\/$/, '');
  return `${clean}/archive/refs/heads/master.zip`;
}

// Extensions we want to read
const READ_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.ts',
  '.json', '.jsx', '.tsx', '.svg', '.md', '.txt'
]);

// Folders/files to skip
const SKIP_PATTERNS = [
  'node_modules', '.git', 'package-lock.json',
  '.min.js', '.min.css', 'dist/', 'build/'
];

function shouldSkip(entryName) {
  return SKIP_PATTERNS.some((p) => entryName.includes(p));
}

/**
 * Download a GitHub repo as ZIP, extract it, and return concatenated source code.
 * @param {string} githubUrl  e.g. https://github.com/user/repo
 * @returns {Promise<string>} All readable source code joined together
 */
async function downloadAndReadRepo(githubUrl) {
  const urls = [repoZipUrl(githubUrl), repoZipUrlFallback(githubUrl)];
  let zipBuffer = null;
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 25000,
        headers: { 'User-Agent': 'AshtaImposterEvaluator/1.0' },
        maxContentLength: 50 * 1024 * 1024   // 50 MB cap
      });
      zipBuffer = Buffer.from(response.data);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!zipBuffer) {
    const status = lastError?.response?.status;
    if (status === 404) throw new Error('GitHub repository not found or is private.');
    throw new Error('Failed to download repository: ' + (lastError?.message || 'Unknown error'));
  }

  const zip      = new AdmZip(zipBuffer);
  const entries  = zip.getEntries();
  const parts    = [];
  let   totalLen = 0;
  const MAX_CHARS = 120000;   // ~30k tokens — plenty for Groq

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (shouldSkip(name)) continue;

    const ext = path.extname(name).toLowerCase();
    if (!READ_EXTS.has(ext)) continue;

    try {
      const content = entry.getData().toString('utf8');
      const snippet = content.slice(0, 8000);   // cap per file
      parts.push(`\n\n// ===== FILE: ${name} =====\n${snippet}`);
      totalLen += snippet.length;
      if (totalLen >= MAX_CHARS) break;
    } catch (_) {
      // binary or unreadable — skip
    }
  }

  if (parts.length === 0) {
    return '(No readable source files found in this repository.)';
  }

  return parts.join('').slice(0, MAX_CHARS);
}

/**
 * Check whether a public GitHub repository exists (no auth required).
 * @param {string} githubUrl
 * @returns {Promise<boolean>}
 */
async function checkRepoExists(githubUrl) {
  const clean = String(githubUrl || '').trim().replace(/\/$/, '');
  // Extract owner/repo from URL
  const match = clean.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) return false;

  const [, owner, repo] = match;
  try {
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
      timeout: 8000,
      headers: {
        'User-Agent': 'AshtaImposterEvaluator/1.0',
        Accept: 'application/vnd.github.v3+json'
      }
    });
    return res.status === 200;
  } catch (err) {
    if (err?.response?.status === 404) return false;
    // On rate-limit or network error, assume repo exists to avoid blocking submission
    return true;
  }
}

/**
 * Evaluate a participant's repository against their assigned task using Groq AI.
 *
 * Scoring (total 100):
 *   Task Completion   40
 *   UI / UX Quality   20
 *   Code Quality      20
 *   Responsiveness    10
 *   Creativity        10
 *
 * @param {{
 *   github_repo: string,
 *   task_title: string,
 *   task_description: string,
 *   role_name: string,
 *   work_description: string,
 *   is_imposter: boolean
 * }} assignment
 * @returns {Promise<{task_completion_score,ui_score,logic_score,responsiveness_score,creativity_score,total_score,feedback}>}
 */
async function evaluateSubmission(assignment) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('GROQ_API_KEY is missing.');

  const {
    github_repo,
    task_title        = '',
    task_description  = '',
    role_name         = '',
    work_description  = ''
  } = assignment;

  if (!github_repo) throw new Error('github_repo is required for evaluation.');

  // Step 1: download repo
  let sourceCode;
  try {
    sourceCode = await downloadAndReadRepo(github_repo);
  } catch (err) {
    throw new Error('Repository download failed: ' + err.message);
  }

  // Step 2: build task-aware prompt
  const prompt = `You are a strict hackathon judge evaluating a participant's submission for the ASTHRA Imposter Coding Event.

ASSIGNED TASK
Title: ${task_title}
Description: ${task_description}

ASSIGNED ROLE
Role: ${role_name}
Work Required: ${work_description}

SUBMITTED REPOSITORY
GitHub URL: ${github_repo}

SOURCE CODE EXTRACTED FROM REPOSITORY:
${sourceCode}

EVALUATION CRITERIA (Total: 100 marks)
1. Task Completion (40 marks) — Does the implementation actually address the assigned task and role description? Are the required features present and working?
2. UI / UX Quality (20 marks) — Is the interface clean, usable, and visually appropriate?
3. Code Quality & Logic (20 marks) — Is the JavaScript logic correct? Is the code readable and structured?
4. Responsiveness (10 marks) — Does the layout work on different screen sizes (CSS media queries, flexbox/grid)?
5. Creativity (10 marks) — Any creative enhancements beyond the minimum requirements?

IMPORTANT RULES:
- Base scores ONLY on the source code provided above.
- If source code is empty or trivial, score Task Completion as 0.
- Do NOT award full marks without justification.
- Be strict but fair.

Return ONLY valid JSON in this exact format (no markdown, no extra text):
{
  "task_completion_score": 0,
  "ui_score": 0,
  "logic_score": 0,
  "responsiveness_score": 0,
  "creativity_score": 0,
  "total_score": 0,
  "feedback": "Brief evaluation summary in 2-3 sentences."
}`;

  // Step 3: call Groq
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model:       'llama-3.3-70b-versatile',
      temperature: 0.15,
      messages: [
        {
          role:    'system',
          content: 'You are a strict coding competition judge. Return only valid JSON matching the exact schema requested. Do not include any text outside the JSON object.'
        },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        Authorization:  `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );

  const content = response?.data?.choices?.[0]?.message?.content;
  const parsed  = parseJsonSafe(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Groq returned invalid JSON: ' + String(content).slice(0, 200));
  }

  const task_completion_score = clamp(parsed.task_completion_score, 0, 40);
  const ui_score              = clamp(parsed.ui_score,              0, 20);
  const logic_score           = clamp(parsed.logic_score,           0, 20);
  const responsiveness_score  = clamp(parsed.responsiveness_score,  0, 10);
  const creativity_score      = clamp(parsed.creativity_score,      0, 10);

  const computed_total = task_completion_score + ui_score + logic_score + responsiveness_score + creativity_score;
  const total_score    = clamp(parsed.total_score ?? computed_total, 0, 100);

  return {
    task_completion_score,
    ui_score,
    logic_score,
    responsiveness_score,
    creativity_score,
    total_score,
    feedback: String(parsed.feedback || 'Repository evaluated.').slice(0, 1000)
  };
}

// Legacy scorer (kept for backwards compatibility with /score/:id route)
async function scoreRepository(githubUrl) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('GROQ_API_KEY is missing.');

  const prompt = `Evaluate this GitHub repository for the Asthra Imposter competition: ${githubUrl}
Score each category from 0 to 10: UI/Design, Logic/Functionality, Creativity, Secret Imposter Task.
Return STRICT JSON only: {"ui_score":0,"logic_score":0,"creativity_score":0,"imposter_score":0,"total_score":0,"feedback":""}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile', temperature: 0.2,
      messages: [
        { role: 'system', content: 'Return only valid JSON.' },
        { role: 'user',   content: prompt }
      ],
      response_format: { type: 'json_object' }
    },
    { headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' } }
  );

  const parsed = parseJsonSafe(response?.data?.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('Groq returned invalid JSON.');

  const ui_score          = clamp(parsed.ui_score,         0, 10);
  const logic_score       = clamp(parsed.logic_score,      0, 10);
  const creativity_score  = clamp(parsed.creativity_score, 0, 10);
  const imposter_score    = clamp(parsed.imposter_score,   0, 10);
  const total_score       = clamp(parsed.total_score || (ui_score + logic_score + creativity_score + imposter_score), 0, 40);

  return { ui_score, logic_score, creativity_score, imposter_score, total_score: Math.min(total_score, 40), feedback: String(parsed.feedback || '') };
}

module.exports = { scoreRepository, evaluateSubmission, downloadAndReadRepo, checkRepoExists };
