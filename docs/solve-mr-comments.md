# solve-mr-comments

A script to resolve GitLab MR review comments using opencode.

## Overview

`solve-mr-comments` fetches unresolved discussion threads from a GitLab merge request, opens an interactive opencode session to help fix the issues, then generates and posts replies to each thread.

## Usage

```bash
# Run from any git repo with an open MR on the current branch
solve-mr-comments
```

## Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. VALIDATE ENVIRONMENT                                     │
│    - Check dependencies: fzf, glab, jq, opencode            │
│    - Verify we're on a feature branch (not main/master)     │
│    - Check for open MR via: glab mr view --output json      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. FETCH DISCUSSIONS                                        │
│    - Get current username from: glab auth status            │
│    - Get MR iid from glab mr view output                    │
│    - Fetch all discussions via GitLab API:                  │
│      glab api projects/:id/merge_requests/:iid/discussions  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. FILTER & FORMAT THREADS                                  │
│    - Filter criteria:                                       │
│      • resolvable = true                                    │
│      • resolved = false                                     │
│      • author.username != current_user                      │
│    - Extract for each thread:                               │
│      • discussion_id                                        │
│      • author name/username                                 │
│      • comment body (full conversation)                     │
│      • position info (file, old_line, new_line) for DiffNote│
│      • code context from the diff if available              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. INTERACTIVE SELECTION (fzf)                              │
│    - Display threads in fzf with --multi                    │
│    - Format: "[author] file:line - comment preview..."      │
│    - All pre-selected, user can deselect with TAB           │
│    - Ctrl+A toggles all selections                          │
│    - ENTER confirms selection                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. BUILD PROMPT & START OPENCODE                            │
│    - Generate structured markdown prompt with threads       │
│    - Save prompt to temp file                               │
│    - Start opencode TUI with the prompt (plan mode)         │
│    - Capture session ID for continuation                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. USER WORKS IN OPENCODE                                   │
│    - User sees the review comments in plan mode             │
│    - User makes code fixes as needed                        │
│    - User exits opencode when done                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. GENERATE REPLIES (auto-continue)                         │
│    - Continue the same opencode session via:                │
│      opencode run --session <id> "Generate replies..."      │
│    - Request JSON output mapping thread_id -> reply         │
│    - Parse the generated replies                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. POST REPLIES (confirm each)                              │
│    - For each generated reply:                              │
│      • Display the thread context and proposed reply        │
│      • Prompt: "Post this reply? [y/N]"                     │
│      • If confirmed, POST via GitLab API:                   │
│        projects/:id/merge_requests/:iid/discussions/:did/   │
│        notes                                                │
│    - Show success/failure status for each                   │
└─────────────────────────────────────────────────────────────┘
```

## Prompt Format

The prompt sent to opencode includes structured information about each thread:

```markdown
# MR Review Comments to Address

You are helping resolve review comments on a GitLab merge request.
Below are the unresolved threads that need attention.

---

## Thread 1
**Discussion ID:** `abc123def456`
**Author:** John Doe (@johndoe)
**File:** `src/utils/parser.ts:42`
**Comment:**
> This function could be simplified using Array.reduce() instead of the for loop.

**Code Context:**
```typescript
for (let i = 0; i < items.length; i++) {
    total += items[i].value;
}
```

---

## Thread 2
**Discussion ID:** `789xyz000`
**Author:** Jane Smith (@janesmith)
**File:** `src/api/handler.ts:108-115`
**Comment:**
> Missing error handling for the API call. What happens if the request fails?

**Code Context:**
```typescript
const response = await fetch(url);
const data = await response.json();
return data;
```

---

Please review these comments and make the necessary code changes.
When you're done, exit and I'll help generate replies for each thread.
```

## Reply Generation

After the user exits opencode, the script continues the session to generate replies:

```
Based on the changes you made to address the review comments, generate a reply
for each thread explaining what was done.

Output ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "abc123def456": "Refactored to use Array.reduce() as suggested. The code is now more concise.",
  "789xyz000": "Added try-catch block with proper error handling and logging."
}
```

## Dependencies

| Tool | Purpose | Required |
|------|---------|----------|
| `glab` | GitLab CLI for API access | Yes |
| `opencode` | AI coding assistant | Yes |
| `jq` | JSON parsing | Yes |
| `fzf` | Interactive thread selection | Yes |

## GitLab API Endpoints

### Fetch discussions
```
GET /projects/:id/merge_requests/:merge_request_iid/discussions
```

### Post reply to thread
```
POST /projects/:id/merge_requests/:merge_request_iid/discussions/:discussion_id/notes
Body: { "body": "<reply text>" }
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Not on a branch | Exit with error message |
| On main/master | Exit with error message |
| No open MR found | Exit with helpful message |
| No unresolved threads | Exit with "Nothing to do" |
| fzf selection cancelled | Exit gracefully |
| API request fails | Show error, skip that operation |
| opencode fails | Exit with error |
| Missing dependency | Prompt to install, exit |

## Configuration

The script uses sensible defaults but respects these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TMPDIR` | `/tmp` | Directory for temporary files |

## Examples

### Basic usage
```bash
$ cd my-project
$ git checkout feature/my-branch
$ solve-mr-comments

Checking for open MR on branch: feature/my-branch
Found MR !42: "Add new feature"

Fetching unresolved discussions...
Found 3 unresolved threads from other reviewers.

Select threads to address (TAB to toggle, ENTER to confirm):
> [x] [@johndoe] src/utils.ts:42 - This could be simplified...
  [x] [@janesmith] src/api.ts:108 - Missing error handling...
  [x] [@bob] src/index.ts:15 - Typo in variable name

Starting opencode with 3 threads...

# ... user works in opencode TUI ...

Generating replies...

--- Thread abc123 (@johndoe) ---
src/utils.ts:42
Original: "This could be simplified..."
Reply: "Refactored to use Array.reduce() as suggested."

Post this reply? [y/N] y
Posted!

--- Thread def456 (@janesmith) ---
src/api.ts:108
Original: "Missing error handling..."
Reply: "Added try-catch with proper error logging."

Post this reply? [y/N] y
Posted!

Done! Posted 2 replies, skipped 1.
```

### No threads to resolve
```bash
$ solve-mr-comments
Checking for open MR on branch: feature/my-branch
Found MR !42: "Add new feature"

Fetching unresolved discussions...
No unresolved threads from other reviewers. Nothing to do!
```

## Implementation Notes

1. **Session persistence**: opencode sessions are identified by session ID. The script captures this ID when starting the TUI and uses it for the follow-up `opencode run` command.

2. **DiffNote context**: For inline code comments, the GitLab API provides position information (`old_path`, `new_path`, `old_line`, `new_line`, `line_range`). This is included in the prompt so opencode knows exactly where to look.

3. **Thread conversations**: A discussion can have multiple notes (replies). The script includes the full conversation thread, not just the first comment.

4. **User filtering**: Comments from the current user are excluded since you don't need to reply to your own comments.

5. **fzf bindings**:
   - `TAB`: Toggle single selection
   - `Ctrl+A`: Toggle all
   - `ENTER`: Confirm
   - `ESC`: Cancel

## Future Improvements

- [ ] Support for resolving threads after posting reply
- [ ] Batch mode (`--no-interactive`) for CI/CD
- [ ] Custom reply templates
- [ ] Support for suggesting code changes (GitLab suggestions)
- [ ] Integration with `git commit` to auto-reference threads
