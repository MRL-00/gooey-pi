# Code review

> For the complete documentation index, see [llms.txt](https://learn.chatgpt.com/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

Use ChatGPT or Codex to inspect code changes before you commit or push them.

## Start a review





### Review in the app

Open the review pane to understand what changed, give line-specific feedback,
and decide what to stage, revert, commit, or push.

To ask Codex to review the changes, type `/review` in the composer. Choose
**Review against a base branch** or **Review uncommitted changes**. Codex reports
prioritized findings without changing your working tree.

The review pane requires a project inside a Git repository. If your project
isn't a Git repository yet, the app prompts you to create one.







## Choose a review scope





### What changes it shows

The review pane reflects the state of your Git repository, not just what Codex
edited. It includes changes made by Codex, changes you made yourself, and any
other uncommitted changes in the repository.

By default, the review pane shows **Unstaged** changes. Use **Staged** for the
Git index, **Commit** for a selected commit, **Branch** for the diff against your
base branch, or **Last turn** for the most recent assistant turn.

### Review multiple repositories

When a [local project includes multiple folders](https://learn.chatgpt.com/docs/projects#use-local-projects-for-folders-and-codebases)
backed by different Git repositories, the review pane can show changes from each
repository. Open the repository selector in the review header to inspect
another repository and see the lines added or removed without leaving the
current review pane.

Choose **Last turn** to see the assistant's latest changes across the attached
repositories. The repository selector shows **All repos** for that view. Other
review scopes, such as **Unstaged**, **Staged**, and **Branch**, apply to the
repository you select.







## Work with review results





### Code review results

Review findings appear as inline comments in the review pane.

Reviews run in the current chat by default. Under **Settings** > **General** >
**Code review**, choose **Detached** to start a separate review chat. See
[developer settings](https://learn.chatgpt.com/docs/developer-settings?surface=app#app-code-review).

<CodexScreenshot
  alt="Inline code review comments displayed in the review pane"
  lightSrc="/images/codex/app/inline-code-review-light.webp"
  darkSrc="/images/codex/app/inline-code-review-dark.webp"
  maxHeight="400px"
/>











If you ask Codex to apply the fixes it finds, your normal [sandbox and approval
settings](https://learn.chatgpt.com/docs/sandboxing) apply.





## Navigating the review pane

- Clicking a file name typically opens that file in your chosen editor. You
  can choose the default editor in [developer settings](https://learn.chatgpt.com/docs/developer-settings?surface=app#app-project-and-terminal-behavior).
- Clicking the file name background expands or collapses the diff.
- Clicking a single line while holding <kbd>Cmd</kbd> pressed opens the line in your chosen editor.
- If you're happy with a change, you can [stage it or revert changes](#staging-and-reverting-files) you don't want.

## Inline comments for feedback

Inline comments let you attach feedback directly to specific lines in the diff.
This is often the fastest way to guide Codex to the right fix.

To leave an inline comment:

1. Open the review pane.
2. Hover over the line you want to comment on.
3. Select the **+** button that appears.
4. Write your feedback and submit it.
5. After you finish leaving feedback, send a message back to the chat.

Because comments are line-specific, Codex can respond more precisely than with
a general instruction.

Codex treats inline comments as review guidance. After leaving comments, send a
follow-up message that makes your intent explicit, for example, “Address the
inline comments and keep the scope minimal.”

## Pull request reviews

When Codex has GitHub access for your repository and the current project is on
the pull request branch, the ChatGPT desktop app can help you work through pull
request feedback without leaving the app. The sidebar shows pull request
context and feedback from reviewers, and the review pane shows comments
alongside the diff so you can ask Codex to address issues in the same chat.

Install the GitHub CLI (`gh`) and authenticate it with `gh auth login` so Codex
can load pull request context, review comments, and changed files. If `gh` is
missing or unauthenticated, pull request details may not appear in the sidebar
or review pane.

Use this flow when you want to keep the full fix loop in one place:

1. Open the review pane on the pull request branch.
2. Review the pull request context, comments, and changed files.
3. Ask Codex to fix the specific comments you want handled.
4. Inspect the resulting diff in the review pane.
5. Stage, commit, and push the changes to the pull request branch when you're ready.

For GitHub-triggered reviews, see [Use Codex in GitHub](https://learn.chatgpt.com/docs/third-party/github).

## Staging and reverting files

The review pane includes Git actions so you can shape the diff before you
commit.

You can stage, unstage, or revert changes at these levels:

- **Entire diff**: Use the action buttons in the review header, such as **Stage all** or **Revert all**.
- **Per file**: Stage, unstage, or revert an individual file.
- **Per hunk**: Stage, unstage, or revert a single hunk.

Use staging when you want to accept part of the work, and revert when you want
to discard it.

### Staged and unstaged states

Git can represent both staged and unstaged changes in the same file. When that
happens, the pane can show the same file in both views. That's normal Git
behavior.
