/* eslint-disable functype/prefer-either --
 * This module is the imperative-to-functional boundary for the Reddit HTTP client.
 * Each public method runs its failure-producing region inside a `Try` and converts the
 * result to `Either<RedditError, T>` via the total `classifyRedditError`. Because the body
 * of `Try.async(() => Promise<T>)` can only signal failure by throwing, the `throw`s here
 * (HTTP/validation/domain errors) are local control-flow captured by that `Try` — they never
 * escape the method boundary. prefer-either's "return Either.left" suggestion does not apply
 * inside a Try body.
 */
import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"

import type {
  Page,
  RedditApiCommentTreeData,
  RedditApiInfoResponse,
  RedditApiLinkFlairResponse,
  RedditApiListingResponse,
  RedditApiMoreChildrenResponse,
  RedditApiPopularSubredditsResponse,
  RedditApiPostCommentsResponse,
  RedditApiPostData,
  RedditApiRulesResponse,
  RedditApiSubredditResponse,
  RedditApiUserResponse,
  RedditAuthMode,
  RedditClientConfig,
  RedditComment,
  RedditFlair,
  RedditPost,
  RedditRule,
  RedditSubreddit,
  RedditUser,
  RetryConfig,
} from "../types"
import { normalizeFullname, normalizeSubreddit, normalizeThingId, normalizeUsername } from "../utils/reddit-identifiers"
import type { RedditError } from "./errors"
import { classifyRedditError, HttpError, NotAuthenticatedError, NotFoundError, ValidationError } from "./errors"
import { ResponseCache } from "./response-cache"
import { RssClient } from "./rss-client"

// Extract Reddit's pagination cursors from a listing's `data`. Reddit returns `after`/`before`
// as a fullname string or null; we surface only present string cursors (no undefined keys, so
// this is safe under exactOptionalPropertyTypes).
function listingCursor(data: { readonly [key: string]: unknown }): Pick<Page<unknown>, "after" | "before"> {
  const after = typeof data.after === "string" ? { after: data.after } : {}
  const before = typeof data.before === "string" ? { before: data.before } : {}
  return { ...after, ...before }
}

function parsePostData(post: RedditApiPostData): RedditPost {
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    selftext: post.selftext,
    url: post.url,
    score: post.score,
    upvoteRatio: post.upvote_ratio,
    numComments: post.num_comments,
    createdUtc: post.created_utc,
    over18: post.over_18,
    spoiler: post.spoiler,
    edited: Boolean(post.edited),
    isSelf: post.is_self,
    linkFlairText: post.link_flair_text ?? undefined,
    permalink: post.permalink,
  }
}

// /search.json?type=sr and type=user return t5 (subreddit) and t2 (account) children rather than
// t3 posts. Surface them through the RedditPost shape searchReddit already returns, so the search
// formatter renders them without a breaking change; score carries subscribers/karma respectively.
function parseSubredditSearchData(sub: RedditApiSubredditResponse["data"]): RedditPost {
  return {
    id: String(sub.id ?? sub.display_name),
    title: `r/${sub.display_name} (${sub.subscribers.toLocaleString("en-US")} subscribers)${sub.title ? ` — ${sub.title}` : ""}`,
    author: "",
    subreddit: sub.display_name,
    selftext: sub.public_description,
    url: `https://reddit.com${sub.url}`,
    score: sub.subscribers,
    upvoteRatio: 1,
    numComments: 0,
    createdUtc: sub.created_utc,
    over18: sub.over18,
    edited: false,
    isSelf: false,
    permalink: sub.url,
  }
}

function parseUserSearchData(user: RedditApiUserResponse["data"]): RedditPost {
  const karma = user.total_karma ?? user.link_karma + user.comment_karma
  return {
    id: user.id,
    title: `u/${user.name} (${karma.toLocaleString("en-US")} karma)`,
    author: user.name,
    subreddit: "",
    url: `https://reddit.com/user/${user.name}`,
    score: karma,
    upvoteRatio: 1,
    numComments: 0,
    createdUtc: user.created_utc,
    over18: false,
    edited: false,
    isSelf: false,
    permalink: `/user/${user.name}`,
  }
}

export class RedditClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly userAgent: string
  private readonly baseUrl: string
  private readonly authMode: RedditAuthMode
  private readonly hasCredentials: boolean
  private readonly cache?: ResponseCache
  private readonly retry: RetryConfig
  private readonly rssClient: RssClient
  readonly usesRss: boolean

  // Mutable state — inherent to a stateful HTTP client with token refresh

  private accessToken?: string

  private tokenExpiry: number = 0

  private authenticated: boolean = false

  constructor(config: RedditClientConfig) {
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.userAgent = config.userAgent
    this.authMode = config.authMode ?? "auto"
    this.hasCredentials = Boolean(this.clientId && this.clientSecret)
    this.baseUrl = this.determineBaseUrl()

    this.cache = config.cache?.enabled === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : undefined

    this.retry = config.retry ?? { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000 }
    this.usesRss = this.authMode === "anonymous" || (this.authMode === "auto" && !this.hasCredentials)
    this.rssClient = new RssClient(this.userAgent)
  }

  private determineBaseUrl(): string {
    switch (this.authMode) {
      case "authenticated":
        return "https://oauth.reddit.com"
      case "anonymous":
        return "https://www.reddit.com"
      case "auto":
        return this.hasCredentials ? "https://oauth.reddit.com" : "https://www.reddit.com"
    }
  }

  // Low-level HTTP boundary. Returns Either<Error, Response>: a Right even for non-ok HTTP
  // statuses (callers inspect response.ok); only thrown failures (network, auth) become Left.
  private async makeRequest(path: string, options: RequestInit = {}): Promise<Either<Error, Response>> {
    const attempt = await Try.async(async (): Promise<Response> => {
      const url = `${this.baseUrl}${path}`
      const method = (options.method ?? "GET").toUpperCase()
      const cacheable = this.cache !== undefined && method === "GET"

      if (cacheable) {
        const cached = this.cache!.get(url)
        if (cached !== undefined) {
          return new Response(cached.body, { status: cached.status })
        }
      }

      const requiresAuth = this.authMode === "authenticated" || (this.authMode === "auto" && this.hasCredentials)

      if (requiresAuth && (Date.now() >= this.tokenExpiry || !this.authenticated)) {
        const authResult = await this.authenticate()
        authResult.orThrow()
      }

      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,

        ...(options.headers as Record<string, string> | undefined),
      }

      if (requiresAuth && this.accessToken !== undefined) {
        headers["Authorization"] = `Bearer ${this.accessToken}`
      }

      const first = await this.fetchWithRetry(url, options, headers, path, 0)

      // 401 once-off re-auth, then retry the request (which itself honors 429 backoff).
      const response =
        first.status === 401 && this.authenticated
          ? await this.fetchWithRetry(url, options, { ...headers, Authorization: await this.reauthorize() }, path, 0)
          : first

      // Cache successful read responses and return a fresh, readable Response.
      // (A fetch Response body can only be consumed once, so we re-wrap the text.)
      if (cacheable && response.ok) {
        const text = await response.text()
        this.cache!.set(url, text, response.status)
        return new Response(text, { status: response.status })
      }

      return response
    })

    return attempt.toEither((error) => error)
  }

  async authenticate(): Promise<Either<Error, void>> {
    if (this.authMode === "anonymous") {
      this.authenticated = false
      return Right(undefined as void)
    }

    if (this.authMode === "authenticated" && !this.hasCredentials) {
      return Left(new Error("Authenticated mode requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET"))
    }

    if (this.authMode === "auto" && !this.hasCredentials) {
      this.authenticated = false
      return Right(undefined as void)
    }

    const attempt = await Try.async(async (): Promise<void> => {
      const now = Date.now()
      if (this.accessToken !== undefined && now < this.tokenExpiry) {
        return
      }

      const authUrl = "https://www.reddit.com/api/v1/access_token"
      const authData = new URLSearchParams()

      authData.append("grant_type", "client_credentials")

      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")
      const response = await fetch(authUrl, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: authData.toString(),
      })

      if (!response.ok) {
        const statusText = response.statusText !== "" ? response.statusText : "Unknown Error"
        throw new Error(`Authentication failed: ${response.status} ${statusText}`)
      }

      const data = (await response.json()) as { access_token: string; expires_in: number }
      this.accessToken = data.access_token
      this.tokenExpiry = now + data.expires_in * 1000
      this.authenticated = true
    })

    return attempt.toEither((error) => error)
  }

  async checkAuthentication(): Promise<boolean> {
    if (!this.authenticated) {
      const result = await this.authenticate()
      return result.isRight()
    }
    return true
  }

  // Re-authenticate and return a fresh Bearer header value (throws via orThrow on failure).
  private async reauthorize(): Promise<string> {
    const result = await this.authenticate()
    result.orThrow()
    return `Bearer ${this.accessToken}`
  }

  // Fetch with transparent retry on HTTP 429. Honors Retry-After / x-ratelimit-reset, else
  // exponential backoff; surfaces the 429 once retries are exhausted or the required wait
  // exceeds the cap. Recursive (not a loop) to satisfy the functional style.
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    headers: Record<string, string>,
    path: string,
    attempt: number,
  ): Promise<Response> {
    const response = await fetch(url, { ...options, headers })
    if (response.status !== 429 || attempt >= this.retry.maxRetries) {
      return response
    }

    const wait = this.retryAfterMs(response).fold(
      () => Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs),
      (ms) => ms,
    )
    if (wait > this.retry.maxDelayMs) {
      return response
    }

    console.error(`[RateLimit] 429 from ${path} — retry ${attempt + 1}/${this.retry.maxRetries} in ${wait}ms`)
    await new Promise((resolve) => setTimeout(resolve, wait))
    return this.fetchWithRetry(url, options, headers, path, attempt + 1)
  }

  // Parse a retry delay (ms) from a 429 response: prefer Retry-After (delta-seconds or
  // HTTP-date), then x-ratelimit-reset (seconds). None when no usable header is present,
  // signalling the caller to fall back to exponential backoff.
  private retryAfterMs(response: Response): Option<number> {
    const { headers } = response

    const retryAfter = headers.get("retry-after")
    if (retryAfter !== null && retryAfter !== "") {
      const seconds = Number(retryAfter)
      if (!Number.isNaN(seconds)) {
        return Option(seconds * 1000)
      }
      const when = Date.parse(retryAfter)
      if (!Number.isNaN(when)) {
        return Option(Math.max(0, when - Date.now()))
      }
    }

    const reset = headers.get("x-ratelimit-reset")
    if (reset !== null && reset !== "") {
      const seconds = Number(reset)
      if (!Number.isNaN(seconds)) {
        return Option(seconds * 1000)
      }
    }

    return Option.none()
  }

  private requiresOAuthError(tool: string): Either<RedditError, never> {
    return Left(
      new NotAuthenticatedError(
        `${tool} requires OAuth credentials (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET). ` +
          "RSS fallback only supports browse_subreddit and get_top_posts.",
      ),
    )
  }

  async getUser(username: string): Promise<Either<RedditError, RedditUser>> {
    if (this.usesRss) return this.requiresOAuthError("get_user_info")
    const context = `Failed to get user info for ${username}`
    const attempt = await Try.async(async (): Promise<RedditUser> => {
      const response = (await this.makeRequest(`/user/${normalizeUsername(username)}/about.json`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiUserResponse
      const { data } = json

      return {
        name: data.name,
        id: data.id,
        commentKarma: data.comment_karma,
        linkKarma: data.link_karma,
        totalKarma: data.total_karma ?? data.comment_karma + data.link_karma,
        isMod: data.is_mod,
        isGold: data.is_gold,
        isEmployee: data.is_employee,
        createdUtc: data.created_utc,
        profileUrl: `https://reddit.com/user/${data.name}`,
      }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getSubredditInfo(subredditName: string): Promise<Either<RedditError, RedditSubreddit>> {
    if (this.usesRss) return this.requiresOAuthError("get_subreddit_info")
    const context = `Failed to get subreddit info for ${subredditName}`
    const attempt = await Try.async(async (): Promise<RedditSubreddit> => {
      const response = (await this.makeRequest(`/r/${normalizeSubreddit(subredditName)}/about.json`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiSubredditResponse
      const { data } = json

      return {
        displayName: data.display_name,
        title: data.title,
        description: data.description,
        publicDescription: data.public_description,
        subscribers: data.subscribers,
        activeUserCount: data.active_user_count ?? undefined,
        createdUtc: data.created_utc,
        over18: data.over18,
        subredditType: data.subreddit_type,
        url: data.url,
      }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getSubredditRules(subreddit: string): Promise<Either<RedditError, readonly RedditRule[]>> {
    if (this.usesRss) return this.requiresOAuthError("get_subreddit_rules")
    const context = `Failed to get rules for r/${subreddit}`
    const attempt = await Try.async(async (): Promise<readonly RedditRule[]> => {
      const response = (await this.makeRequest(`/r/${normalizeSubreddit(subreddit)}/about/rules.json`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiRulesResponse
      return json.rules.map((rule) => ({
        shortName: rule.short_name,
        description: rule.description,
        kind: rule.kind,
        violationReason: rule.violation_reason,
        priority: rule.priority,
        createdUtc: rule.created_utc,
      }))
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getPostFlairs(subreddit: string): Promise<Either<RedditError, readonly RedditFlair[]>> {
    if (this.usesRss) return this.requiresOAuthError("get_post_flairs")
    const context = `Failed to get post flairs for r/${subreddit}`
    const attempt = await Try.async(async (): Promise<readonly RedditFlair[]> => {
      const response = (await this.makeRequest(`/r/${normalizeSubreddit(subreddit)}/api/link_flair_v2.json`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiLinkFlairResponse
      return json.map((flair) => ({
        id: flair.id,
        text: flair.text,
        type: flair.type,
        textEditable: flair.text_editable,
      }))
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getTopPosts(
    subreddit: string,
    timeFilter: string = "week",
    limit: number = 10,
    after?: string,
  ): Promise<Either<RedditError, Page<RedditPost>>> {
    if (this.usesRss) {
      return this.rssClient.fetchSubredditPosts(subreddit, "top", timeFilter, limit, after)
    }

    const params = new URLSearchParams({
      t: timeFilter,
      limit: limit.toString(),
    })
    if (after !== undefined) {
      params.set("after", after)
    }
    const context = `Failed to get top posts for ${subreddit !== "" ? subreddit : "home"}`

    const attempt = await Try.async(async (): Promise<Page<RedditPost>> => {
      const name = normalizeSubreddit(subreddit)
      const endpoint = name !== "" ? `/r/${name}/top.json` : "/top.json"
      const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `Failed to get top posts: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiListingResponse<RedditApiPostData>
      const items = json.data.children.map((child) => parsePostData(child.data))
      return { items, ...listingCursor(json.data) }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async browseSubreddit(
    subreddit: string,
    sort: string = "hot",
    timeFilter: string = "week",
    limit: number = 10,
    after?: string,
  ): Promise<Either<RedditError, Page<RedditPost>>> {
    const validSorts = ["hot", "new", "top", "rising", "controversial"]
    if (!validSorts.includes(sort)) {
      return Left(new ValidationError(`Invalid sort "${sort}". Valid options are: ${validSorts.join(", ")}`))
    }

    if (this.usesRss) {
      return this.rssClient.fetchSubredditPosts(subreddit, sort, timeFilter, limit, after)
    }

    const params = new URLSearchParams({ limit: limit.toString() })
    // The time filter only applies to top/controversial listings.
    if (sort === "top" || sort === "controversial") {
      params.set("t", timeFilter)
    }
    if (after !== undefined) {
      params.set("after", after)
    }
    const home = subreddit !== "" ? subreddit : "home"
    const context = `Failed to browse r/${home} (${sort})`

    const attempt = await Try.async(async (): Promise<Page<RedditPost>> => {
      const name = normalizeSubreddit(subreddit)
      const endpoint = name !== "" ? `/r/${name}/${sort}.json` : `/${sort}.json`
      const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `Failed to browse r/${home}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiListingResponse<RedditApiPostData>
      const items = json.data.children.map((child) => parsePostData(child.data))
      return { items, ...listingCursor(json.data) }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getPost(postId: string, subreddit?: string): Promise<Either<RedditError, RedditPost>> {
    if (this.usesRss) return this.requiresOAuthError("get_reddit_post")
    const context = `Failed to get post with ID ${postId}`

    const attempt = await Try.async(async (): Promise<RedditPost> => {
      const id = normalizeThingId(postId)
      const endpoint = Option(subreddit).fold(
        () => `/api/info.json?id=t3_${id}`,
        (sr) => `/r/${normalizeSubreddit(sr)}/comments/${id}.json`,
      )
      const response = (await this.makeRequest(endpoint)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      if (subreddit !== undefined) {
        const json = (await response.json()) as [RedditApiListingResponse<RedditApiPostData>, unknown]
        return parsePostData(json[0].data.children[0].data)
      }

      const json = (await response.json()) as RedditApiInfoResponse
      if (json.data.children.length === 0) {
        throw new NotFoundError(`Post with ID ${postId} not found`)
      }
      return parsePostData(json.data.children[0].data)
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getTrendingSubreddits(limit: number = 5): Promise<Either<RedditError, readonly string[]>> {
    if (this.usesRss) return this.requiresOAuthError("get_trending_subreddits")
    const params = new URLSearchParams({ limit: limit.toString() })
    const context = `Failed to get trending subreddits`

    const attempt = await Try.async(async (): Promise<readonly string[]> => {
      const response = (await this.makeRequest(`/subreddits/popular.json?${params}`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiPopularSubredditsResponse
      return json.data.children.map((child) => child.data.display_name)
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async searchReddit(
    query: string,
    options: {
      readonly subreddit?: string
      readonly sort?: string
      readonly timeFilter?: string
      readonly limit?: number
      readonly type?: string
      readonly after?: string
      readonly before?: string
    } = {},
  ): Promise<Either<RedditError, Page<RedditPost>>> {
    if (this.usesRss) return this.requiresOAuthError("search_reddit")
    const { subreddit, sort = "relevance", timeFilter = "all", limit = 25, type = "link", after, before } = options
    const params = new URLSearchParams({
      q: query,
      sort,
      t: timeFilter,
      limit: limit.toString(),
      type,
      // eslint-disable-next-line functype/prefer-fold -- conditional spread of native string | undefined into URLSearchParams init
      ...(subreddit !== undefined ? { restrict_sr: "true" } : {}),
      // eslint-disable-next-line functype/prefer-fold -- conditional spread of cursors into URLSearchParams init
      ...(after !== undefined ? { after } : {}),
      // eslint-disable-next-line functype/prefer-fold -- conditional spread of cursors into URLSearchParams init
      ...(before !== undefined ? { before } : {}),
    })
    const context = `Failed to search Reddit for: ${query}`

    const attempt = await Try.async(async (): Promise<Page<RedditPost>> => {
      const endpoint = Option(subreddit).fold(
        () => "/search.json",
        (sr) => `/r/${normalizeSubreddit(sr)}/search.json`,
      )
      const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `Failed to search Reddit: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiListingResponse<Record<string, unknown>>

      const items = json.data.children.flatMap((child): readonly RedditPost[] => {
        if (child.kind === "t3") return [parsePostData(child.data as RedditApiPostData)]
        if (child.kind === "t5") return [parseSubredditSearchData(child.data as RedditApiSubredditResponse["data"])]
        if (child.kind === "t2") return [parseUserSearchData(child.data as RedditApiUserResponse["data"])]
        return []
      })
      return { items, ...listingCursor(json.data) }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getPostComments(
    postId: string,
    subreddit: string,
    options: {
      readonly sort?: string
      readonly limit?: number
    } = {},
  ): Promise<Either<RedditError, { readonly post: RedditPost; readonly comments: readonly RedditComment[] }>> {
    if (this.usesRss) return this.requiresOAuthError("get_post_comments")
    const { sort = "best", limit = 100 } = options
    const params = new URLSearchParams({
      sort,
      limit: limit.toString(),
    })
    const context = `Failed to get comments for post ${postId}`

    const attempt = await Try.async(
      async (): Promise<{ readonly post: RedditPost; readonly comments: readonly RedditComment[] }> => {
        const response = (
          await this.makeRequest(
            `/r/${normalizeSubreddit(subreddit)}/comments/${normalizeThingId(postId)}.json?${params}`,
          )
        ).orThrow()
        if (!response.ok) {
          throw new HttpError(response.status, `Failed to get comments: HTTP ${response.status}`)
        }

        const json = (await response.json()) as RedditApiPostCommentsResponse

        const postData = json[0].data.children[0].data
        const post = parsePostData(postData)

        const parseComments = (
          commentData: ReadonlyArray<{ readonly kind: string; readonly data: RedditApiCommentTreeData }>,
          depth: number = 0,
        ): readonly RedditComment[] =>
          commentData.flatMap((item) => {
            if (item.kind !== "t1" || item.data.body === undefined) return []

            const comment: RedditComment = {
              id: item.data.id,
              author: item.data.author,
              body: item.data.body,
              score: item.data.score,
              controversiality: item.data.controversiality,
              subreddit: item.data.subreddit,
              submissionTitle: post.title,
              createdUtc: item.data.created_utc,
              edited: Boolean(item.data.edited),
              isSubmitter: item.data.is_submitter,
              permalink: item.data.permalink,
              depth,
              parentId: item.data.parent_id,
            }

            const { replies } = item.data
            const childComments =
              replies !== undefined && typeof replies !== "string"
                ? parseComments(replies.data.children, depth + 1)
                : []

            return [comment, ...childComments]
          })

        const comments: readonly RedditComment[] = parseComments(json[1].data.children)

        return { post, comments }
      },
    )

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  // Expand "load more" comment stubs via /api/morechildren. `commentIds` are the ids from a
  // `more` node returned by getPostComments. Returns a flat list of the expanded comments.
  async getMoreComments(
    linkId: string,
    commentIds: readonly string[],
  ): Promise<Either<RedditError, readonly RedditComment[]>> {
    if (this.usesRss) return this.requiresOAuthError("get_more_comments")
    const context = `Failed to expand comments for ${linkId}`

    const attempt = await Try.async(async (): Promise<readonly RedditComment[]> => {
      const params = new URLSearchParams({
        api_type: "json",
        link_id: normalizeFullname(linkId, "t3"),
        children: commentIds.map((id) => normalizeThingId(id)).join(","),
      })
      const response = (await this.makeRequest(`/api/morechildren?${params}`)).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiMoreChildrenResponse
      const things = json.json.data?.things ?? []
      return things
        .filter((thing) => thing.kind === "t1" && thing.data.body !== undefined)
        .map((thing) => {
          const comment = thing.data
          return {
            id: comment.id,
            author: comment.author,
            body: comment.body ?? "",
            score: comment.score,
            controversiality: comment.controversiality,
            subreddit: comment.subreddit,
            submissionTitle: comment.link_title ?? "",
            createdUtc: comment.created_utc,
            edited: Boolean(comment.edited),
            isSubmitter: comment.is_submitter,
            permalink: comment.permalink,
            parentId: comment.parent_id,
          }
        })
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getUserPosts(
    username: string,
    options: {
      readonly sort?: string
      readonly timeFilter?: string
      readonly limit?: number
      readonly after?: string
    } = {},
  ): Promise<Either<RedditError, Page<RedditPost>>> {
    if (this.usesRss) return this.requiresOAuthError("get_user_posts")
    const { sort = "new", timeFilter = "all", limit = 25, after } = options
    const params = new URLSearchParams({
      sort,
      t: timeFilter,
      limit: limit.toString(),
    })
    if (after !== undefined) {
      params.set("after", after)
    }
    const context = `Failed to get posts for user ${username}`

    const attempt = await Try.async(async (): Promise<Page<RedditPost>> => {
      const response = (
        await this.makeRequest(`/user/${normalizeUsername(username)}/submitted.json?${params}`)
      ).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiListingResponse<RedditApiPostData>

      const items = json.data.children.filter((child) => child.kind === "t3").map((child) => parsePostData(child.data))
      return { items, ...listingCursor(json.data) }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }

  async getUserComments(
    username: string,
    options: {
      readonly sort?: string
      readonly timeFilter?: string
      readonly limit?: number
      readonly after?: string
    } = {},
  ): Promise<Either<RedditError, Page<RedditComment>>> {
    if (this.usesRss) return this.requiresOAuthError("get_user_comments")
    const { sort = "new", timeFilter = "all", limit = 25, after } = options
    const params = new URLSearchParams({
      sort,
      t: timeFilter,
      limit: limit.toString(),
    })
    if (after !== undefined) {
      params.set("after", after)
    }
    const context = `Failed to get comments for user ${username}`

    const attempt = await Try.async(async (): Promise<Page<RedditComment>> => {
      const response = (
        await this.makeRequest(`/user/${normalizeUsername(username)}/comments.json?${params}`)
      ).orThrow()
      if (!response.ok) {
        throw new HttpError(response.status, `${context}: HTTP ${response.status}`)
      }

      const json = (await response.json()) as RedditApiListingResponse<RedditApiCommentTreeData>

      const items = json.data.children
        .filter((child) => child.kind === "t1")
        .map((child) => {
          const comment = child.data
          return {
            id: comment.id,
            author: comment.author,
            body: comment.body ?? "",
            score: comment.score,
            controversiality: comment.controversiality,
            subreddit: comment.subreddit,
            submissionTitle: comment.link_title ?? "",
            createdUtc: comment.created_utc,
            edited: Boolean(comment.edited),
            isSubmitter: comment.is_submitter,
            permalink: comment.permalink,
          }
        })
      return { items, ...listingCursor(json.data) }
    })

    return attempt.toEither((error) => classifyRedditError(error, context))
  }
}

// Create and export singleton instance
const clientHolder: { instance: Option<RedditClient> } = { instance: Option.none() }

export function initializeRedditClient(config: RedditClientConfig): RedditClient {
  const client = new RedditClient(config)

  clientHolder.instance = Option(client)
  return client
}

export function getRedditClient(): Option<RedditClient> {
  return clientHolder.instance
}
