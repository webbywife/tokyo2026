#!/usr/bin/env node
/*
 * Read the Cloudflare API token out of credentials.yml, verify it actually works
 * and actually has the permissions the deploy needs, then push it to the repo as
 * the CLOUDFLARE_API_TOKEN Actions secret.
 *
 *   node tools/sync-ci-secret.cjs
 *
 * Verifies before writing, because a bad secret fails 90 seconds into CI with an
 * opaque error, whereas checking here takes two seconds and says what's wrong.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRED = path.join(ROOT, 'credentials.yml');
const REPO = 'webbywife/tokyo2026';

function die(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`\n  ${hint}\n`);
  process.exit(1);
}

if (!fs.existsSync(CRED)) {
  die('credentials.yml not found.', 'cp credentials.yml.example credentials.yml   then fill in api_token');
}

/* The file is a fixed two-level shape, so a full YAML parser would be a
 * dependency for no benefit. */
const text = fs.readFileSync(CRED, 'utf8');
const field = name => {
  const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*(?:#.*)?$`, 'm'));
  return m ? m[1].trim() : null;
};

const token = field('api_token');
const accountId = field('account_id');

if (!token || token === 'PASTE_TOKEN_HERE') {
  die('api_token is still the placeholder in credentials.yml.',
      'Create one at https://dash.cloudflare.com/profile/api-tokens\n' +
      '  Custom token, scoped to the personal account, with:\n' +
      '    Account · Cloudflare Pages      · Edit\n' +
      '    Account · Workers Scripts       · Edit\n' +
      '    Account · Workers KV Storage    · Edit');
}

(async () => {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  /* 1. is the token even valid? */
  const v = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: H });
  const vj = await v.json().catch(() => ({}));
  if (!v.ok || !vj.success) {
    die(`Cloudflare rejected the token (HTTP ${v.status}).`,
        (vj.errors || []).map(e => `${e.code}: ${e.message}`).join('\n  ') || 'Check it was copied whole.');
  }
  console.log(`✓ token is valid (status: ${vj.result && vj.result.status})`);

  /* 2. can it actually do the two things the workflow needs? */
  const checks = [
    ['Pages',        `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`],
    ['Workers',      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`],
  ];
  let missing = [];
  for (const [label, url] of checks) {
    const r = await fetch(url, { headers: H });
    if (r.ok) console.log(`✓ ${label}: accessible`);
    else { console.log(`✗ ${label}: HTTP ${r.status}`); missing.push(label); }
  }
  if (missing.length) {
    die(`The token cannot reach: ${missing.join(', ')}.`,
        'Re-create it with Cloudflare Pages · Edit AND Workers Scripts · Edit,\n' +
        '  scoped to the "Jose Angelo Abarentos" account.');
  }

  /* 3. push it to the repo */
  console.log(`\nsetting CLOUDFLARE_API_TOKEN on ${REPO} ...`);
  execFileSync('gh', ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', REPO], {
    input: token, stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('✓ secret set');
  console.log('\nNext push to main will deploy. To run it now without a commit:');
  console.log(`  gh workflow run deploy.yml --repo ${REPO}`);
})();
