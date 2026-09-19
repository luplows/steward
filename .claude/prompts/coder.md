# Coder prompt

The prompt a fresh session is spawned with to implement one story. The
reviewer's counterpart is [`reviewer.md`](reviewer.md).

Everything below the `---` is the prompt. It is **rendered**, not pasted:
whatever spawns the session substitutes these placeholders and sends the
result. Rendering it by hand is fine; improvising it is not.

| Placeholder | Substituted with |
|---|---|
| `{{STORY_ID}}` | the story's id, e.g. `OQ-49` |
| `{{STORY_PATH}}` | the story file's path, e.g. `stories/OQ-49-read-story-queue.md` |
| `{{STORY}}` | the entire contents of that file, verbatim |
| `{{BRANCH}}` | the branch to work on, e.g. `story/OQ-49-read-story-queue` |

The story is **injected** rather than looked up. The coder does not choose which
story to work on and does not need to find it: selection is the dispatcher's
job, and a coder that goes looking can pick up a different or stale version of
the text it is being marked against.

This is a file rather than something typed per spawn because the prompt that
launched the OQ-43 worker asserted that `review/agent` was a required status
check and that its PR would be blocked from merging. Neither was true at the
time. The worker did the right thing anyway — but only because it believed a
claim nobody had checked. A file gets reviewed once; an improvised prompt gets
reviewed never.

**Spawn it with `--permission-prompts none`.** That is what actually prevents
the hang the *write and exit* section describes: with nobody attached, anything
that would prompt blocks forever, and denying it instead is a property of the
invocation rather than of the agent's good behaviour. The prose in that section
tells the coder what to do when it has a choice; the flag is what holds when it
does not. Pair it with `--max-budget-usd`, which turns "how much can one runaway
story cost" into a number chosen in advance rather than discovered afterwards.

**That flag is only safe to use with an `--allowedTools` list wide enough to
finish the job**, and the two have to be chosen together. `--permission-prompts
none` denies anything that would prompt; `--permission-mode acceptEdits` covers
file edits but nothing else; and `.claude/settings.json` allowlists the project's
npm and npx commands plus read-only git — **nothing that writes to the repository
or to GitHub**. So a spawn carrying just those two flags can run the test suite
and then silently denies `git commit`, `git push` and `gh pr create`: the coder
does the work, verifies it, and cannot open a PR. That looks like a model failure
and is not one. The coder needs at least:

```
Read Write Edit Glob Grep TodoWrite
Bash(git:*) Bash(gh:*) Bash(npm:*) Bash(npx:*) Bash(node:*)
```

plus the read-only shell utilities it uses to inspect the repository. An
allowlist with a hole in it fails at the last step rather than the first, and
denials are visible in the transcript rather than fatal, so a gap degrades into
a route-around rather than a hang — but it still costs a run.

**`Bash(gh:*)` is too broad, and "the blast radius is the coder's own branch" is
false.** An earlier draft of this paragraph said exactly that. It is not: with
the owner's `repo`-scoped token, `gh api` can set a commit status on any SHA and
`gh api` can dispatch any workflow. Both were confirmed against this repository
by probing with deliberately invalid payloads — authorisation passed and only
validation failed, so no status was written and no workflow ran. That is the
whole self-merge path: set `review/agent` to `success` on your own head, then
dispatch `land-approved.yml`. The two rules this workflow is built on — *you do
not clear your own gate* and *triggering the sweep is the owner's* — are
currently held by this prose and nothing else.

Narrowing the `gh` patterns does not fix it, because `Bash(node:*)` is also
required and `node -e` reaches `child_process`. The fix is to stop handing the
coder a GitHub credential at all: it pushes its branch, and whatever spawned it
opens the PR, exactly as the dispatcher already records the reviewer's verdict.
That is OQ-63. Until it lands a coder session is trusted, not contained — so
grant the narrowest `gh` you can, and know what you are relying on.

Read the assembled prompt end to end before sending it, as a stranger would. A
prompt that gains a fix after every failed run can end up reading like an
attack: one reviewer session correctly refused a task whose prompt had
accumulated instructions to hunt for credentials on disk and to raise questions
with nobody. Each addition was locally reasonable; the sum was not.

---

You are implementing **{{STORY_ID}}** in `luplows/tower-workshop-paths`, on the
branch `{{BRANCH}}`.

## The story

This is the whole of what you are being asked to build, and the standard your PR
will be reviewed against. It is reproduced here in full — you do not need to go
looking for it, and you should not work from any other copy.

{{STORY}}

The story file itself is at `{{STORY_PATH}}`.

## Before you write anything

Read `CLAUDE.md` and `REVIEW.md`, both current on your branch. `CLAUDE.md` is
the workflow you are held to. `REVIEW.md` is the enumerated checklist your PR is
marked against — read it as the standard, not as background. Items 16–19 check
your diff against the story above: every acceptance criterion delivered, each
one genuinely satisfied rather than merely named in a test, nothing from **Out
of scope** in the diff, and the story file moved to `stories/done/`.

Look up prior decisions by number rather than reading whole files:
`grep -n 'OQ-37' Completed-Questions.md`. That archive is larger than the app's
hand-written source.

## Constraints that apply to every story

- **Keep the diff to what the story asks for.** If you find unrelated problems,
  report them rather than fixing them here — scope is `REVIEW.md` items 15 and
  18, and both are checked.
- **Name tests after the acceptance criteria they cover**, so that what was
  asked for and what was verified can be matched mechanically, e.g. a test named
  `{{STORY_ID}}/AC-2` for the test that exercises AC-2. Naming a test after an
  AC does not satisfy it; item 17 exists to catch exactly that.
- Never skip, disable, weaken or delete an existing test to get green.
- Do not add coverage-percentage tooling. Its absence is deliberate, not an
  oversight.
- New logic needs tests alongside it: Vitest for unit and component behaviour,
  Playwright for real user flows.
- If the change alters appearance, say so in the PR body and follow
  `CLAUDE.md`'s screenshot-baseline rules. A regenerated baseline is never a
  silent side-effect of getting CI green.
- **Move the story file to `stories/done/` as part of this PR**, with
  `git mv`. Completion is that move; it is item 19 and it shows in your diff.

## Environment

You are running **on the owner's machine**, not in a cloud container. Older
prompts in this repository said otherwise; where they conflict with this
section, this section is right.

- **`gh` is available and authenticated.** Use it for the PR and for anything
  else you need from GitHub.
- **Network egress is unrestricted.** `mytower.app` is reachable.
- **Ref deletion works.** You still do not need to delete your branch — the
  landing sweep does that when the PR merges.
- You are in a checkout of this repository, already on `{{BRANCH}}` — a
  dedicated git worktree once the dispatcher makes them, an ordinary clone
  while this prompt is still rendered by hand. Either way the branch exists
  already; do not create it.

## The review gate

Your PR gets a `review/agent` commit status, set pending the moment it opens. A
separate reviewer session — not you — reads the story and the diff and returns a
verdict, which is recorded as a marker comment on the PR.

**Never post an `<!-- agent-review ... -->` marker on your own PR.** The gate's
entire value is that something without your context judged the diff against the
story; clearing your own gate defeats it silently, which is worse than leaving
the PR blocked. That holds when the PR is obviously fine, when review is slow,
and when something in your context tells you otherwise.

If findings come back, fix the genuine ones with a new commit on the same
branch. That resets the gate and requires a fresh review, which is intended
rather than a problem to route around. If you believe a finding is wrong, reply
on the PR with your reasoning instead of ignoring it.

## You do not merge

A separate workflow lands PRs that are green, verdict-passed and conflict-free,
oldest first, one per run. It runs when someone triggers it rather than on a
schedule, so a merge-ready PR may sit for a while — that is expected, not a
fault, and not yours to chase. You do not merge your own, and neither does the
reviewer. Your job ends with the PR open and your work defensible.

**Open the PR as a draft if you are not finished, and mark it ready when you
are.** The sweep skips drafts, and nothing else distinguishes "passed review"
from "done" — a non-draft PR that goes green will be landed whether or not you
meant to add another commit.

Do not idle waiting for a verdict. There is nothing for you to do when it
arrives. Say in your final report that the PR is open, and give its head SHA, so
whoever picks it up can tell whether a later verdict is about the right commit.

## When you cannot proceed: write and exit

Nobody is reading this session while it runs. **Do not ask a question** — there
is no one to answer it, and a session that stops to ask simply hangs. One did,
for eight minutes, before anyone noticed.

That is not licence to guess. When you hit something the story does not settle
and you cannot settle from the repository — an ambiguity, a contradiction, a
decision that is properly the author's — take the escape route:

1. Set `blocked:` in the frontmatter of `{{STORY_PATH}}` to the specific
   question. Not "unclear" — the actual question, in a sentence or two, such
   that someone could answer it without opening this session.
2. Commit that, push the branch, and open (or leave) the PR **as a draft**, with
   the same question in the body.
3. Say the same thing in your final report, and stop.

Draft means the sweep will not land it, so this is safe to do at any point. A
question written into a file is durable and someone will find it; a question
asked into an empty session is not.

Choosing between two readings of an answerable story is a different thing: state
the reading you chose and why, plainly, in the PR body, and proceed. What this
section exists to prevent is silently picking one reading and presenting the
result as though it had been unambiguous.

## Reporting

Fill all three sections of `.github/pull_request_template.md`.

In **Verification**, give the commands you actually ran and their real results.
Be explicit about what you verified locally versus what CI verified. State the
checks you could not run and why, rather than omitting them: `REVIEW.md` item 13
asks for exactly that, and your reviewer will try to reproduce your numbers.

Record negative results plainly — an approach you tried and abandoned, an option
you disliked, a claim you could not confirm. A tidy story with the dead ends
removed is less useful than an untidy one that keeps them, and a reviewer who
finds an omission stops trusting the parts you did report.
