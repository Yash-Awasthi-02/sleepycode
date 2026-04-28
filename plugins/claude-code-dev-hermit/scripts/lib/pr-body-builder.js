'use strict';

// pr-body-builder.js
// Pure-function module — no I/O. Assembles a PR title and body from structured
// inputs (commits, quality report, binding, screenshots, config, project template).
//
// Library API:
//   const { buildPRContent } = require('./pr-body-builder');
//   const { title, body, sectionsCount, screenshotsCount } = buildPRContent({ ... });
//
// CLI:
//   node pr-body-builder.js '<json>'
//   prints JSON to stdout.

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS = ['summary', 'context', 'risk', 'verification', 'notes'];

// Conventional-commit prefix regex — strip from subjects for readability.
const CONVENTIONAL_PREFIX_RE = /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?!?:\s*/i;

// ── section builders (each returns a string block or null if no data) ───────

function buildSummary(commits) {
  if (!commits || commits.length === 0) return null;
  // Deduplicate by subject, strip conventional prefixes.
  const seen = new Set();
  const bullets = [];
  for (const c of commits) {
    const subject = (c.subject || '').replace(CONVENTIONAL_PREFIX_RE, '').trim();
    if (subject && !seen.has(subject)) {
      seen.add(subject);
      bullets.push(`- ${subject}`);
    }
  }
  return bullets.length ? `## Summary\n\n${bullets.join('\n')}` : null;
}

function buildContext(binding) {
  if (!binding?.external?.url) return null;
  const { source, id, url, title } = binding.external;
  const label = [source, id].filter(Boolean).join(' ') || 'Link';
  const text = title ? `**[${label}](${url})** — ${title}` : `**[${label}](${url})**`;
  return `## Context\n\n${text}`;
}

function buildRisk(qualityReport) {
  if (!qualityReport?.risk?.level) return null;
  const { level, reason } = qualityReport.risk;
  const capitalized = level.charAt(0).toUpperCase() + level.slice(1);
  return `## Risk\n\n**${capitalized}**${reason ? ` — ${reason}` : ''}`;
}

function buildVerification(qualityReport, screenshots) {
  const lines = [];

  if (qualityReport) {
    const { test, typecheck, lint, simplify } = qualityReport;
    if (test) {
      const dur = test.duration_secs != null ? ` (${test.duration_secs}s)` : '';
      lines.push(`- Tests: **${test.status}**${dur}`);
    }
    if (typecheck) lines.push(`- Typecheck: **${typecheck.status}**`);
    if (lint) lines.push(`- Lint: **${lint.status}**`);
    if (simplify) lines.push(`- Simplify: **${simplify}**`);
  }

  if (screenshots && screenshots.length > 0) {
    for (const s of screenshots) {
      const alt = s.criterion || 'screenshot';
      // URL-based: embed directly. Path-based: embed as repo-relative path.
      const src = s.path;
      lines.push(`- ${alt}: ![${alt}](${src})`);
    }
  }

  return lines.length ? `## Verification\n\n${lines.join('\n')}` : null;
}

function buildNotes(qualityReport) {
  const concerns = qualityReport?.concerns;
  if (!concerns || !concerns.trim()) return null;
  return `## Notes\n\n${concerns.trim()}`;
}

// ── section registry ────────────────────────────────────────────────────────

const SECTION_BUILDERS = {
  summary: (opts) => buildSummary(opts.commits),
  context: (opts) => buildContext(opts.binding),
  risk: (opts) => buildRisk(opts.qualityReport),
  verification: (opts) => buildVerification(opts.qualityReport, opts.screenshots),
  notes: (opts) => buildNotes(opts.qualityReport),
};

// ── title ───────────────────────────────────────────────────────────────────

function buildTitle({ commits, binding, config, branch }) {
  const format = config?.pr_title_format || null;
  const ticket = binding?.external?.id || null;
  const firstSubject = commits?.[0]?.subject || '';
  const firstCommit = firstSubject.replace(CONVENTIONAL_PREFIX_RE, '').trim();
  const branchSlug = (branch || '').replace(/\//g, '-');

  if (format) {
    return format
      .replace('{ticket}', ticket || '')
      .replace('{first_commit}', firstCommit)
      .replace('{branch}', branchSlug)
      .trim();
  }

  if (ticket) return `${ticket}: ${firstCommit}`.trim();
  return firstCommit || branchSlug || 'chore: update';
}

// ── template merge ──────────────────────────────────────────────────────────

// Maps template heading names → our section keys.
const TEMPLATE_HEADING_MAP = {
  summary: 'summary',
  context: 'context',
  risk: 'risk',
  verification: 'verification',
  'test plan': 'verification',
  'testing': 'verification',
  notes: 'notes',
};

function fillTemplate(template, sectionContents) {
  // Split template on ## headings (keep the delimiter).
  const parts = template.split(/(?=^## )/m);
  let replacedCount = 0;
  const filled = parts.map((part) => {
    const headingMatch = part.match(/^## (.+)/);
    if (!headingMatch) return part;
    const headingKey = headingMatch[1].trim().toLowerCase();
    const sectionKey = TEMPLATE_HEADING_MAP[headingKey];
    if (!sectionKey || !sectionContents[sectionKey]) return part;
    // Replace the content after the heading with our section body (skip the ## line).
    const ourContent = sectionContents[sectionKey].replace(/^## .+\n\n?/, '');
    replacedCount += 1;
    return `## ${headingMatch[1]}\n\n${ourContent}\n`;
  });

  return { body: filled.join(''), replacedCount };
}

// ── main builder ─────────────────────────────────────────────────────────────

function buildPRContent({
  commits,
  qualityReport,
  binding,
  screenshots,
  config,
  projectTemplate,
  branch,
}) {
  if (!qualityReport) throw new Error('qualityReport is required');

  const opts = { commits, qualityReport, binding, screenshots, config, branch };
  const sections = config?.pr_body_sections ?? DEFAULT_SECTIONS;

  // Build all section content up-front so template fill can reference any of them.
  const sectionContents = {};
  for (const [key, fn] of Object.entries(SECTION_BUILDERS)) {
    const content = fn(opts);
    if (content) sectionContents[key] = content;
  }

  let body;
  let templateUsed = 'builtin';
  let screenshotsCount = screenshots ? screenshots.filter(s => s.path).length : 0;

  // If pr_body_sections is explicitly empty, use project template verbatim (no fill).
  if (Array.isArray(config?.pr_body_sections) && config.pr_body_sections.length === 0) {
    body = projectTemplate || '';
    templateUsed = projectTemplate ? 'project-verbatim' : 'empty';
  } else if (projectTemplate) {
    const { body: filled, replacedCount } = fillTemplate(projectTemplate, sectionContents);
    if (replacedCount > 0 && filled.length >= 50) {
      // Append any sections we have that weren't in the template.
      const templateHeadings = new Set(
        [...projectTemplate.matchAll(/^## (.+)/gm)].map((m) =>
          TEMPLATE_HEADING_MAP[m[1].trim().toLowerCase()]
        ).filter(Boolean)
      );
      const extras = sections
        .filter((s) => sectionContents[s] && !templateHeadings.has(s))
        .map((s) => sectionContents[s])
        .join('\n\n');
      body = extras ? `${filled.trimEnd()}\n\n${extras}` : filled;
      templateUsed = 'project';
    } else {
      // Template had no recognized headers or is too short — use built-in.
      body = sections.map((s) => sectionContents[s]).filter(Boolean).join('\n\n');
      templateUsed = 'fallback';
    }
  } else {
    body = sections.map((s) => sectionContents[s]).filter(Boolean).join('\n\n');
  }

  const sectionsCount = sections.filter((s) => sectionContents[s]).length;
  const title = buildTitle({ commits, binding, config, branch });

  return { title, body, sectionsCount, screenshotsCount, templateUsed };
}

module.exports = {
  buildPRContent,
  buildTitle,
  buildSummary,
  buildContext,
  buildRisk,
  buildVerification,
  buildNotes,
};

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('usage: pr-body-builder.js \'<json>\'\n');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(arg);
  } catch (e) {
    process.stderr.write(`invalid JSON: ${e.message}\n`);
    process.exit(2);
  }
  try {
    const result = buildPRContent(input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
