import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RedditClientConfig } from "../../types"
import { RedditClient } from "../reddit-client"

// Store original fetch
const originalFetch = global.fetch

describe("RedditClient", () => {
  let client: RedditClient
  const mockConfig: RedditClientConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    userAgent: "TestApp/1.0.0",
    // Disable 429 retry by default so existing single-response mocks stay deterministic;
    // the rate-limit suite below opts in with its own retry config.
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 60000 },
  }

  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    global.fetch = mockFetch
    client = new RedditClient(mockConfig)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe("anonymous 403 handling", () => {
    const anonConfig: RedditClientConfig = {
      clientId: "",
      clientSecret: "",
      userAgent: "TestApp/1.0.0",
      authMode: "anonymous",
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 60000 },
    }

    it("short-circuits non-RSS tools with NotAuthenticatedError in anonymous mode", async () => {
      const result = await new RedditClient(anonConfig).getSubredditInfo("science")

      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("NotAuthenticatedError")
        expect(result.value.message).toContain("OAuth credentials")
      }
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("does not reinterpret a 403 when authenticated", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ "content-type": "text/html" }),
      })

      const result = await client.getSubredditInfo("science")

      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("HttpError")
      }
    })
  })

  describe("authenticate", () => {
    it("should authenticate with client credentials", async () => {
      const configWithoutUser: RedditClientConfig = {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        userAgent: "TestApp/1.0.0",
      }

      const clientReadOnly = new RedditClient(configWithoutUser)
      const mockTokenResponse = {
        access_token: "test-token-readonly",
        expires_in: 3600,
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      })

      const result = await clientReadOnly.authenticate()
      expect(result.isRight()).toBe(true)

      const callArgs = mockFetch.mock.calls[0]
      const body = new URLSearchParams(callArgs[1].body as string)
      expect(body.get("grant_type")).toBe("client_credentials")
      expect(body.get("username")).toBeNull()
      expect(body.get("password")).toBeNull()
    })

    it("should not re-authenticate if token is still valid", async () => {
      const mockTokenResponse = {
        access_token: "test-token",
        expires_in: 3600,
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      })

      // First authentication
      const result1 = await client.authenticate()
      expect(result1.isRight()).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Second authentication should not make another request
      const result2 = await client.authenticate()
      expect(result2.isRight()).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("should return Left on authentication failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })

      const result = await client.authenticate()
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toContain("Authentication failed: 401")
      }
    })
  })

  describe("getUser", () => {
    it("should fetch user information", async () => {
      const mockUserData = {
        data: {
          name: "testuser",
          id: "123",
          comment_karma: 100,
          link_karma: 200,
          is_mod: false,
          is_gold: true,
          is_employee: false,
          created_utc: 1234567890,
        },
      }

      // Mock authentication
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

      // Mock user request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockUserData,
      })

      const result = await client.getUser("testuser")

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://oauth.reddit.com/user/testuser/about.json",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      )

      expect(result.isRight()).toBe(true)
      const user = result.orThrow()
      expect(user).toEqual({
        name: "testuser",
        id: "123",
        commentKarma: 100,
        linkKarma: 200,
        totalKarma: 300,
        isMod: false,
        isGold: true,
        isEmployee: false,
        createdUtc: 1234567890,
        profileUrl: "https://reddit.com/user/testuser",
      })
    })

    it("rejects a traversal identifier before any request is made", async () => {
      const result = await client.getUser("../../api/v1/me")

      // No fetch at all — not even the auth call — so the bearer token cannot be steered.
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("ValidationError")
      }
    })

    it("should return Left when user fetch fails", async () => {
      // Mock authentication
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

      // Mock failed user request
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toContain("Failed to get user info for testuser")
      }
    })
  })

  // Characterization tests: these lock the OBSERVABLE behavior contract of getUser
  // (Left/Right shape + exact error-message text). They must pass identically before
  // and after the Try/typed-error migration — that is the behavior-preservation proof.
  describe("getUser — behavior contract (characterization)", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

    it("uses total_karma when present instead of summing comment+link karma", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            name: "testuser",
            id: "123",
            comment_karma: 100,
            link_karma: 200,
            total_karma: 999,
            is_mod: false,
            is_gold: false,
            is_employee: false,
            created_utc: 1234567890,
          },
        }),
      })

      const result = await client.getUser("testuser")
      expect(result.isRight()).toBe(true)
      expect(result.orThrow().totalKarma).toBe(999)
    })

    it("returns Left with the exact HTTP-status message on a non-ok response", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const result = await client.getUser("ghost")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get user info for ghost: HTTP 404")
      }
    })

    it("returns Left (not a throw) when the network request fails", async () => {
      mockAuth()
      mockFetch.mockRejectedValueOnce(new Error("network down"))

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toContain("Failed to get user info for testuser")
        expect(result.value.message).toContain("network down")
      }
    })

    it("returns Left when the response body is not valid JSON", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON")
        },
      })

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toContain("Failed to get user info for testuser")
      }
    })

    it("returns Left when the response is missing the data field", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toContain("Failed to get user info for testuser")
      }
    })
  })

  // The capability the migration ADDS: a typed, discriminated error channel that callers
  // can branch on (`_tag`, `HttpError.status`) instead of string-matching messages.
  describe("getUser — typed error contract", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

    it("classifies a non-ok response as a HttpError carrying the status code", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })

      const result = await client.getUser("ratelimited")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("HttpError")
        if (result.value._tag === "HttpError") {
          expect(result.value.status).toBe(429)
        }
      }
    })

    it("classifies a network failure as an UnknownError", async () => {
      mockAuth()
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"))

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("UnknownError")
      }
    })

    it("classifies a malformed JSON body as an UnknownError", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json")
        },
      })

      const result = await client.getUser("testuser")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("UnknownError")
      }
    })
  })

  describe("getSubredditInfo", () => {
    it("should fetch subreddit information", async () => {
      const mockSubredditData = {
        data: {
          display_name: "programming",
          title: "Programming",
          description: "A subreddit for programming",
          public_description: "Public description",
          subscribers: 1000000,
          active_user_count: 5000,
          created_utc: 1234567890,
          over18: false,
          subreddit_type: "public",
          url: "/r/programming/",
        },
      }

      // Mock authentication
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

      // Mock subreddit request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSubredditData,
      })

      const result = await client.getSubredditInfo("programming")

      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://oauth.reddit.com/r/programming/about.json",
        expect.any(Object),
      )

      expect(result.isRight()).toBe(true)
      const subreddit = result.orThrow()
      expect(subreddit.displayName).toBe("programming")
      expect(subreddit.subscribers).toBe(1000000)
    })
  })

  describe("getTopPosts", () => {
    it("should fetch top posts from a subreddit", async () => {
      const mockPostsData = {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "post1",
                title: "Test Post 1",
                author: "author1",
                subreddit: "programming",
                selftext: "Post content",
                url: "https://reddit.com/r/programming/post1",
                score: 100,
                upvote_ratio: 0.95,
                num_comments: 50,
                created_utc: 1234567890,
                over_18: false,
                spoiler: false,
                edited: false,
                is_self: true,
                link_flair_text: null,
                permalink: "/r/programming/comments/post1/",
              },
            },
          ],
        },
      }

      // Mock authentication
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

      // Mock posts request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPostsData,
      })

      const result = await client.getTopPosts("programming", "week", 10)

      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining("/r/programming/top.json?"),
        expect.any(Object),
      )

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("t=week")
      expect(lastCallUrl).toContain("limit=10")

      expect(result.isRight()).toBe(true)
      const posts = result.orThrow().items
      expect(posts).toHaveLength(1)
      expect(posts[0].id).toBe("post1")
      expect(posts[0].title).toBe("Test Post 1")
    })

    it("should fetch top posts from home when no subreddit specified", async () => {
      const mockPostsData = {
        data: {
          children: [],
        },
      }

      // Mock authentication
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

      // Mock posts request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPostsData,
      })

      await client.getTopPosts("", "day", 5)

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("/top.json?")
      expect(lastCallUrl).toContain("t=day")
      expect(lastCallUrl).toContain("limit=5")
    })
  })

  describe("browseSubreddit", () => {
    const mockPostsData = {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "post1",
              title: "Test Post 1",
              author: "author1",
              subreddit: "programming",
              selftext: "Post content",
              url: "https://reddit.com/r/programming/post1",
              score: 100,
              upvote_ratio: 0.95,
              num_comments: 50,
              created_utc: 1234567890,
              over_18: false,
              spoiler: false,
              edited: false,
              is_self: true,
              link_flair_text: null,
              permalink: "/r/programming/comments/post1/",
            },
          },
        ],
      },
    }

    const mockAuthThenPosts = () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockPostsData,
      })
    }

    it("should fetch hot posts without a time filter param", async () => {
      mockAuthThenPosts()

      const result = await client.browseSubreddit("programming", "hot", "week", 10)

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("/r/programming/hot.json?")
      expect(lastCallUrl).toContain("limit=10")
      expect(lastCallUrl).not.toMatch(/[?&]t=/)

      expect(result.isRight()).toBe(true)
      expect(result.orThrow().items[0].id).toBe("post1")
    })

    it("should include the time filter for top sort", async () => {
      mockAuthThenPosts()

      await client.browseSubreddit("programming", "top", "month", 5)

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("/r/programming/top.json?")
      expect(lastCallUrl).toContain("t=month")
      expect(lastCallUrl).toContain("limit=5")
    })

    it("should include the time filter for controversial sort", async () => {
      mockAuthThenPosts()

      await client.browseSubreddit("programming", "controversial", "year", 5)

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("/r/programming/controversial.json?")
      expect(lastCallUrl).toContain("t=year")
    })

    it("should browse the home feed when no subreddit is specified", async () => {
      mockAuthThenPosts()

      await client.browseSubreddit("", "new", "week", 5)

      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastCallUrl).toContain("/new.json?")
      expect(lastCallUrl).not.toMatch(/[?&]t=/)
    })

    it("should reject an invalid sort", async () => {
      const result = await client.browseSubreddit("programming", "bogus", "week", 5)

      expect(result.isLeft()).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe("response caching", () => {
    const postsBody = JSON.stringify({
      data: {
        children: [{ kind: "t3", data: { id: "cached1", title: "Cached", subreddit: "x", score: 1, num_comments: 0 } }],
      },
    })

    it("serves a repeated identical GET from cache without re-fetching", async () => {
      const cachedClient = new RedditClient({ ...mockConfig, cache: { enabled: true, maxBytes: 1_000_000 } })

      // auth
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
      // first (and only) data fetch — must expose text() for caching
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => postsBody,
      })

      const first = await cachedClient.browseSubreddit("cachetest", "hot", "week", 10)
      const second = await cachedClient.browseSubreddit("cachetest", "hot", "week", 10)

      expect(first.orThrow().items[0].id).toBe("cached1")
      expect(second.orThrow().items[0].id).toBe("cached1")
      // auth (1) + single data fetch (1) = 2; the second browse is served from cache
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("does not cache when caching is disabled", async () => {
      // default mockConfig has no cache config
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => JSON.parse(postsBody),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => JSON.parse(postsBody),
      })

      await client.browseSubreddit("cachetest", "hot", "week", 10)
      await client.browseSubreddit("cachetest", "hot", "week", 10)

      // auth (1) + two data fetches = 3
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  // Rollout coverage: locks the exact error-message text (behavior preservation) AND the new
  // typed `_tag` channel for every migrated method. Special attention to the ASYMMETRIC-message
  // methods — getTopPosts/browseSubreddit/searchReddit/getPostComments — where the non-ok HTTP
  // message intentionally differs from the catch-branch context and is hand-preserved.
  describe("typed error contract (rollout)", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
    const okJson = (body: unknown) => mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body })
    const httpStatus = (status: number) => mockFetch.mockResolvedValueOnce({ ok: false, status })

    it("getSubredditInfo: 404 -> HttpError with exact message + status", async () => {
      mockAuth()
      httpStatus(404)
      const result = await client.getSubredditInfo("testsub")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get subreddit info for testsub: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
        if (result.value._tag === "HttpError") expect(result.value.status).toBe(404)
      }
    })

    it("getTopPosts: 404 message omits the subreddit (asymmetric, preserved)", async () => {
      mockAuth()
      httpStatus(503)
      const result = await client.getTopPosts("programming", "week", 10)
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get top posts: HTTP 503")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("getTopPosts: network failure uses the 'for <subreddit>' context (UnknownError)", async () => {
      mockAuth()
      mockFetch.mockRejectedValueOnce(new Error("boom"))
      const result = await client.getTopPosts("programming", "week", 10)
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get top posts for programming: boom")
        expect(result.value._tag).toBe("UnknownError")
      }
    })

    it("browseSubreddit: invalid sort -> ValidationError, no fetch", async () => {
      const result = await client.browseSubreddit("programming", "bogus", "week", 5)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("ValidationError")
        expect(result.value.message).toBe(
          'Invalid sort "bogus". Valid options are: hot, new, top, rising, controversial',
        )
      }
    })

    it("browseSubreddit: 404 message omits the sort (asymmetric, preserved)", async () => {
      mockAuth()
      httpStatus(500)
      const result = await client.browseSubreddit("programming", "hot", "week", 5)
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to browse r/programming: HTTP 500")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("getPost: empty info listing -> NotFoundError", async () => {
      mockAuth()
      okJson({ data: { children: [] } })
      const result = await client.getPost("abc")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("NotFoundError")
        expect(result.value.message).toBe("Post with ID abc not found")
      }
    })

    it("getPost: 404 -> HttpError with context message", async () => {
      mockAuth()
      httpStatus(404)
      const result = await client.getPost("abc")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get post with ID abc: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("getTrendingSubreddits: 404 -> HttpError exact message", async () => {
      mockAuth()
      httpStatus(429)
      const result = await client.getTrendingSubreddits(5)
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get trending subreddits: HTTP 429")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("searchReddit: 404 message omits the query (asymmetric, preserved)", async () => {
      mockAuth()
      httpStatus(400)
      const result = await client.searchReddit("cats", {})
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to search Reddit: HTTP 400")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("searchReddit: network failure includes the query context (UnknownError)", async () => {
      mockAuth()
      mockFetch.mockRejectedValueOnce(new Error("dns"))
      const result = await client.searchReddit("cats", {})
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to search Reddit for: cats: dns")
        expect(result.value._tag).toBe("UnknownError")
      }
    })

    it("getPostComments: 404 message omits the postId (asymmetric, preserved)", async () => {
      mockAuth()
      httpStatus(404)
      const result = await client.getPostComments("p1", "programming", {})
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get comments: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("getUserPosts: 404 -> HttpError exact message", async () => {
      mockAuth()
      httpStatus(404)
      const result = await client.getUserPosts("bob", {})
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get posts for user bob: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
      }
    })

    it("getUserComments: 404 -> HttpError exact message", async () => {
      mockAuth()
      httpStatus(404)
      const result = await client.getUserComments("bob", {})
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get comments for user bob: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
      }
    })
  })

  describe("getSubredditRules", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

    it("fetches and maps subreddit rules", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          rules: [
            {
              short_name: "No spam",
              description: "Do not spam.",
              kind: "all",
              violation_reason: "Spam",
              priority: 0,
              created_utc: 1,
            },
            { short_name: "Flair required", description: "", kind: "link" },
          ],
        }),
      })

      const result = await client.getSubredditRules("programming")
      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://oauth.reddit.com/r/programming/about/rules.json",
        expect.any(Object),
      )
      expect(result.isRight()).toBe(true)
      const rules = result.orThrow()
      expect(rules).toHaveLength(2)
      expect(rules[0].shortName).toBe("No spam")
      expect(rules[0].kind).toBe("all")
      expect(rules[0].violationReason).toBe("Spam")
      expect(rules[1].shortName).toBe("Flair required")
      expect(rules[1].kind).toBe("link")
    })

    it("returns an empty list when the subreddit has no rules", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [] }) })

      const result = await client.getSubredditRules("programming")
      expect(result.isRight()).toBe(true)
      expect(result.orThrow()).toHaveLength(0)
    })

    it("returns a typed HttpError on a non-ok response", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const result = await client.getSubredditRules("ghost")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get rules for r/ghost: HTTP 404")
        expect(result.value._tag).toBe("HttpError")
      }
    })
  })

  describe("getMoreComments", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

    it("expands a 'more' stub into a flat list of comments and forwards ids", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          json: {
            data: {
              things: [
                {
                  kind: "t1",
                  data: {
                    id: "c1",
                    author: "alice",
                    body: "hello",
                    score: 5,
                    controversiality: 0,
                    subreddit: "test",
                    created_utc: 1,
                    edited: false,
                    is_submitter: true,
                    permalink: "/r/test/comments/p1/c1",
                    parent_id: "t3_p1",
                  },
                },
                { kind: "more", data: { id: "x", children: ["c9"] } },
              ],
            },
          },
        }),
      })

      const result = await client.getMoreComments("p1", ["c1", "c2"])

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastUrl).toContain("/api/morechildren?")
      expect(lastUrl).toContain("link_id=t3_p1")
      expect(lastUrl).toContain("children=c1%2Cc2")

      expect(result.isRight()).toBe(true)
      const comments = result.orThrow()
      expect(comments).toHaveLength(1) // the "more" stub is filtered out
      expect(comments[0].id).toBe("c1")
      expect(comments[0].author).toBe("alice")
      expect(comments[0].parentId).toBe("t3_p1")
      expect(comments[0].isSubmitter).toBe(true)
    })

    it("does not double-prefix an already-prefixed link id", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ json: { data: { things: [] } } }) })

      await client.getMoreComments("t3_p1", ["c1"])

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastUrl).toContain("link_id=t3_p1")
      expect(lastUrl).not.toContain("t3_t3_")
    })

    it("returns a typed HttpError on a non-ok response", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })

      const result = await client.getMoreComments("p1", ["c1"])
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to expand comments for p1: HTTP 400")
        expect(result.value._tag).toBe("HttpError")
      }
    })
  })

  describe("getPostFlairs", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })

    it("fetches and maps link flairs from the bare array response", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "abc", text: "Discussion", type: "text", text_editable: false },
          { id: "def", text: "Help", type: "richtext", text_editable: true },
        ],
      })

      const result = await client.getPostFlairs("programming")
      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://oauth.reddit.com/r/programming/api/link_flair_v2.json",
        expect.any(Object),
      )
      expect(result.isRight()).toBe(true)
      const flairs = result.orThrow()
      expect(flairs).toHaveLength(2)
      expect(flairs[0]).toEqual({ id: "abc", text: "Discussion", type: "text", textEditable: false })
      expect(flairs[1].textEditable).toBe(true)
    })

    it("returns a typed HttpError when flairs are not accessible (e.g. 403)", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })

      const result = await client.getPostFlairs("programming")
      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value.message).toBe("Failed to get post flairs for r/programming: HTTP 403")
        expect(result.value._tag).toBe("HttpError")
      }
    })
  })

  describe("rate-limit retry (429)", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
    // Use real Headers objects (case-insensitive get, native string|null) so the mocks match
    // production fetch and don't introduce nullable annotations of our own.
    const res429 = (retryAfter: string) =>
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "retry-after": retryAfter }) })
    // 429 with no rate-limit headers (exercises the exponential-backoff fallback).
    const res429NoHeader = () => mockFetch.mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers() })
    const okSubreddit = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            display_name: "programming",
            title: "Programming",
            description: "d",
            public_description: "pd",
            subscribers: 1,
            created_utc: 1,
            over18: false,
            subreddit_type: "public",
            url: "/r/programming/",
          },
        }),
      })
    const retrying = (overrides: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }> = {}) =>
      new RedditClient({
        ...mockConfig,
        retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 60_000, ...overrides },
      })

    it("retries on 429 (honoring Retry-After) then succeeds", async () => {
      const client2 = retrying()
      mockAuth()
      res429("0")
      okSubreddit()

      const result = await client2.getSubredditInfo("programming")

      expect(result.isRight()).toBe(true)
      expect(result.orThrow().displayName).toBe("programming")
      // auth + first 429 + successful retry
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("gives up after maxRetries and surfaces a typed HttpError(429)", async () => {
      const client2 = retrying({ maxRetries: 2 })
      mockAuth()
      res429("0") // initial
      res429("0") // retry 1
      res429("0") // retry 2

      const result = await client2.getSubredditInfo("programming")

      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("HttpError")
        if (result.value._tag === "HttpError") expect(result.value.status).toBe(429)
      }
      // auth + initial + 2 retries
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it("does not wait longer than maxDelayMs — gives up immediately", async () => {
      const client2 = retrying({ maxRetries: 5, maxDelayMs: 1000 })
      mockAuth()
      res429("9999") // 9999s required wait >> 1s cap

      const result = await client2.getSubredditInfo("programming")

      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) expect(result.value._tag).toBe("HttpError")
      // auth + single 429, no retry attempted
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("falls back to exponential backoff when no Retry-After header is present", async () => {
      const client2 = retrying({ maxRetries: 1, baseDelayMs: 0 })
      mockAuth()
      res429NoHeader() // no Retry-After -> backoff (baseDelayMs 0)
      okSubreddit()

      const result = await client2.getSubredditInfo("programming")

      expect(result.isRight()).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it("does not retry non-429 errors (404)", async () => {
      const client2 = retrying({ maxRetries: 3 })
      mockAuth()
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const result = await client2.getSubredditInfo("programming")

      expect(result.isLeft()).toBe(true)
      if (result.isLeft()) {
        expect(result.value._tag).toBe("HttpError")
        if (result.value._tag === "HttpError") expect(result.value.status).toBe(404)
      }
      // auth + single 404, no retry
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe("pagination (after cursors)", () => {
    const mockAuth = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token", expires_in: 3600 }),
      })
    const postChild = (id: string) => ({
      kind: "t3",
      data: {
        id,
        title: `Post ${id}`,
        author: "a",
        subreddit: "s",
        selftext: "",
        url: "https://reddit.com",
        score: 1,
        upvote_ratio: 1,
        num_comments: 0,
        created_utc: 1,
        over_18: false,
        spoiler: false,
        edited: false,
        is_self: true,
        link_flair_text: null,
        permalink: "/r/s/comments/x/",
      },
    })

    it("returns a Page with items and the after cursor", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { children: [postChild("p1")], after: "t3_next", before: null } }),
      })

      const result = await client.searchReddit("cats", {})
      expect(result.isRight()).toBe(true)
      const page = result.orThrow()
      expect(page.items).toHaveLength(1)
      expect(page.items[0].id).toBe("p1")
      expect(page.after).toBe("t3_next")
      expect(page.before).toBeUndefined()
    })

    it("omits the after cursor when Reddit returns null (last page)", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { children: [postChild("p1")], after: null, before: null } }),
      })

      const page = (await client.searchReddit("cats", {})).orThrow()
      expect(page.after).toBeUndefined()
    })

    it("maps t5 children from type=sr searches instead of dropping them", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            children: [
              {
                kind: "t5",
                data: {
                  id: "2qh0y",
                  display_name: "Python",
                  title: "Python",
                  public_description: "News about the programming language Python.",
                  subscribers: 1500000,
                  active_user_count: 2000,
                  created_utc: 1201242956,
                  over18: false,
                  subreddit_type: "public",
                  url: "/r/Python/",
                },
              },
            ],
            after: "t5_next",
            before: null,
          },
        }),
      })

      const page = (await client.searchReddit("python", { type: "sr" })).orThrow()
      expect(page.items).toHaveLength(1)
      expect(page.items[0].title).toContain("r/Python")
      expect(page.items[0].subreddit).toBe("Python")
      expect(page.items[0].score).toBe(1500000)
      expect(page.items[0].over18).toBe(false)
      expect(page.items[0].url).toBe("https://reddit.com/r/Python/")
      expect(page.after).toBe("t5_next")
    })

    it("maps t2 children from type=user searches instead of dropping them", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            children: [
              {
                kind: "t2",
                data: {
                  id: "abc123",
                  name: "spez",
                  link_karma: 100,
                  comment_karma: 900,
                  total_karma: 1000,
                  is_mod: true,
                  is_gold: true,
                  is_employee: true,
                  created_utc: 1118030400,
                },
              },
            ],
            after: null,
            before: null,
          },
        }),
      })

      const page = (await client.searchReddit("spez", { type: "user" })).orThrow()
      expect(page.items).toHaveLength(1)
      expect(page.items[0].title).toContain("u/spez")
      expect(page.items[0].author).toBe("spez")
      expect(page.items[0].score).toBe(1000)
      expect(page.items[0].url).toBe("https://reddit.com/user/spez")
    })

    it("still drops listing children of unknown kind", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { children: [{ kind: "t1", data: { id: "c1" } }, postChild("p1")], after: null, before: null },
        }),
      })

      const page = (await client.searchReddit("cats", {})).orThrow()
      expect(page.items).toHaveLength(1)
      expect(page.items[0].id).toBe("p1")
    })

    it("forwards the after cursor to the request URL", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { children: [], after: null } }),
      })

      await client.searchReddit("cats", { after: "t3_prev" })

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastUrl).toContain("after=t3_prev")
    })

    it("getTopPosts returns a page and forwards the positional after cursor", async () => {
      mockAuth()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { children: [postChild("p1")], after: "t3_more", before: null } }),
      })

      const page = (await client.getTopPosts("programming", "week", 10, "t3_prev")).orThrow()
      expect(page.items[0].id).toBe("p1")
      expect(page.after).toBe("t3_more")

      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
      expect(lastUrl).toContain("after=t3_prev")
    })
  })
})
