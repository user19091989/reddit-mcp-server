import crypto from "crypto"
import dotenv from "dotenv"
import { FastMCP } from "fastmcp"
import { Option } from "functype"
import { z } from "zod"

import { getRedditClient, initializeRedditClient } from "./client/reddit-client"
import type { CacheConfig, FormattedPostInfo, RedditAuthMode, RetryConfig } from "./types"
import { formatCommentInfo, formatPostInfo, formatSubredditInfo, formatUserInfo } from "./utils/formatters"

// Load environment variables
dotenv.config({ quiet: true })

// Version injected at build time by tsdown
declare const __VERSION__: string
const VERSION = (typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev") as `${number}.${number}.${number}`

// User-Agent validation and building
function validateUserAgent(userAgent: string): void {
  const recommendedPattern = /^[\w-]+:[\w-]+:[\d.]+ \(by \/u\/\w+\)$/
  if (!recommendedPattern.test(userAgent)) {
    console.error("[Warning] User-Agent does not follow Reddit's recommended format")
    console.error("[Warning] Recommended: 'platform:app_id:version (by /u/username)'")
    console.error("[Warning] Non-standard User-Agents may increase ban risk")
  }
}

function buildUserAgent(customAgent?: string): string {
  if (customAgent !== undefined) {
    validateUserAgent(customAgent)
    return customAgent
  }

  const fallbackAgent = `typescript:reddit-mcp-server:${VERSION} (by /u/anonymous)`
  console.error("[Setup] Using default anonymous User-Agent. Set REDDIT_USER_AGENT for a custom agent.")
  return fallbackAgent
}

function unwrapClient() {
  return getRedditClient().orThrow(new Error("Reddit client not initialized"))
}

function rssDisclaimer(source?: string): string {
  return source === "rss"
    ? "\n\n> **RSS mode** — scores, comment counts, and upvote ratios are unavailable. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for full data."
    : ""
}

function formatPostSummary(post: FormattedPostInfo, index: number, source?: string): string {
  const statsLines =
    source === "rss"
      ? []
      : [
          `- Score: ${post.stats.score.toLocaleString()} (${(post.stats.upvoteRatio * 100).toFixed(1)}% upvoted)`,
          `- Comments: ${post.stats.comments.toLocaleString()}`,
        ]

  return [
    `### ${index + 1}. ${post.title}`,
    `- Author: u/${post.author}`,
    ...statsLines,
    `- Posted: ${post.metadata.posted}`,
    `- Link: ${post.links.shortLink}`,
  ].join("\n")
}

// Footer appended to paginated listings when more results are available.
function nextPageHint(after?: string): string {
  return Option(after).fold(
    () => "",
    (cursor) => `\n\n---\nMore results available — call again with after="${cursor}" for the next page.`,
  )
}

// Initialize Reddit client
async function setupRedditClient() {
  const clientId = process.env.REDDIT_CLIENT_ID
  const clientSecret = process.env.REDDIT_CLIENT_SECRET
  const customUserAgent = process.env.REDDIT_USER_AGENT
  const authMode = (process.env.REDDIT_AUTH_MODE ?? "auto") as RedditAuthMode

  // Validate auth mode
  if (!["auto", "authenticated", "anonymous"].includes(authMode)) {
    console.error(`[Error] Invalid REDDIT_AUTH_MODE: ${authMode}`)
    console.error("[Error] Valid options are: auto, authenticated, anonymous")
    process.exit(1)
  }

  // In authenticated mode, require credentials
  if (authMode === "authenticated" && (clientId === undefined || clientSecret === undefined)) {
    console.error("[Error] Authenticated mode requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET")
    process.exit(1)
  }

  // For auto/anonymous, credentials are optional
  const hasCredentials = Boolean(clientId && clientSecret)

  // Build user-agent
  const userAgent = buildUserAgent(customUserAgent)

  // Build cache config (enabled by default to ease Reddit rate limits; opt out with REDDIT_CACHE=off)
  const cacheEnabled = (process.env.REDDIT_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.REDDIT_CACHE_MAX_MB ?? "50")
  const cacheConfig: CacheConfig = {
    enabled: cacheEnabled,
    maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
  }

  // Retry on HTTP 429 with Retry-After backoff (opt out with REDDIT_MAX_RETRIES=0)
  const maxRetriesRaw = Number(process.env.REDDIT_MAX_RETRIES ?? "3")
  const retryConfig: RetryConfig = {
    maxRetries: Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : 3,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
  }

  const client = initializeRedditClient({
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    userAgent,
    authMode,
    cache: cacheConfig,
    retry: retryConfig,
  })

  console.error("[Setup] Reddit client initialized")
  console.error(`[Setup] Authentication mode: ${authMode}`)

  if (authMode === "anonymous") {
    console.error(
      "[Warning] REDDIT_AUTH_MODE=anonymous is deprecated; it is now an alias for auto without credentials.",
    )
  }

  if (authMode === "anonymous" || !hasCredentials) {
    console.error("[Setup] RSS fallback mode — no OAuth credentials detected.")
    console.error("[Setup] Only browse_subreddit and get_top_posts are available (~1 req/min, no engagement metrics).")
    console.error("[Setup] Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for full API access (100 req/min).")
    console.error("[Setup] See: https://www.reddit.com/wiki/api")
  } else {
    console.error("[Setup] Testing Reddit API connection...")
    const isConnected = await client.checkAuthentication()

    if (!isConnected) {
      console.error("[Error] ✗ Failed to connect to Reddit API")
      console.error("[Error] Please check your REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET")
      process.exit(1)
    }

    console.error("[Setup] ✓ Reddit API connection successful")
    console.error("[Setup] Using OAuth Reddit API (60-100 req/min)")
  }

  console.error("[Setup] Read-only server: all write tools have been removed")
}

// OAuth token: generate once at startup, never expose in responses
const oauthToken = process.env.OAUTH_TOKEN ?? crypto.randomBytes(32).toString("hex")
if (process.env.OAUTH_ENABLED === "true" && process.env.OAUTH_TOKEN === undefined) {
  console.error(`[Auth] Generated OAuth token: ${oauthToken}`)
}

// Create FastMCP server
const server = new FastMCP({
  name: "reddit-mcp-server",
  version: VERSION,
  instructions: `A read-only Reddit MCP server for personal, non-commercial analysis of public Reddit content.

Available capabilities:
- Fetch Reddit posts, comments, and user information
- Get subreddit details and statistics
- Search Reddit content across posts and subreddits
- Analyze engagement metrics and community insights

This fork is strictly read-only: all write tools (creating, replying, editing, saving, deleting) have been removed.

IMPORTANT - Reddit Responsible Builder Policy compliance:
- Data retrieved via these tools must NOT be used for AI model training without Reddit's written approval
- Data must NOT be sold, licensed, or commercially redistributed
- Do NOT attempt to de-anonymize or re-identify Reddit users
- Do NOT use these tools to manipulate votes, karma, or circumvent Reddit safety mechanisms
For details: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy`,

  // Optional OAuth configuration for HTTP transport
  ...(process.env.OAUTH_ENABLED === "true" && {
    authenticate: (request: { readonly headers: { readonly authorization?: string } }) => {
      const authHeader = request.headers.authorization
      if (!authHeader?.startsWith("Bearer ")) {
        // eslint-disable-next-line functype/prefer-either
        throw new Response(null, {
          status: 401,
          statusText: "Missing or invalid Authorization header",
        })
      }

      const token = authHeader.slice(7)
      const tokenBuffer = Buffer.from(token)
      const expectedBuffer = Buffer.from(oauthToken)
      const tokenHash = crypto.createHash("sha256").update(tokenBuffer).digest()
      const expectedHash = crypto.createHash("sha256").update(expectedBuffer).digest()
      if (!crypto.timingSafeEqual(tokenHash, expectedHash)) {
        // eslint-disable-next-line functype/prefer-either
        throw new Response(null, {
          status: 403,
          statusText: "Invalid token",
        })
      }

      return Promise.resolve({ authenticated: true })
    },
  }),
})

// Test tool
server.addTool({
  name: "test_reddit_mcp_server",
  description:
    "Health check for the Reddit MCP server. Read-only and side-effect-free — inspects local configuration only and makes no Reddit API calls. Returns the server version, whether the Reddit client is initialized, and whether OAuth credentials are present. Use this first to diagnose setup/auth problems. Do NOT use it to check Reddit's own status or connectivity — it never contacts Reddit.",
  annotations: {
    title: "Test Reddit MCP Server",
    readOnlyHint: true,
    openWorldHint: false,
  },
  parameters: z.object({}),
  execute: () => {
    const client = getRedditClient()
    const hasAuth = client.fold(
      () => "✗",
      () => "✓",
    )

    return Promise.resolve(`Reddit MCP Server Status:
- Server: ✓ Running
- Reddit Client: ${hasAuth} ${client.fold(
      () => "Not initialized",
      () => "Initialized",
    )}
- Mode: Read-only (write tools removed)
- Version: ${VERSION}

Ready to handle Reddit API requests!`)
  },
})

// User tools
server.addTool({
  name: "get_user_info",
  description:
    "Get a public profile for any Reddit user: comment/post/total karma, account age and status flags, plus a short activity analysis and engagement tips. Read-only; requires OAuth credentials. Returns profile stats only — use get_user_posts / get_user_comments for their actual content. Do NOT expect private fields here, as only public data is returned.",
  annotations: {
    title: "Get User Info",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z
      .string()
      .describe("The target user's Reddit username, without the u/ prefix (e.g. 'spez', not 'u/spez')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUser(args.username)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user info: ${err.message}`)
      },
      (user) => {
        const formattedUser = formatUserInfo(user)

        return `# User Information: u/${formattedUser.username}

## Profile Overview
- Username: u/${formattedUser.username}
- Karma:
  - Comment Karma: ${formattedUser.karma.commentKarma.toLocaleString()}
  - Post Karma: ${formattedUser.karma.postKarma.toLocaleString()}
  - Total Karma: ${formattedUser.karma.totalKarma.toLocaleString()}
- Account Status: ${formattedUser.accountStatus.join(", ")}
- Account Created: ${formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}

## Activity Analysis
- ${formattedUser.activityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Recommendations
- ${formattedUser.recommendations.replace(/\n {2}- /g, "\n- ")}`
      },
    )
  },
})

server.addTool({
  name: "get_user_posts",
  description:
    "Get posts submitted by a specific user, with sort (new/hot/top) and time filter. Read-only; requires OAuth credentials. Returns a page of posts (title, subreddit, score, upvote ratio, comment count, permalink) plus an `after` cursor for paging. Use get_user_comments for their comments, or get_user_info for karma/profile stats. Do NOT use this to search a subreddit — use search_reddit or browse_subreddit.",
  annotations: {
    title: "Get User Posts",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
    sort: z
      .enum(["new", "hot", "top"])
      .default("new")
      .describe(
        "Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserPosts(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user posts: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          return `No posts found for u/${args.username} with the specified filters.`
        }

        const postSummaries = posts
          .map((post, index) => {
            const flags = [...(post.over18 ? ["**NSFW**"] : []), ...(post.spoiler === true ? ["**Spoiler**"] : [])]

            return `### ${index + 1}. ${post.title} ${flags.join(" ")}
- Subreddit: r/${post.subreddit}
- Score: ${post.score.toLocaleString()} (${(post.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}
- Link: https://reddit.com${post.permalink}`
          })
          .join("\n\n")

        return `# Posts by u/${args.username} (${args.sort} - ${args.time_filter})

${postSummaries}${nextPageHint(page.after)}`
      },
    )
  },
})

server.addTool({
  name: "get_user_comments",
  description:
    "Get comments made by a specific user, with sort (new/hot/top) and time filter. Read-only; requires OAuth credentials. Returns a page of comments (subreddit, parent post title, body excerpt, score, permalink) plus an `after` cursor. Use get_user_posts for their submissions, or get_user_info for karma/profile stats. Do NOT use this to read one post's thread — use get_post_comments.",
  annotations: {
    title: "Get User Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
    sort: z
      .enum(["new", "hot", "top"])
      .default("new")
      .describe(
        "Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
    limit: z.number().min(1).max(100).default(10).describe("How many comments to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserComments(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user comments: ${err.message}`)
      },
      (page) => {
        const comments = page.items
        if (comments.length === 0) {
          return `No comments found for u/${args.username} with the specified filters.`
        }

        const commentSummaries = comments
          .map((comment, index) => {
            const formatted = formatCommentInfo(comment, 300)

            const flags = [...(comment.edited ? ["*(edited)*"] : []), ...(comment.isSubmitter ? ["**OP**"] : [])]

            return `### ${index + 1}. Comment ${flags.join(" ")}
In r/${comment.subreddit} on "${comment.submissionTitle}"

> ${formatted.content}

- Score: ${comment.score.toLocaleString()}
- Posted: ${new Date(comment.createdUtc * 1000).toLocaleString()}
- Link: ${formatted.link}`
          })
          .join("\n\n")

        return `# Comments by u/${args.username} (${args.sort} - ${args.time_filter})

${commentSummaries}${nextPageHint(page.after)}`
      },
    )
  },
})

// Post tools
server.addTool({
  name: "get_reddit_post",
  description:
    "Get a single post by subreddit + post id: title, author, self-text or link content, score, upvote ratio, comment count, flair/flags, and an engagement analysis. Read-only; requires OAuth credentials. Returns the post only — use get_post_comments for its comment thread. Do NOT use this to list a subreddit's posts (use browse_subreddit / get_top_posts) or to find posts by keyword (use search_reddit).",
  annotations: {
    title: "Get Reddit Post",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'programming')."),
    post_id: z
      .string()
      .describe(
        "Base36 post id — the segment after /comments/ in a permalink like reddit.com/r/<sub>/comments/<post_id>/... (e.g. '1abc23'). With or without a t3_ prefix.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getPost(args.post_id, args.subreddit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get post: ${err.message}`)
      },
      (post) => {
        const formattedPost = formatPostInfo(post)

        return `# Post from r/${formattedPost.subreddit}

## Post Details
- Title: ${formattedPost.title}
- Type: ${formattedPost.type}
- Author: u/${formattedPost.author}

## Content
${formattedPost.content}

## Stats
- Score: ${formattedPost.stats.score.toLocaleString()}
- Upvote Ratio: ${(formattedPost.stats.upvoteRatio * 100).toFixed(1)}%
- Comments: ${formattedPost.stats.comments.toLocaleString()}

## Metadata
- Posted: ${formattedPost.metadata.posted}
- Flags: ${formattedPost.metadata.flags.length > 0 ? formattedPost.metadata.flags.join(", ") : "None"}
- Flair: ${formattedPost.metadata.flair}

## Links
- Full Post: ${formattedPost.links.fullPost}
- Short Link: ${formattedPost.links.shortLink}

## Engagement Analysis
- ${formattedPost.engagementAnalysis.replace(/\n {2}- /g, "\n- ")}

## Best Time to Engage
${formattedPost.bestTimeToEngage}`
      },
    )
  },
})

server.addTool({
  name: "get_top_posts",
  description:
    "Get the top-scoring posts from a subreddit — or from the authenticated home feed if no subreddit is given — within a time window (hour…all). Read-only; works without credentials via RSS fallback (titles and links only, no scores or comment counts). Returns a page of posts plus an `after` cursor. This is a shortcut for the 'top' sort; use browse_subreddit for hot/new/rising/controversial, or search_reddit to find posts by keyword.",
  annotations: {
    title: "Get Top Posts",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z
      .string()
      .optional()
      .describe(
        "Subreddit to read, without the r/ prefix (e.g. 'science'). Omit to use the authenticated home feed (requires credentials).",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time window the 'top' ranking is computed over (e.g. 'day' = top today). Default 'week'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getTopPosts(args.subreddit ?? "", args.time_filter, args.limit, args.after)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get top posts: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          const location = Option(args.subreddit).fold(
            () => "home feed",
            (sr) => `r/${sr}`,
          )
          return `No posts found in ${location} for the specified time period.`
        }

        const postSummaries = posts
          .map(formatPostInfo)
          .map((post, index) => formatPostSummary(post, index, page.source))
          .join("\n\n")

        const location = Option(args.subreddit).fold(
          () => "Home Feed",
          (sr) => `r/${sr}`,
        )
        return `# Top Posts from ${location} (${args.time_filter})

${postSummaries}${nextPageHint(page.after)}${rssDisclaimer(page.source)}`
      },
    )
  },
})

server.addTool({
  name: "browse_subreddit",
  description:
    "Browse a subreddit — or the authenticated home feed when no subreddit is given — by sort order: hot, new, top, rising, or controversial. Read-only; works without credentials via RSS fallback (titles and links only, no scores or comment counts). `time_filter` applies only to the top and controversial sorts. Returns a page of posts plus an `after` cursor. Use get_top_posts as a shortcut for the top sort, or search_reddit to find posts by keyword rather than by feed order.",
  annotations: {
    title: "Browse Subreddit",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z
      .string()
      .optional()
      .describe(
        "Subreddit to browse, without the r/ prefix (e.g. 'news'). Omit to use the authenticated home feed (requires credentials).",
      ),
    sort: z
      .enum(["hot", "new", "top", "rising", "controversial"])
      .default("hot")
      .describe(
        "Feed ordering: 'hot' (default), 'new', 'rising', 'top', or 'controversial'. 'top'/'controversial' honor `time_filter`.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time window; only applies to sort='top' or 'controversial'. Ignored otherwise. Default 'week'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.browseSubreddit(
      args.subreddit ?? "",
      args.sort,
      args.time_filter,
      args.limit,
      args.after,
    )
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to browse subreddit: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        const location = Option(args.subreddit).fold(
          () => "home feed",
          (sr) => `r/${sr}`,
        )
        if (posts.length === 0) {
          return `No posts found in ${location}.`
        }

        const postSummaries = posts
          .map(formatPostInfo)
          .map((post, index) => formatPostSummary(post, index, page.source))
          .join("\n\n")

        const timeSuffix = args.sort === "top" || args.sort === "controversial" ? `, ${args.time_filter}` : ""
        const heading = location === "home feed" ? "Home Feed" : location
        return `# ${args.sort} posts from ${heading} (${args.sort}${timeSuffix})

${postSummaries}${nextPageHint(page.after)}${rssDisclaimer(page.source)}`
      },
    )
  },
})

// Subreddit tools
server.addTool({
  name: "get_subreddit_info",
  description:
    "Get a subreddit's profile: title, description, subscriber and active-user counts, creation date, flags, wiki/link URLs, plus a community analysis and posting tips. Read-only; requires OAuth credentials. Returns metadata about the community itself — use browse_subreddit / get_top_posts for its posts, or get_subreddit_rules for its posting rules. Do NOT use this to find subreddits by topic — use search_reddit with type='sr'.",
  annotations: {
    title: "Get Subreddit Info",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'askscience')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getSubredditInfo(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get subreddit info: ${err.message}`)
      },
      (subreddit) => {
        const formattedSubreddit = formatSubredditInfo(subreddit)

        return `# Subreddit Information: r/${formattedSubreddit.name}

## Overview
- Name: r/${formattedSubreddit.name}
- Title: ${formattedSubreddit.title}
- Subscribers: ${formattedSubreddit.stats.subscribers.toLocaleString()}
- Active Users: ${
          typeof formattedSubreddit.stats.activeUsers === "number"
            ? formattedSubreddit.stats.activeUsers.toLocaleString()
            : formattedSubreddit.stats.activeUsers
        }

## Description
${formattedSubreddit.description.short}

## Detailed Description
${formattedSubreddit.description.full}

## Metadata
- Created: ${formattedSubreddit.metadata.created}
- Flags: ${formattedSubreddit.metadata.flags.join(", ")}

## Links
- Subreddit: ${formattedSubreddit.links.subreddit}
- Wiki: ${formattedSubreddit.links.wiki}

## Community Analysis
- ${formattedSubreddit.communityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Engagement Tips
- ${formattedSubreddit.engagementTips.replace(/\n {2}- /g, "\n- ")}`
      },
    )
  },
})

server.addTool({
  name: "get_subreddit_rules",
  description:
    "Get a subreddit's posting rules (each rule's name, what it applies to, and its description). Read-only; requires OAuth credentials. Returns the rules list, or a note when the subreddit lists none. For available post flairs use get_post_flairs instead.",
  annotations: {
    title: "Get Subreddit Rules",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'AskReddit')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getSubredditRules(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get subreddit rules: ${err.message}`)
      },
      (rules) => {
        if (rules.length === 0) {
          return `r/${args.subreddit_name} has no listed subreddit-specific rules.`
        }

        const ruleList = rules
          .map((rule, index) => {
            const applies = rule.kind === "all" ? "posts & comments" : `${rule.kind}s`
            const detail = rule.description.trim() === "" ? "" : `\n${rule.description.trim()}`
            return `### ${index + 1}. ${rule.shortName} _(applies to ${applies})_${detail}`
          })
          .join("\n\n")

        return `# Posting Rules for r/${args.subreddit_name}

${ruleList}`
      },
    )
  },
})

server.addTool({
  name: "get_post_flairs",
  description:
    "List a subreddit's selectable link flairs (flair text + flair_id). Read-only; requires OAuth credentials — some subreddits restrict their flair listings, so this can 403 or return empty. For the subreddit's posting rules use get_subreddit_rules instead.",
  annotations: {
    title: "Get Post Flairs",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'gadgets')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getPostFlairs(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get post flairs: ${err.message}`)
      },
      (flairs) => {
        if (flairs.length === 0) {
          return `r/${args.subreddit_name} has no selectable link flairs (or none are visible to this account).`
        }

        const flairList = flairs
          .map((flair) => {
            const editable = flair.textEditable === true ? " _(text editable)_" : ""
            return `- ${flair.text}${editable} — \`flair_id: ${flair.id}\``
          })
          .join("\n")

        return `# Available Link Flairs for r/${args.subreddit_name}

${flairList}`
      },
    )
  },
})

server.addTool({
  name: "get_trending_subreddits",
  description:
    "Get the subreddits Reddit is currently featuring as trending/popular. Read-only, no parameters; requires OAuth credentials. Returns a list of subreddit names that changes through the day (cached briefly server-side). To find subreddits by keyword instead of by trend, use search_reddit with type='sr'.",
  annotations: {
    title: "Get Trending Subreddits",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({}),
  execute: async () => {
    const client = unwrapClient()

    const result = await client.getTrendingSubreddits()
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get trending subreddits: ${err.message}`)
      },
      (trendingSubreddits) => `# Trending Subreddits

${trendingSubreddits.map((subreddit, index) => `${index + 1}. r/${subreddit}`).join("\n")}`,
    )
  },
})

// Search tools
server.addTool({
  name: "search_reddit",
  description:
    "Search Reddit for posts — or subreddits/users via `type` — optionally scoped to one subreddit, with sort and time filters. Read-only; requires OAuth credentials. Returns a page of results (title, subreddit, author, score, comments, link) plus an `after` cursor for paging. Use this to find content by keyword; use browse_subreddit / get_top_posts to list a known subreddit's feed instead.",
  annotations: {
    title: "Search Reddit",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Search terms; supports Reddit operators (quotes for exact phrases, author:name, self:yes). Must be non-empty.",
      ),
    subreddit: z
      .string()
      .optional()
      .describe(
        "Restrict results to this subreddit, without the r/ prefix (e.g. 'python'). Omit to search all of Reddit.",
      ),
    sort: z
      .enum(["relevance", "hot", "top", "new", "comments"])
      .default("relevance")
      .describe(
        "Sort order. Prefer 'relevance' (default) for finding posts about a topic. Use 'top'/'hot' only for what's currently popular and 'new' for the latest — these rank by karma/recency and, especially combined with a narrow time_filter, can surface loosely-matching posts over the best topical results.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Restrict to results from this recent window (e.g. 'week'). Default 'all' (no time limit)."),
    limit: z.number().min(1).max(100).default(10).describe("How many results to return, 1–100 (default 10)."),
    type: z
      .enum(["link", "sr", "user"])
      .default("link")
      .describe("What to search for: 'link' = posts (default), 'sr' = subreddits, 'user' = users."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }

    const result = await client.searchReddit(args.query, {
      subreddit: args.subreddit,
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      type: args.type,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to search: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          const searchLocation = Option(args.subreddit).fold(
            () => "",
            (sr) => ` in r/${sr}`,
          )
          return `No results found for "${args.query}"${searchLocation}.`
        }

        const searchResults = posts
          .map((post, index) => {
            const flags = [...(post.over18 ? ["**NSFW**"] : []), ...(post.spoiler === true ? ["**Spoiler**"] : [])]

            return `### ${index + 1}. ${post.title} ${flags.join(" ")}
- Subreddit: r/${post.subreddit}
- Author: u/${post.author}
- Score: ${post.score.toLocaleString()} (${(post.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}
- Link: https://reddit.com${post.permalink}`
          })
          .join("\n\n")

        const searchLocation = Option(args.subreddit).fold(
          () => "",
          (sr) => ` in r/${sr}`,
        )
        return `# Reddit Search Results for: "${args.query}"${searchLocation}

Sorted by: ${args.sort} | Time: ${args.time_filter} | Type: ${args.type}

${searchResults}${nextPageHint(page.after)}`
      },
    )
  },
})

// Comment tools
server.addTool({
  name: "get_post_comments",
  description:
    "Get the comment thread for a post (by post id + subreddit), sorted best/top/new/controversial/old/qa. Read-only; requires OAuth credentials. Returns the post header plus threaded comments (author, OP/edited badges, score, body, nesting depth) up to `limit`. Long threads are truncated with 'load more' stubs — expand those with get_more_comments. Use get_reddit_post for just the post body, not the thread.",
  annotations: {
    title: "Get Post Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    post_id: z
      .string()
      .describe(
        "Base36 post id — the segment after /comments/ in a permalink (e.g. '1abc23'). With or without a t3_ prefix.",
      ),
    subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'movies')."),
    sort: z
      .enum(["best", "top", "new", "controversial", "old", "qa"])
      .default("best")
      .describe("Comment ordering: 'best' (default), 'top', 'new', 'controversial', 'old', or 'qa' (Q&A)."),
    limit: z
      .number()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        "Maximum comments to return, 1–500 (default 100). Deeply nested replies may still be truncated as 'load more' stubs.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (args.post_id === "" || args.subreddit === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("post_id and subreddit are required")
    }

    const result = await client.getPostComments(args.post_id, args.subreddit, {
      sort: args.sort,
      limit: args.limit,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get comments: ${err.message}`)
      },
      ({ post, comments }) => {
        const header = `# Comments for: ${post.title}

**Post by u/${post.author} in r/${post.subreddit}**
- Score: ${post.score.toLocaleString()} | Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}

---

`

        if (comments.length === 0) {
          return `${header}No comments found for this post.`
        }

        const commentSummaries = comments
          .map((comment) => {
            const indent = "└─".repeat(Math.min(comment.depth ?? 0, 3))
            const authorBadge = comment.isSubmitter ? " **[OP]**" : ""
            const editedBadge = comment.edited ? " *(edited)*" : ""

            return `${indent} **u/${comment.author}**${authorBadge}${editedBadge} (${comment.score.toLocaleString()} points)

${comment.body}

---`
          })
          .join("\n\n")

        return header + commentSummaries
      },
    )
  },
})

server.addTool({
  name: "get_more_comments",
  description:
    "Expand truncated 'load more comments' stubs in a thread. Read-only; requires OAuth credentials. Pass the post's link id and the comment ids from a 'more' node (surfaced by get_post_comments) to fetch those hidden comments; returns the expanded comments (author, body excerpt, score, link). Call get_post_comments first to obtain the thread and its 'more' node ids — do NOT invent ids.",
  annotations: {
    title: "Get More Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    link_id: z
      .string()
      .describe("The parent post's link id (base36, with or without the t3_ prefix) that the stub belongs to."),
    comment_ids: z
      .array(z.string())
      .min(1)
      .describe(
        "Base36 comment ids to expand, taken from a 'more' node returned by get_post_comments (not arbitrary ids).",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getMoreComments(args.link_id, args.comment_ids)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to expand comments: ${err.message}`)
      },
      (comments) => {
        if (comments.length === 0) {
          return "No additional comments were returned for those ids."
        }

        const commentList = comments
          .map((comment, index) => {
            const formatted = formatCommentInfo(comment, 300)
            const flags = [...(comment.edited ? ["*(edited)*"] : []), ...(comment.isSubmitter ? ["**OP**"] : [])]
            return `### ${index + 1}. u/${comment.author} ${flags.join(" ")}
> ${formatted.content}

- Score: ${comment.score.toLocaleString()}
- Link: ${formatted.link}`
          })
          .join("\n\n")

        return `# Expanded Comments (${comments.length})

${commentList}`
      },
    )
  },
})

// Initialize and start server
async function main() {
  await setupRedditClient()

  const useHttp = process.env.TRANSPORT_TYPE === "httpStream" || process.env.TRANSPORT_TYPE === "http"
  const port = parseInt(process.env.PORT ?? "3000")
  const host = process.env.HOST ?? "127.0.0.1"

  if (useHttp) {
    console.error(`[Setup] Starting HTTP server on ${host}:${port}`)
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        host,
        endpoint: "/mcp",
      },
    })
    console.error(`[Setup] HTTP server ready at http://${host}:${port}/mcp`)
    console.error(`[Setup] SSE endpoint available at http://${host}:${port}/sse`)
  } else {
    console.error("[Setup] Starting in stdio mode")
    if (process.stdin.isTTY) {
      console.error(
        "[Setup] ⚠ stdin is a terminal. This server speaks MCP JSON-RPC over stdio and expects an MCP client " +
          "(Claude Desktop, Claude Code, MCP Inspector) on the other end — typed input will cause JSON parse errors.",
      )
      console.error("[Setup]   Test interactively: npx @modelcontextprotocol/inspector npx reddit-mcp-server")
      console.error("[Setup]   Or run as HTTP:       TRANSPORT_TYPE=httpStream npx reddit-mcp-server")
    }
    await server.start({
      transportType: "stdio",
    })
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.error("[Shutdown] Shutting down Reddit MCP Server...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  console.error("[Shutdown] Shutting down Reddit MCP Server...")
  process.exit(0)
})

void main().catch(console.error)
