# Reddit MCP Server (Read-Only Fork)

> **Read-only fork of jordanburke/reddit-mcp-server for personal, non-commercial Reddit Data API use: local analysis of public posts and comments. All write tools have been removed.**

A Model Context Protocol (MCP) server for interacting with Reddit - fetch posts, comments, user info, subreddit details, and search results.

[![npm version](https://img.shields.io/npm/v/reddit-mcp-server.svg)](https://www.npmjs.com/package/reddit-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/reddit-mcp-server.svg)](https://www.npmjs.com/package/reddit-mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/jordanburke/reddit-mcp-server.svg?style=flat&logo=github)](https://github.com/jordanburke/reddit-mcp-server/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

<a href="https://glama.ai/mcp/servers/@jordanburke/reddit-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@jordanburke/reddit-mcp-server/badge" alt="reddit-mcp-server MCP server" />
</a>

## Features at a Glance

| Feature                       |     This fork      |
| ----------------------------- | :----------------: |
| **Strictly read-only**        | :white_check_mark: |
| Browse Subreddits             | :white_check_mark: |
| Search Reddit                 | :white_check_mark: |
| User Analysis                 | :white_check_mark: |
| Post Comments (threaded)      | :white_check_mark: |
| OAuth Auth (60-100 rpm)       | :white_check_mark: |
| **RSS Fallback (zero-setup)** | :white_check_mark: |

This fork contains no tools that create, edit, or delete Reddit content, and it never handles
Reddit user credentials - only OAuth app credentials.

## Quick Start

### Option 1: Claude Desktop Extension (Easiest)

Download and open the extension file - Claude Desktop will install it automatically:

**[Download reddit-mcp-server.mcpb](https://github.com/jordanburke/reddit-mcp-server/releases/latest/download/reddit-mcp-server.mcpb)**

### Option 2: NPX (No install required)

Add to your MCP config (Claude Desktop, Cursor, etc.) with Reddit OAuth credentials:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["reddit-mcp-server"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id",
        "REDDIT_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Option 3: Claude Code

```bash
REDDIT_CLIENT_ID=your_client_id REDDIT_CLIENT_SECRET=your_client_secret \
  claude mcp add --transport stdio reddit -- npx reddit-mcp-server
```

## Features

### Read-only Tools

| Tool                      | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `get_reddit_post`         | Get a specific Reddit post with engagement analysis                         |
| `get_top_posts`           | Get top posts from a subreddit or home feed                                 |
| `browse_subreddit`        | Browse a subreddit/home feed by sort (hot, new, top, rising, controversial) |
| `get_user_info`           | Get detailed information about a Reddit user                                |
| `get_user_posts`          | Get posts submitted by a specific user                                      |
| `get_user_comments`       | Get comments made by a specific user                                        |
| `get_subreddit_info`      | Get subreddit details and statistics                                        |
| `get_subreddit_rules`     | Get a subreddit's posting rules                                             |
| `get_post_flairs`         | List a subreddit's available link flairs                                    |
| `get_trending_subreddits` | Get currently trending subreddits                                           |
| `get_post_comments`       | Get comments from a specific post with threading                            |
| `get_more_comments`       | Expand truncated "load more" comment stubs                                  |
| `search_reddit`           | Search for posts, subreddits, or users across Reddit                        |
| `test_reddit_mcp_server`  | Health check for the server configuration                                   |

## Configuration

### Environment Variables

| Variable               | Required | Default        | Description                                                           |
| ---------------------- | -------- | -------------- | --------------------------------------------------------------------- |
| `REDDIT_CLIENT_ID`     | Yes      | -              | Reddit app client ID (OAuth required since mid-2026)                  |
| `REDDIT_CLIENT_SECRET` | Yes      | -              | Reddit app client secret                                              |
| `REDDIT_USER_AGENT`    | No       | Auto-generated | Custom User-Agent string                                              |
| `REDDIT_AUTH_MODE`     | No       | `auto`         | Authentication mode: `auto`, `authenticated` (`anonymous` deprecated) |
| `REDDIT_CACHE`         | No       | `on`           | In-memory caching of read requests: `on`, `off`                       |
| `REDDIT_CACHE_MAX_MB`  | No       | `50`           | Cache size cap in MB (LRU eviction beyond this)                       |
| `REDDIT_MAX_RETRIES`   | No       | `3`            | Retries on HTTP 429 with Retry-After backoff (`0` to disable)         |

Reddit closed self-service app creation in November 2025. See [Authentication](#authentication) for how to get credentials.

### Full MCP Config Example

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["reddit-mcp-server"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id",
        "REDDIT_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## Authentication

### ⚠️ Reddit API Changes (2026)

**Anonymous mode no longer works.** As of mid-2026, Reddit blocks all unauthenticated API requests with HTTP 403. OAuth credentials are now required for any API access.

Additionally, Reddit closed self-service OAuth app creation in November 2025. New developers must request access through [Reddit's Developer Support](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164). Existing OAuth credentials (obtained before November 2025) continue to work.

### Getting Credentials

**If you already have a Reddit app** (created at `/prefs/apps` before November 2025): use your existing client ID and secret — they still work at 60-100 req/min.

**If you need new credentials**: submit a request through Reddit's Developer Support describing your use case. Approval is required and may take time.

### Mode Comparison

| Mode              | Rate Limit     | Setup Required    | Tools Available                                | Best For      |
| ----------------- | -------------- | ----------------- | ---------------------------------------------- | ------------- |
| `auto` (default)  | 60-100 req/min | OAuth credentials | All read-only tools                            | Most users    |
| `authenticated`   | 60-100 req/min | OAuth credentials | All read-only tools                            | Explicit mode |
| `auto` (no creds) | ~1 req/min     | None              | `browse_subreddit`, `get_top_posts` only (RSS) | Quick testing |
| `anonymous`       | ~1 req/min     | None              | `browse_subreddit`, `get_top_posts` only (RSS) | Legacy alias  |

### RSS Fallback Mode

When no OAuth credentials are provided, the server automatically falls back to Reddit's public RSS feeds. This gives you zero-setup access to browse subreddits and get top posts.

**What works:** `browse_subreddit` and `get_top_posts` — returns up to 25 posts per request.

**What's missing compared to OAuth:**

- No engagement metrics (score, comments, upvote ratio are all 0)
- No pagination (single page of ~25 results)
- No search, user info, or comments
- Lower rate limit (~1 req/min vs 60-100 with OAuth)

RSS results include a disclaimer noting the data source. All other tools return a clear error directing you to set up OAuth credentials.

### Read-Only Access (OAuth)

The server authenticates as a Reddit OAuth script app using only `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` (client-credentials grant). No username or password is ever read or
sent:

```json
{
  "env": {
    "REDDIT_CLIENT_ID": "your_client_id",
    "REDDIT_CLIENT_SECRET": "your_client_secret"
  }
}
```

## Development

### Commands

```bash
pnpm install        # Install dependencies
pnpm build          # Build TypeScript
pnpm dev            # Build and run MCP inspector
pnpm test           # Run tests
pnpm lint           # Lint code
pnpm format         # Format code
```

### CLI Options

```bash
npx reddit-mcp-server --version         # Show version
npx reddit-mcp-server --help            # Show help
npx reddit-mcp-server --generate-token  # Generate OAuth token for HTTP mode
```

## HTTP Server Mode

For Docker deployments or web-based clients, use HTTP transport:

```bash
TRANSPORT_TYPE=httpStream PORT=3000 node dist/index.js
```

### With OAuth Protection

```bash
export OAUTH_ENABLED=true
export OAUTH_TOKEN=$(npx reddit-mcp-server --generate-token | tail -1)
TRANSPORT_TYPE=httpStream node dist/index.js
```

Make authenticated requests:

```bash
curl -H "Authorization: Bearer $OAUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"method":"tools/list","params":{}}' \
     http://localhost:3000/mcp
```

## Docker

### Quick Start

```bash
# Pull and run
docker pull ghcr.io/jordanburke/reddit-mcp-server:latest

docker run -d \
  --name reddit-mcp \
  -p 3000:3000 \
  -e REDDIT_CLIENT_ID=your_client_id \
  -e REDDIT_CLIENT_SECRET=your_client_secret \
  ghcr.io/jordanburke/reddit-mcp-server:latest
```

### Docker Compose

```yaml
services:
  reddit-mcp:
    image: ghcr.io/jordanburke/reddit-mcp-server:latest
    ports:
      - "3000:3000"
    environment:
      - REDDIT_CLIENT_ID=${REDDIT_CLIENT_ID}
      - REDDIT_CLIENT_SECRET=${REDDIT_CLIENT_SECRET}
      - OAUTH_ENABLED=${OAUTH_ENABLED:-false}
      - OAUTH_TOKEN=${OAUTH_TOKEN}
    restart: unless-stopped
```

### Build Locally

```bash
docker build -t reddit-mcp-server .
docker run -d --name reddit-mcp -p 3000:3000 --env-file .env reddit-mcp-server
```

## Reddit Responsible Builder Policy

This server is designed with [Reddit's Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) in mind:

- **Read-only by design** — no tools create, edit, or delete Reddit content
- **No voting/karma manipulation** — upvote/downvote tools are intentionally excluded
- **No private messaging** — DM tools are intentionally excluded
- **Policy-aware AI instructions** — MCP server instructions remind AI assistants of data usage restrictions

## Credits

- Read-only fork of [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) by Jordan Burke
- Which forks [reddit-mcp-server](https://github.com/alexandros-lekkas/reddit-mcp-server) by Alexandros Lekkas
- Inspired by [Python Reddit MCP Server](https://github.com/Arindam200/reddit-mcp) by Arindam200
