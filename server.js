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
  let match;

  // Cypress output flow per spec:
  //   Running:  app/auth-multiuser-login.cy.ts              (27 of 61)
  //   ... test output ...
  //   | Failing:      2                                                |
  //   | Spec Ran:     app/auth-multiuser-login.cy.ts                   |
  //
  // "Running:" lines are the most reliable source for full spec names
  // because they are plain text on a single line, never truncated by
  // box-drawing width constraints.

  // Method 1: Correlate "Running:" lines with per-spec "Failing:" counts
  const runningPattern = /Running:\s+(\S+\.cy\.ts)\s/g;
  const runningEntries = [];
  while ((match = runningPattern.exec(logContent)) !== null) {
    runningEntries.push({ spec: match[1].trim(), position: match.index });
  }

  if (runningEntries.length > 0) {
    for (let i = 0; i < runningEntries.length; i++) {
      const entry = runningEntries[i];
      const nextPos = i + 1 < runningEntries.length
        ? runningEntries[i + 1].position
        : logContent.length;
      const section = logContent.substring(entry.position, nextPos);
      const failMatches = [...section.matchAll(/Failing:\s+(\d+)/g)];
      if (failMatches.length > 0) {
        const lastMatch = failMatches[failMatches.length - 1];
        const failCount = parseInt(lastMatch[1], 10);
        if (failCount > 0) {
          totalFailingCount += failCount;
          failingSpecs.push({ spec: entry.spec, count: failCount });
        }
      }
    }
  }

  // Method 2: Fallback - use "Spec Ran:" lines from result boxes
  if (failingSpecs.length === 0) {
    const specPattern = /Spec Ran:\s+([^\s][^\n]*?\.cy\.ts)/g;
    const specEntries = [];
    while ((match = specPattern.exec(logContent)) !== null) {
      specEntries.push({ spec: match[1].trim(), position: match.index });
    }
    for (const entry of specEntries) {
      const windowStart = Math.max(0, entry.position - 500);
      const windowSlice = logContent.substring(windowStart, entry.position);
      const failMatches = [...windowSlice.matchAll(/Failing:\s+(\d+)/g)];
      if (failMatches.length > 0) {
        const lastMatch = failMatches[failMatches.length - 1];
        const failCount = parseInt(lastMatch[1], 10);
        if (failCount > 0) {
          totalFailingCount += failCount;
          failingSpecs.push({ spec: entry.spec, count: failCount });
        }
      }
    }
  }

  // Method 3: Fallback - line by line parsing
  if (failingSpecs.length === 0) {
    const lines = logContent.split('\n');
    let currentFailing = 0;
    for (const line of lines) {
      const failingMatch = line.match(/Failing:\s+(\d+)/);
      if (failingMatch) {
        currentFailing = parseInt(failingMatch[1], 10);
      }
      const specMatch = line.match(/(?:Spec Ran:|Running:)\s+(.+?\.cy\.ts)/);
      if (specMatch && currentFailing > 0) {
        totalFailingCount += currentFailing;
        failingSpecs.push({ spec: specMatch[1].trim(), count: currentFailing });
        currentFailing = 0;
      }
    }
  }

  // Method 4: Last resort - find .cy.ts files near failure indicators
  if (failingSpecs.length === 0 && logContent.includes('Failing:')) {
    const totalFailMatch = logContent.match(/(\d+)\s+of\s+\d+\s+failed/);
    if (totalFailMatch) {
      totalFailingCount = parseInt(totalFailMatch[1], 10);
    }
    const allSpecs = [...logContent.matchAll(/([a-zA-Z0-9\-_./]+\.cy\.ts)/g)];
    const uniqueSpecNames = [...new Set(allSpecs.map(m => m[1]))];
    if (totalFailingCount > 0 && uniqueSpecNames.length > 0) {
      for (const spec of uniqueSpecNames.slice(0, 10)) {
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

// Helper: Parse Go unit test failures from build log
// Format: --- FAIL: TestName (0.00s)
//         FAIL\tgithub.com/openshift/console/pkg/something\t0.123s
function parseGoTestFailures(logContent) {
  const failingTests = [];
  let totalFailingCount = 0;

  const lines = logContent.split('\n');
  let currentPackage = '';

  for (const line of lines) {
    const packageFail = line.match(/^FAIL\t(\S+)\t/);
    if (packageFail) {
      currentPackage = packageFail[1];
    }

    const testFail = line.match(/^--- FAIL: (\S+)/);
    if (testFail) {
      totalFailingCount++;
      failingTests.push({
        spec: testFail[1],
        count: 1,
      });
    }
  }

  // Also capture failing packages without individual test names
  if (failingTests.length === 0) {
    for (const line of lines) {
      const packageFail = line.match(/^FAIL\t(\S+)\t/);
      if (packageFail) {
        totalFailingCount++;
        failingTests.push({ spec: packageFail[1], count: 1 });
      }
    }
  }

  const uniqueTests = [];
  const seen = new Set();
  for (const item of failingTests) {
    if (!seen.has(item.spec)) {
      seen.add(item.spec);
      uniqueTests.push(item);
    }
  }

  return { specs: uniqueTests, count: totalFailingCount };
}

// Helper: Parse Jest/RTL test failures from build log
// Format: FAIL packages/console-shared/src/utils/__tests__/something.spec.ts
//         Test Suites: 2 failed, 98 passed, 100 total
//         Tests:       5 failed, 300 passed, 305 total
function parseJestFailures(logContent) {
  const failingSpecs = [];
  let totalFailingCount = 0;

  const lines = logContent.split('\n');
  for (const line of lines) {
    // Jest prefixes failing suites with FAIL (with optional ANSI codes)
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();

    const failMatch = stripped.match(/^FAIL\s+(.+\.(spec|test)\.(ts|tsx|js|jsx))/);
    if (failMatch) {
      failingSpecs.push({ spec: failMatch[1].trim(), count: 1 });
    }

    const totalMatch = stripped.match(/Tests:\s+(\d+)\s+failed/);
    if (totalMatch) {
      totalFailingCount = parseInt(totalMatch[1], 10);
    }
  }

  // If no individual FAIL lines found, check for i18n diff failures
  if (failingSpecs.length === 0 && logContent.includes('i18n') &&
      (logContent.includes('git diff') || logContent.includes('locales/'))) {
    failingSpecs.push({ spec: 'i18n/locales check', count: 1 });
    if (totalFailingCount === 0) totalFailingCount = 1;
  }

  const uniqueSpecs = [];
  const seen = new Set();
  for (const item of failingSpecs) {
    if (!seen.has(item.spec)) {
      seen.add(item.spec);
      uniqueSpecs.push(item);
    }
  }

  if (totalFailingCount === 0 && uniqueSpecs.length > 0) {
    totalFailingCount = uniqueSpecs.length;
  }

  return { specs: uniqueSpecs, count: totalFailingCount };
}

// Dispatcher: pick the right test parser based on repo + job suffix
function parseTestFailures(logContent, repo, jobSuffix) {
  const repoConfig = CI_WATCHER_REPOS[repo];
  const jobConfig = repoConfig && repoConfig.jobs.find(j => j.suffix === jobSuffix);
  const parser = jobConfig ? jobConfig.parser : 'none';

  switch (parser) {
    case 'cypress': return parseCypressFailures(logContent);
    case 'go':      return parseGoTestFailures(logContent);
    case 'jest':    return parseJestFailures(logContent);
    default:        return { specs: [], count: 0 };
  }
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

// CI Watcher: Extract the "Older Runs" pagination buildId from job-history HTML
function parseOlderRunsBuildId(html) {
  const match = html.match(/href="[^"]*\?buildId=(\d+)"[^>]*>[^<]*Older\s+Runs/i);
  return match ? match[1] : null;
}

// CI Watcher: Parse Prow job-history page HTML
// The page embeds build data as JSON: var allBuilds = [{...}, ...];
function parseJobHistoryPage(html) {
  const match = html.match(/var\s+allBuilds\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!match) {
    console.error('Could not find allBuilds data in job-history page');
    return [];
  }

  try {
    const builds = JSON.parse(match[1]);
    return builds.map(build => {
      const pull = build.Refs?.pulls?.[0];
      const durationSecs = Math.floor((build.Duration || 0) / 1e9);
      const hours = Math.floor(durationSecs / 3600);
      const minutes = Math.floor((durationSecs % 3600) / 60);
      const seconds = durationSecs % 60;
      let duration = '';
      if (hours > 0) duration += `${hours}h `;
      if (minutes > 0 || hours > 0) duration += `${minutes}m `;
      duration += `${seconds}s`;

      return {
        buildId: build.ID,
        prNumber: pull?.number || null,
        author: pull?.author || '',
        prTitle: pull?.title || '',
        prLink: pull?.link || '',
        started: build.Started,
        duration: duration.trim(),
        durationSecs,
        result: build.Result,
        prowUrl: `https://prow.ci.openshift.org${build.SpyglassLink}`,
        buildLogUrl: `${GCS_BASE_URL}${build.SpyglassLink.replace('/view/gs/test-platform-results', '')}/build-log.txt`
      };
    });
  } catch (error) {
    console.error('Error parsing allBuilds JSON:', error.message);
    return [];
  }
}

// CI Watcher: Categorize a build failure based on log content and duration
function categorizeFailure(logContent, testResult, durationSecs) {
  if (testResult && testResult.specs && testResult.specs.length > 0) {
    return 'test_failure';
  }
  if (!logContent) return 'unknown';

  const logLower = logContent.toLowerCase();

  // Build/compile errors (webpack, TypeScript, yarn build)
  if (/error in \.\//.test(logLower) ||
      logLower.includes('module not found') ||
      logLower.includes('compiled with') && logLower.includes('error') ||
      logLower.includes('build-frontend.sh') && logLower.includes('exit status')) {
    return 'build';
  }

  // Dependency fetch failures (yarn/npm registry)
  if ((logLower.includes('connecttimeouterror') || logLower.includes('fetch failed')) &&
      (logLower.includes('yarnpkg') || logLower.includes('npmjs') || logLower.includes('registry'))) {
    return 'dependency';
  }

  // Image pull failures
  if (logLower.includes('unable to read image') ||
      logLower.includes('image pull back-off') ||
      logLower.includes('errimagepull')) {
    return 'image_pull';
  }

  // Cluster install failures
  if (logLower.includes('failed to create install config') ||
      logLower.includes('failed to fetch master machines') ||
      (logLower.includes('ipi-install') && logLower.includes('pod') && logLower.includes('failed'))) {
    return 'cluster_install';
  }

  // Timeouts
  if (['deadlineexceeded', 'context deadline exceeded', 'timed out waiting',
       'exceeded the timeout', 'step exceeded its timeout', 'pod deadline exceeded']
      .some(p => logLower.includes(p))) {
    return 'timeout';
  }

  // Infrastructure failures
  if (['could not start pod', 'cluster failed to provision', 'error creating cluster',
       'failed to create cluster', 'infrastructure error', 'unable to provision',
       'failed to setup cluster', 'no available capacity', 'quota exceeded', 'insufficient quota']
      .some(p => logLower.includes(p))) {
    return 'infra';
  }

  // Duration heuristic: very short failures (<5 min) with no other match are likely build/infra
  if (durationSecs > 0 && durationSecs < 300 && logLower.includes('failed')) {
    return 'infra';
  }

  return 'unknown';
}

// CI Watcher: Detect at which pipeline stage the failure occurred
function detectFailureStage(logContent, durationSecs, testResult) {
  if (!logContent) return 'unknown';
  const log = logContent.toLowerCase();

  // If test failures were actually parsed, the job reached the test phase
  // regardless of what other keywords appear in the log.
  if (testResult && testResult.specs && testResult.specs.length > 0) {
    return 'e2e-test';
  }

  if ((log.includes('error in ./') || log.includes('module not found') || log.includes('compiled with')) &&
      (log.includes('webpack') || log.includes('build-frontend'))) {
    return 'build';
  }
  if (log.includes('dockerbuildfailed') || (log.includes('build') && log.includes('failed') && durationSecs < 600)) {
    return 'build';
  }
  if ((log.includes('ipi-install') && log.includes('failed')) ||
      (log.includes('failed to create install config')) ||
      (log.includes('failed to fetch master machines'))) {
    return 'cluster-setup';
  }
  if ((log.includes('could not run steps') && log.includes('pre steps failed')) ||
      (log.includes('unable to read image') && durationSecs < 1800)) {
    return 'cluster-setup';
  }
  if (log.includes('failed to get pod') && log.includes('lifecycle metrics') && durationSecs < 600) {
    return 'cluster-setup';
  }
  if (log.includes('spec ran:') || log.includes('cypress')) {
    return 'e2e-test';
  }
  if (durationSecs > 3600) return 'e2e-test';
  if (durationSecs < 60) return 'setup';
  return 'unknown';
}

// CI Watcher: Supported branches
const CI_WATCHER_BRANCHES = [
  'main', 'release-4.21', 'release-4.20', 'release-4.19',
  'release-4.18', 'release-4.17', 'release-4.16', 'release-4.15'
];

// CI Watcher: Per-repo job configuration
const CI_WATCHER_REPOS = {
  'console': {
    prefix: 'pull-ci-openshift-console',
    jobs: [
      { suffix: 'e2e-gcp-console', label: 'E2E GCP Console',  parser: 'cypress' },
      { suffix: 'analyze',         label: 'Analyze',           parser: 'none' },
      { suffix: 'backend',         label: 'Backend',           parser: 'go' },
      { suffix: 'frontend',        label: 'Frontend',          parser: 'jest' },
      { suffix: 'images',          label: 'Images',            parser: 'none' },
      { suffix: 'okd-scos-images', label: 'OKD SCOS Images',   parser: 'none' },
    ],
  },
  'console-operator': {
    prefix: 'pull-ci-openshift-console-operator',
    jobs: [
      { suffix: 'e2e-aws-console',      label: 'E2E AWS Console',      parser: 'cypress' },
      { suffix: 'e2e-aws-operator',      label: 'E2E AWS Operator',     parser: 'go' },
      { suffix: 'e2e-azure-ovn-upgrade', label: 'E2E Azure Upgrade',    parser: 'none' },
      { suffix: 'e2e-gcp-ovn',          label: 'E2E GCP OVN',          parser: 'none' },
      { suffix: 'images',               label: 'Images',               parser: 'none' },
      { suffix: 'okd-scos-images',      label: 'OKD SCOS Images',      parser: 'none' },
      { suffix: 'unit',                 label: 'Unit',                 parser: 'go' },
      { suffix: 'verify',               label: 'Verify',              parser: 'none' },
      { suffix: 'verify-deps',          label: 'Verify Deps',         parser: 'none' },
    ],
  },
};

// Phase 1 API: CI Watcher - Get job history metadata (fast, no log downloads)
app.get('/api/ci-watcher/:branch', async (req, res) => {
  const { branch } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const repo = req.query.repo || 'console';
  const jobSuffix = req.query.job || (repo === 'console' ? 'e2e-gcp-console' : 'e2e-aws-console');

  if (!CI_WATCHER_BRANCHES.includes(branch)) {
    return res.status(400).json({ error: `Invalid branch. Supported: ${CI_WATCHER_BRANCHES.join(', ')}` });
  }

  const repoConfig = CI_WATCHER_REPOS[repo];
  if (!repoConfig) {
    return res.status(400).json({ error: `Invalid repo. Supported: ${Object.keys(CI_WATCHER_REPOS).join(', ')}` });
  }

  if (!repoConfig.jobs.some(j => j.suffix === jobSuffix)) {
    return res.status(400).json({ error: `Invalid job for ${repo}. Supported: ${repoConfig.jobs.map(j => j.suffix).join(', ')}` });
  }

  const branchSlug = branch === 'master' ? 'main' : branch;
  const ciJobName = `${repoConfig.prefix}-${branchSlug}-${jobSuffix}`;
  const jobHistoryBaseUrl = `https://prow.ci.openshift.org/job-history/gs/test-platform-results/pr-logs/directory/${ciJobName}`;

  console.log(`CI Watcher: Fetching job history for ${repo}/${branch}, job=${jobSuffix}, limit=${limit}`);

  try {
    const MAX_PAGES = Math.ceil(limit / 4) + 1;
    const allRuns = [];
    const failedRuns = [];
    let nextBuildId = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const pageUrl = nextBuildId
        ? `${jobHistoryBaseUrl}?buildId=${nextBuildId}`
        : jobHistoryBaseUrl;

      console.log(`CI Watcher: Fetching page ${page + 1}`);

      const historyResponse = await axios.get(pageUrl, {
        timeout: 30000,
        headers: { 'User-Agent': 'Prowpy/1.0', 'Accept': 'text/html,application/xhtml+xml' }
      });

      const pageRuns = parseJobHistoryPage(historyResponse.data);
      if (pageRuns.length === 0) break;

      allRuns.push(...pageRuns);
      failedRuns.push(...pageRuns.filter(r => r.result === 'FAILURE'));

      if (failedRuns.length >= limit) break;

      nextBuildId = parseOlderRunsBuildId(historyResponse.data);
      if (!nextBuildId) break;
    }

    const totalRuns = allRuns.length;
    const successCount = allRuns.filter(r => r.result === 'SUCCESS').length;
    const abortedCount = allRuns.filter(r => r.result === 'ABORTED').length;
    const pendingCount = allRuns.filter(r => r.result === 'PENDING').length;

    res.json({
      branch,
      jobName: ciJobName,
      totalRuns,
      resultSummary: {
        success: successCount,
        failure: failedRuns.length,
        aborted: abortedCount,
        pending: pendingCount,
      },
      passRate: totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) + '%' : '0%',
      failedRuns: failedRuns.slice(0, limit),
      allRuns,
    });
  } catch (error) {
    console.error('CI Watcher error:', error.message);
    res.status(500).json({ error: 'Failed to fetch CI job history', details: error.message });
  }
});

// Phase 2 API: CI Watcher - Analyze a batch of build logs (progressive)
app.post('/api/ci-watcher/analyze-logs', async (req, res) => {
  const { runs, jobSuffix, repo } = req.body;
  const repoKey = repo || 'console';
  if (!runs || !Array.isArray(runs) || runs.length === 0) {
    return res.status(400).json({ error: 'Missing runs array' });
  }

  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < runs.length; i += CONCURRENCY) {
    const batch = runs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (run) => {
      try {
        const logResponse = await axios.get(run.buildLogUrl, {
          timeout: 60000,
          headers: { 'User-Agent': 'Prowpy/1.0' },
          maxContentLength: 50 * 1024 * 1024
        });

        const logContent = logResponse.data;
        const testResult = parseTestFailures(logContent, repoKey, jobSuffix || 'e2e-gcp-console');
        const category = categorizeFailure(logContent, testResult, run.durationSecs || 0);
        const stage = detectFailureStage(logContent, run.durationSecs || 0, testResult);

        return {
          buildId: run.buildId,
          category,
          stage,
          failingSpecs: testResult.specs || [],
          failingSpecCount: testResult.count || 0,
        };
      } catch (logError) {
        console.error(`CI Watcher: Error fetching log for build ${run.buildId}:`, logError.message);
        return {
          buildId: run.buildId,
          category: 'unknown',
          stage: 'unknown',
          failingSpecs: [],
          failingSpecCount: 0,
          fetchError: logError.message,
        };
      }
    }));
    results.push(...batchResults);
  }

  res.json({ results });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Make sure to set up your GitHub OAuth App and configure .env file');
});
