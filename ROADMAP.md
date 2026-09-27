# Reddit MCP Server Roadmap

> **This fork is strictly read-only.** The write-oriented items below (create/edit/delete
> content, subscriptions, voting) reflect upstream plans and are out of scope here — all
> write tools have been removed. Read-only items remain relevant.

## Implemented Features ✅

- Get subreddit info
- Get top posts from subreddits
- Get specific post details
- Get trending subreddits
- Get user information
- Create posts (text/link)
- Reply to posts
- Save/unsave posts and comments
- Delete/edit own posts and comments

## High Priority Features 🔴

### 1. Search Functionality

- **Endpoint**: `/search` and `/r/{subreddit}/search`
- **Tool Name**: `search_reddit`
- **Parameters**: query, subreddit (optional), sort, time_filter, limit
- **Use Case**: Finding specific content, research, monitoring topics

### 2. Get Post Comments

- **Endpoint**: `/r/{subreddit}/comments/{article}`
- **Tool Name**: `get_post_comments`
- **Parameters**: post_id, subreddit, sort, limit
- **Use Case**: Reading full discussions, analyzing conversations

### 3. User Activity

- **Endpoints**: `/user/{username}/submitted`, `/user/{username}/comments`
- **Tool Names**: `get_user_posts`, `get_user_comments`
- **Parameters**: username, sort, time_filter, limit
- **Use Case**: User research, activity analysis

## Medium Priority Features 🟡

### 4. Voting System

- **Endpoint**: `/api/vote`
- **Tool Name**: `vote_on_content`
- **Parameters**: id, direction (1, 0, -1)
- **Use Case**: Engaging with content

### 5. Delete Own Content

- **Endpoint**: `/api/del`
- **Tool Name**: `delete_content`
- **Parameters**: id
- **Use Case**: Content management

## Low Priority Features 🟢

### 6. Edit Posts/Comments

- **Endpoint**: `/api/editusertext`
- **Tool Name**: `edit_content`
- **Parameters**: thing_id, text
- **Use Case**: Fixing typos, updating content

### 7. Subscribe/Unsubscribe

- **Endpoints**: `/api/subscribe`
- **Tool Name**: `manage_subscription`
- **Parameters**: subreddit, action
- **Use Case**: Managing subreddit subscriptions

## Implementation Notes

- This fork is strictly read-only: write operations are out of scope and their tools have been removed
- Rate limiting should be implemented to respect Reddit's API limits
- Error handling should provide clear messages about authentication requirements
- Consider implementing caching for frequently accessed data
