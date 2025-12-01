# Prowpy

A web application for managing and resolving flaky CI tests in OpenShift Console repositories. It helps developers quickly identify failing PRs, view test details, and trigger retests.

## Features

- **GitHub OAuth Authentication** - Secure login with your GitHub account
- **Multi-Repository Support** - View PRs from both `openshift/console` and `openshift/console-operator`
- **Smart Filtering**
  - **All PRs** - View all your open PRs
  - **Potential Flakes** - PRs with only e2e test failures (likely flaky tests)
  - **Other Failing CI** - PRs with other CI jobs failing
  - **My PRs** - PRs where you are the author
  - **Need Labels** - PRs missing lgtm, approved, or verified labels
- **Advanced Search & Filters**
  - Search by PR number, title, or author
  - Filter by branch, CI status, and your role (author/reviewer/assignee)
- **CI Status Tracking**
  - Real-time CI status updates
  - View job history (last 4 runs)
  - Parse and display failing Cypress test specs
- **Batch Operations**
  - Select multiple PRs
  - Trigger retest for selected PRs with one click
- **Grouping & Sorting**
  - Group PRs by CI status (Failing, Passing, Pending, Loading)
  - Sort by last updated, created date, or PR number
  - Collapsible groups with persistent state

## Prerequisites

- Node.js >= 18.0.0
- A GitHub OAuth App

## Setup

### 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in the details:
   - **Application name**: Prowpy (or your preferred name)
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. Click "Register application"
5. Copy the **Client ID**
6. Generate a new **Client Secret** and copy it

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# GitHub OAuth App credentials
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Session secret (generate a random string)
SESSION_SECRET=your_random_session_secret

# Server port
PORT=3000

# Callback URL (must match GitHub OAuth App settings)
CALLBACK_URL=http://localhost:3000/auth/github/callback
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Application

```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

Open http://localhost:3000 in your browser.

## Usage

1. **Sign in** with your GitHub account
2. View your open PRs from openshift/console and openshift/console-operator
3. Use **filter tabs** to quickly find PRs:
   - "Potential Flakes" for PRs that might pass on retry
   - "Other Failing CI" for PRs with non-e2e failures
4. Click **Details** to view failing test specs and job history
5. Click **Retest** to trigger `/retest-required` on a PR
6. Use **batch actions** to retest multiple PRs at once

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JavaScript, Tailwind CSS
- **Authentication**: GitHub OAuth
- **APIs**: GitHub API, Prow CI, Google Cloud Storage

## Project Structure

```
flaky-resolver/
├── server.js          # Express server and API routes
├── public/
│   └── index.html     # Single-page frontend application
├── package.json
├── .env.example       # Environment variables template
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user` | Get current user info |
| GET | `/api/prs` | Get user's open PRs |
| GET | `/api/pr-status/:prNumber/:sha` | Get CI status for a PR |
| GET | `/api/ci-log/:prNumber` | Get CI logs and failing tests |
| POST | `/api/retest/:prNumber` | Trigger retest for a PR |
| POST | `/api/retest-batch` | Trigger retest for multiple PRs |

## License

MIT
