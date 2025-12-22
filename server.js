require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// GitHub OAuth configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/auth/github/callback';

// Constants
const REPO_OWNER = 'openshift';
const GCS_BASE_URL = 'https://storage.googleapis.com/test-platform-results';

// Supported repositories
const REPOS = [
  { owner: 'openshift', name: 'console', ciJobPrefix: 'pull-ci-openshift-console' },
  { owner: 'openshift', name: 'console-operator', ciJobPrefix: 'pull-ci-openshift-console-operator' }
];

// Helper: Get CI job name based on repo and target branch
function getCIJobName(repoName, baseBranch) {
  const repo = REPOS.find(r => r.name === repoName) || REPOS[0];
  // For release branches like "release-4.19", use that in the job name
  // For main/master, use "main"
  const branch = baseBranch === 'master' ? 'main' : baseBranch;
  // console uses e2e-gcp-console, console-operator uses e2e
  const jobSuffix = repoName === 'console' ? 'e2e-gcp-console' : 'e2e';
  return `${repo.ciJobPrefix}-${branch}-${jobSuffix}`;
}

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// GitHub OAuth routes
app.get('/auth/github', (req, res) => {
  const scope = 'repo';
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${scope}`;
  res.redirect(authUrl);
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL
    }, {
      headers: { Accept: 'application/json' }
    });

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      return res.redirect('/?error=no_token');
    }

    // Get user info
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    req.session.user = {
      login: userResponse.data.login,
      name: userResponse.data.name,
      avatar: userResponse.data.avatar_url,
      accessToken
    };

    res.redirect('/');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/user', (req, res) => {
  if (req.session.user) {
    res.json({
      login: req.session.user.login,
      name: req.session.user.name,
      avatar: req.session.user.avatar
    });
  } else {
    res.json(null);
  }
});

// API: Get user's PRs (fast initial load without CI status)
app.get('/api/prs', requireAuth, async (req, res) => {
  const { accessToken, login } = req.session.user;

  try {
    // Fetch PRs from all supported repositories in parallel
    const repoPromises = REPOS.map(async (repo) => {
      try {
        const response = await axios.get(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`,
          {
            params: { state: 'open', per_page: 100 },
            headers: { Authorization: `Bearer ${accessToken}` }
          }
        );
        return { repo, prs: response.data };
      } catch (error) {
        console.error(`Error fetching PRs from ${repo.owner}/${repo.name}:`, error.message);
        return { repo, prs: [] };
      }
    });

    const repoResults = await Promise.all(repoPromises);

    // Combine and filter PRs from all repos
    let allUserPRs = [];
    for (const { repo, prs } of repoResults) {
      const userPRs = prs.filter(pr => {
        const isAuthor = pr.user.login === login;
        const isReviewer = pr.requested_reviewers?.some(r => r.login === login);
        const isAssignee = pr.assignees?.some(a => a.login === login);
        return isAuthor || isReviewer || isAssignee;
      });

      // Map PRs with repo info
      const mappedPRs = userPRs.map(pr => {
        const labelNames = pr.labels?.map(l => l.name.toLowerCase()) || [];
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          author: pr.user.login,
          repo: repo.name, // Add repo name
          repoFullName: `${repo.owner}/${repo.name}`, // Full repo name
          isAuthor: pr.user.login === login,
          isReviewer: pr.requested_reviewers?.some(r => r.login === login),
          isAssignee: pr.assignees?.some(a => a.login === login),
          headSha: pr.head.sha,
          baseBranch: pr.base?.ref || 'main',
          e2eStatus: 'loading',
          e2eDetailsUrl: null,
          labels: labelNames,
          hasLgtm: labelNames.includes('lgtm'),
          hasApproved: labelNames.includes('approved'),
          hasVerified: labelNames.includes('verified') || labelNames.some(l => l.includes('verified')),
          createdAt: pr.created_at,
          updatedAt: pr.updated_at
        };
      });

      allUserPRs = allUserPRs.concat(mappedPRs);
    }

    // Sort by updated time (most recent first)
    allUserPRs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json(allUserPRs);
  } catch (error) {
    console.error('Error fetching PRs:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch PRs' });
  }
});

// Helper: Fetch all check-runs with pagination
async function fetchAllCheckRuns(sha, accessToken, repoName = 'console') {
  const allCheckRuns = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${REPO_OWNER}/${repoName}/commits/${sha}/check-runs`,
        {
          params: { per_page: perPage, page },
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      const checkRuns = response.data.check_runs || [];
      allCheckRuns.push(...checkRuns);

      // If we got fewer than perPage results, we've reached the end
      if (checkRuns.length < perPage) break;
      page++;

      // Safety limit
      if (page > 10) break;
    } catch (error) {
      console.error('Error fetching check-runs page:', page, error.message);
      break;
    }
  }

  return allCheckRuns;
}

// API: Get CI status for a single PR
app.get('/api/pr-status/:prNumber/:sha', requireAuth, async (req, res) => {
  const { prNumber, sha } = req.params;
  const { repo = 'console' } = req.query;
  const { accessToken } = req.session.user;

  // Determine which e2e job to look for based on repo
  const isConsole = repo === 'console';
  const e2eJobPattern = isConsole ? 'e2e-gcp-console' : 'e2e';

  try {
    // Fetch all check-runs (with pagination) and statuses
    const [allCheckRuns, statusResponse] = await Promise.all([
      fetchAllCheckRuns(sha, accessToken, repo),
      axios.get(
        `https://api.github.com/repos/${REPO_OWNER}/${repo}/commits/${sha}/status`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ).catch(() => ({ data: { statuses: [] } }))
    ]);

    // Look for e2e job in check runs (pattern depends on repo)
    const e2eCheck = allCheckRuns.find(run => {
      if (isConsole) {
        return run.name.includes('e2e-gcp-console') ||
               run.name.includes('e2e-gcp') ||
               run.external_id?.includes('e2e-gcp-console');
      } else {
        // For console-operator, look for e2e job but not e2e-gcp-console
        return run.name.includes('-e2e') && !run.name.includes('e2e-gcp-console');
      }
    });

    // Also check statuses API (used by some CI systems)
    const e2eStatus = statusResponse.data.statuses?.find(s => {
      if (isConsole) {
        return s.context?.includes('e2e-gcp-console') || s.context?.includes('e2e-gcp');
      } else {
        return s.context?.includes('-e2e') && !s.context?.includes('e2e-gcp-console');
      }
    });

    let status = 'not_found';
    let detailsUrl = null;

    if (e2eCheck) {
      status = e2eCheck.conclusion || e2eCheck.status || 'pending';
      detailsUrl = e2eCheck.details_url;
    } else if (e2eStatus) {
      status = e2eStatus.state === 'success' ? 'success' :
               e2eStatus.state === 'failure' ? 'failure' :
               e2eStatus.state === 'error' ? 'failure' : 'pending';
      detailsUrl = e2eStatus.target_url;
    }

    // Collect other failing CI jobs (excluding the primary e2e job)
    const otherFailingJobs = [];
    const seenJobNames = new Set();

    // Helper to check if a job is the primary e2e job for this repo
    const isPrimaryE2eJob = (name) => {
      if (isConsole) {
        return name.includes('e2e-gcp-console') || name.includes('e2e-gcp');
      } else {
        return name.includes('-e2e') && !name.includes('e2e-gcp-console');
      }
    };

    // Check runs that are failing
    allCheckRuns.forEach(run => {
      const isMainE2e = isPrimaryE2eJob(run.name);
      // Include failure, cancelled, timed_out, action_required as failing states
      const isFailing = ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion);

      if (!isMainE2e && isFailing && !seenJobNames.has(run.name)) {
        seenJobNames.add(run.name);
        otherFailingJobs.push({
          name: run.name,
          status: run.conclusion,
          url: run.details_url || run.html_url
        });
      }
    });

    // Statuses that are failing (from combined status API)
    statusResponse.data.statuses?.forEach(s => {
      const isMainE2e = isPrimaryE2eJob(s.context || '');
      const isFailing = s.state === 'failure' || s.state === 'error';

      if (!isMainE2e && isFailing && !seenJobNames.has(s.context)) {
        seenJobNames.add(s.context);
        otherFailingJobs.push({
          name: s.context,
          status: s.state,
          url: s.target_url
        });
      }
    });

    res.json({
      prNumber: parseInt(prNumber),
      e2eStatus: status,
      e2eDetailsUrl: detailsUrl,
      otherFailingJobs: otherFailingJobs
    });
  } catch (error) {
    console.error(`Error fetching status for PR #${prNumber}:`, error.message);
    res.json({
      prNumber: parseInt(prNumber),
      e2eStatus: 'error',
      e2eDetailsUrl: null,
      otherFailingJobs: []
    });
  }
});

// API: Get CI build log and parse failing tests
app.get('/api/ci-log/:prNumber', requireAuth, async (req, res) => {
  const { prNumber } = req.params;
  const { baseBranch = 'main', repo = 'console' } = req.query;

  // Get the correct CI job name for this repo and branch
  const ciJobName = getCIJobName(repo, baseBranch);
  console.log(`Using CI job name: ${ciJobName} for PR #${prNumber} (repo: ${repo}, base: ${baseBranch})`);

  try {
    // First, get job history to find the latest job ID
    const historyUrl = `https://prow.ci.openshift.org/pr-history/?org=${REPO_OWNER}&repo=${repo}&pr=${prNumber}`;

    console.log(`Fetching job history for PR #${prNumber}: ${historyUrl}`);

    // Direct request (no CORS proxy needed on server-side)
    const historyResponse = await axios.get(historyUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'FlakeyResolver/1.0',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const historyHtml = historyResponse.data;

    console.log(`Got history HTML for PR #${prNumber}, length: ${historyHtml.length}`);

    // Parse job history HTML to find e2e job runs
    const jobRuns = parseJobHistory(historyHtml, prNumber, ciJobName, repo);

    console.log(`Found ${jobRuns.length} job runs for PR #${prNumber}`);

    if (jobRuns.length === 0) {
      return res.json({ jobRuns: [], failingTests: { tests: [], count: 0, specs: [] } });
    }

    // Get the latest job run's build log
    const latestJob = jobRuns[0];

    console.log(`Fetching build log: ${latestJob.buildLogUrl}`);

    let failingTests = { tests: [], count: 0, specs: [] };
    try {
      const logResponse = await axios.get(latestJob.buildLogUrl, {
        timeout: 60000,
        headers: {
          'User-Agent': 'FlakeyResolver/1.0'
        },
        maxContentLength: 50 * 1024 * 1024 // 50MB max
      });
      console.log(`Got build log for PR #${prNumber}, length: ${logResponse.data.length}`);
      failingTests = parseCypressFailures(logResponse.data);
      console.log(`Parsed ${failingTests.specs.length} failing specs`);
    } catch (logError) {
      console.error(`Error fetching build log for PR #${prNumber}:`, logError.message);
    }

    res.json({ jobRuns, failingTests });
  } catch (error) {
    console.error(`Error fetching CI log for PR #${prNumber}:`, error.message);
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response data: ${JSON.stringify(error.response.data).substring(0, 500)}`);
    }
    res.status(500).json({ error: 'Failed to fetch CI log', details: error.message });
  }
});

// API: Trigger retest
app.post('/api/retest/:prNumber', requireAuth, async (req, res) => {
  const { prNumber } = req.params;
  const { repo = 'console' } = req.query;
  const { accessToken } = req.session.user;

  try {
    await axios.post(
      `https://api.github.com/repos/${REPO_OWNER}/${repo}/issues/${prNumber}/comments`,
      { body: '/retest-required' },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json({ success: true, message: `Retest triggered for PR #${prNumber}` });
  } catch (error) {
    console.error(`Error triggering retest for PR #${prNumber}:`, error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to trigger retest' });
  }
});

// API: Batch retest
app.post('/api/retest-batch', requireAuth, async (req, res) => {
  const { prs } = req.body; // Array of { prNumber, repo }
  const { accessToken } = req.session.user;

  const results = await Promise.all(prs.map(async ({ prNumber, repo = 'console' }) => {
    try {
      await axios.post(
        `https://api.github.com/repos/${REPO_OWNER}/${repo}/issues/${prNumber}/comments`,
        { body: '/retest-required' },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return { prNumber, repo, success: true };
    } catch (error) {
      return { prNumber, repo, success: false, error: error.message };
    }
  }));

  res.json({ results });
});

// Helper: Parse job history HTML
function parseJobHistory(html, prNumber, ciJobName, repoName = 'console') {
  const jobRuns = [];
  const seenRunIds = new Set();

  // The GCS path uses underscore format: openshift_console or openshift_console-operator
  const gcsRepoPath = `openshift_${repoName}`;

  // The Prow HTML structure has links like:
  // <a href="/view/gs/test-platform-results/pr-logs/pull/openshift_console/15777/pull-ci-openshift-console-main-e2e-gcp-console/1993594113315835904" class="run-success">
  // For release branches: pull-ci-openshift-console-release-4.19-e2e-gcp-console

  // Escape the job name for use in regex (handle dots and dashes)
  const escapedJobName = ciJobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Pattern to find anchor tags with job runs - the class comes after href
  const pattern = new RegExp(
    `<a[^>]*href="[^"]*${escapedJobName}/(\\d+)"[^>]*class="[^"]*run-(success|failure|pending|aborted)[^"]*"[^>]*>`,
    'gi'
  );

  let match;
  while ((match = pattern.exec(html)) !== null && jobRuns.length < 4) {
    const runId = match[1];
    const status = match[2];

    if (!seenRunIds.has(runId)) {
      seenRunIds.add(runId);
      jobRuns.push({
        runId,
        status,
        buildLogUrl: `${GCS_BASE_URL}/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}/build-log.txt`,
        prowUrl: `https://prow.ci.openshift.org/view/gs/test-platform-results/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}`
      });
    }
  }

  // If first pattern didn't work, try alternate pattern where class comes before href
  if (jobRuns.length === 0) {
    const altPattern = new RegExp(
      `<a[^>]*class="[^"]*run-(success|failure|pending|aborted)[^"]*"[^>]*href="[^"]*${escapedJobName}/(\\d+)"[^>]*>`,
      'gi'
    );

    while ((match = altPattern.exec(html)) !== null && jobRuns.length < 4) {
      const status = match[1];
      const runId = match[2];

      if (!seenRunIds.has(runId)) {
        seenRunIds.add(runId);
        jobRuns.push({
          runId,
          status,
          buildLogUrl: `${GCS_BASE_URL}/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}/build-log.txt`,
          prowUrl: `https://prow.ci.openshift.org/view/gs/test-platform-results/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}`
        });
      }
    }
  }

  // Last resort: find all run IDs and determine status from context
  if (jobRuns.length === 0) {
    console.log('Using fallback parsing method for job:', ciJobName);
    const linkPattern = new RegExp(`href="[^"]*${escapedJobName}/(\\d+)"[^>]*`, 'gi');

    while ((match = linkPattern.exec(html)) !== null && jobRuns.length < 4) {
      const runId = match[1];
      const fullMatch = match[0];

      if (!seenRunIds.has(runId)) {
        seenRunIds.add(runId);

        // Try to find status class nearby
        let status = 'unknown';
        const nearbyHtml = html.substring(
          Math.max(0, match.index - 100),
          Math.min(html.length, match.index + fullMatch.length + 100)
        );

        if (nearbyHtml.includes('run-failure')) status = 'failure';
        else if (nearbyHtml.includes('run-success')) status = 'success';
        else if (nearbyHtml.includes('run-pending')) status = 'pending';
        else if (nearbyHtml.includes('run-aborted')) status = 'aborted';

        jobRuns.push({
          runId,
          status,
          buildLogUrl: `${GCS_BASE_URL}/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}/build-log.txt`,
          prowUrl: `https://prow.ci.openshift.org/view/gs/test-platform-results/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}`
        });
      }
    }
  }

  console.log(`Parsed ${jobRuns.length} job runs for PR #${prNumber}`);
  return jobRuns;
}

// Helper: Parse Cypress test failures from build log
function parseCypressFailures(logContent) {
  const failingSpecs = [];
  let totalFailingCount = 0;

  // The Cypress output has boxes like:
  // ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
  // │ Tests:        2                                                                                │
  // │ Passing:      0                                                                                │
  // │ Failing:      2                                                                                │
  // │ Spec Ran:     app/admission-webhook-warning-notifications.cy.ts                                │
  // └────────────────────────────────────────────────────────────────────────────────────────────────┘

  // Method 1: Find all Spec Ran lines and look for nearby Failing counts
  // The spec name can contain paths like "app/foo.cy.ts" - capture everything up to .cy.ts
  const specPattern = /Spec Ran:\s+([^\s│][^\n│]*?\.cy\.ts)/g;
  const failingPattern = /Failing:\s+(\d+)/g;

  // First, find all spec entries with their positions
  const specEntries = [];
  let match;
  while ((match = specPattern.exec(logContent)) !== null) {
    specEntries.push({
      spec: match[1].trim(),
      position: match.index
    });
  }

  // For each spec, find the Failing count that appears before it (in the same box)
  for (const entry of specEntries) {
    // Look backwards from the spec position to find the Failing count
    // Search in a window of ~500 chars before the spec
    const windowStart = Math.max(0, entry.position - 500);
    const window = logContent.substring(windowStart, entry.position);

    // Find the last Failing: X in this window
    const failMatches = [...window.matchAll(/Failing:\s+(\d+)/g)];
    if (failMatches.length > 0) {
      const lastMatch = failMatches[failMatches.length - 1];
      const failCount = parseInt(lastMatch[1], 10);

      if (failCount > 0) {
        totalFailingCount += failCount;
        failingSpecs.push({
          spec: entry.spec,
          count: failCount
        });
      }
    }
  }

  // Method 2: Fallback - line by line parsing
  if (failingSpecs.length === 0) {
    console.log('Using fallback line-by-line parsing');
    const lines = logContent.split('\n');
    let currentFailing = 0;

    for (const line of lines) {
      // Match Failing count
      const failingMatch = line.match(/Failing:\s+(\d+)/);
      if (failingMatch) {
        currentFailing = parseInt(failingMatch[1], 10);
      }

      // Match Spec Ran - capture path/filename.cy.ts
      const specMatch = line.match(/Spec Ran:\s+(.+?\.cy\.ts)/);
      if (specMatch && currentFailing > 0) {
        totalFailingCount += currentFailing;
        failingSpecs.push({
          spec: specMatch[1].trim(),
          count: currentFailing
        });
        currentFailing = 0;
      }
    }
  }

  // Method 3: Last resort - just find any .cy.ts files mentioned with failures
  if (failingSpecs.length === 0 && logContent.includes('Failing:')) {
    console.log('Using last resort parsing - looking for any failing indicators');

    // Check if there are any failures at all
    const totalFailMatch = logContent.match(/(\d+)\s+of\s+\d+\s+failed/);
    if (totalFailMatch) {
      totalFailingCount = parseInt(totalFailMatch[1], 10);
    }

    // Find all .cy.ts files mentioned
    const allSpecs = [...logContent.matchAll(/([a-zA-Z0-9\-_\/]+\.cy\.ts)/g)];
    const uniqueSpecNames = [...new Set(allSpecs.map(m => m[1]))];

    // If we have failures but couldn't parse specs, just note that
    if (totalFailingCount > 0 && uniqueSpecNames.length > 0) {
      // Add specs without individual counts
      for (const spec of uniqueSpecNames.slice(0, 10)) { // Limit to 10
        failingSpecs.push({ spec, count: 0 });
      }
    }
  }

  // Remove duplicates
  const uniqueSpecs = [];
  const seenSpecs = new Set();
  for (const item of failingSpecs) {
    if (!seenSpecs.has(item.spec)) {
      seenSpecs.add(item.spec);
      uniqueSpecs.push(item);
    }
  }

  console.log(`Found ${uniqueSpecs.length} failing specs with ${totalFailingCount} total failures`);

  return {
    specs: uniqueSpecs,
    count: totalFailingCount
  };
}

// API: Get screenshots for a spec
app.get('/api/screenshots/:prNumber/:runId', async (req, res) => {
  const { prNumber, runId } = req.params;
  const { spec, repo = 'console', ciJobName } = req.query;

  if (!spec || !ciJobName) {
    return res.status(400).json({ error: 'Missing spec or ciJobName parameter' });
  }

  // Construct the gcsweb URL for the screenshots directory (with trailing slash)
  const gcsRepoPath = `openshift_${repo}`;
  const jobSuffix = repo === 'console' ? 'e2e-gcp-console' : 'e2e';
  const screenshotsBaseUrl = `https://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com/gcs/test-platform-results/pr-logs/pull/${gcsRepoPath}/${prNumber}/${ciJobName}/${runId}/artifacts/${jobSuffix}/test/artifacts/gui_test_screenshots/cypress/screenshots/${spec}/`;

  console.log(`Fetching screenshots from: ${screenshotsBaseUrl}`);

  try {
    // Fetch the directory listing from gcsweb
    const response = await axios.get(screenshotsBaseUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Prowpy/1.0',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const html = response.data;

    // Parse the HTML to extract screenshot links
    // gcsweb shows directory listings with links like: <a href="/gcs/...filename.png">
    // The href contains the full path, and the text might be just the filename or full path
    const screenshots = [];
    const seenUrls = new Set();

    // Match any href that ends with .png (case insensitive)
    // The gcsweb HTML structure: <a href="/gcs/path/to/file.png">displayname</a>
    const linkPattern = /<a\s+href="([^"]+\.png)"[^>]*>/gi;

    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const href = match[1];

      // Build full URL - href is typically absolute path starting with /gcs/
      let fullUrl;
      if (href.startsWith('http')) {
        fullUrl = href;
      } else if (href.startsWith('/')) {
        fullUrl = `https://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com${href}`;
      } else {
        fullUrl = `${screenshotsBaseUrl}${href}`;
      }

      // Avoid duplicates
      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);

      // Extract filename from the href (last part of the path)
      const filename = decodeURIComponent(href.split('/').pop() || 'screenshot.png');

      screenshots.push({
        name: filename,
        url: fullUrl
      });
    }

    console.log(`Found ${screenshots.length} screenshots for ${spec}`);
    res.json({ screenshots });
  } catch (error) {
    console.error(`Error fetching screenshots for PR #${prNumber}:`, error.message);

    // If directory doesn't exist, return empty array instead of error
    if (error.response?.status === 404) {
      return res.json({ screenshots: [] });
    }

    res.status(500).json({ error: 'Failed to fetch screenshots', details: error.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Make sure to set up your GitHub OAuth App and configure .env file');
});
