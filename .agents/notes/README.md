# Agent Notes

Notes preserve decision rationale, not current behavior or authorization. Current scoped instructions, maintained documentation, code, and explicit user decisions must be checked separately. A note does not grant permission to change shared systems.

## Scope

Write only for long-lived formats or compatibility, security/permission/approval rules, or a genuinely rejected approach likely to be proposed again. Routine changes and cosmetic choices do not need notes. Do not reconstruct all past decisions, invent alternatives, or copy architecture documentation. The [agent-notes skill](../skills/agent-notes/SKILL.md) describes selection and maintenance.

## Layout and format

Keep notes directly in this directory as `YYYY-MM-DD-kebab-slug.md`. Use the decision's recorded date, not an invented historical date. No lifecycle/class directories, central INDEX, scripts, or archive seals are needed. Discover notes by file search and links from relevant documentation.

Each note starts with this header (replace angle-bracket placeholders):

```markdown
# Agent Note: <specific decision>

Status: accepted
Date: YYYY-MM-DD
Basis: <dated user request, issue/review link, or concrete evidence>

## Problem

<Why a decision is needed, independently of the solution.>

## Decision

<What was chosen, proposed, or rejected; distinguish implementation status.>

## Alternatives considered

<Only actual alternatives and why they lost, or: No alternatives were recorded.>

## Consequences

<Benefits, costs, known limitations, and any unverified claims.>
```

The title, Basis, and all four sections must be nonempty. Date must be a real ISO calendar date matching the filename prefix. Use the exact field and section names above. Body language may follow the task's language.

Status is one of `proposed`, `accepted`, `rejected`, or `superseded`. Accepted means the decision was chosen; it does not mean implementation, release, or verification is complete. Explain why a proposal was rejected in Decision. Optional `## Related` and other sections may add necessary evidence without turning a note into a manual.

## Changes and links

Clarify a decision in its existing note; do not rewrite it into a different decision or silently update historical facts into present-day claims. A new decision gets a new note. For full replacement, retain the old file, set its Status to `superseded`, and add this header field after Basis:

```markdown
Superseded by: [New decision](YYYY-MM-DD-new-slug.md)
```

The new note adds `Supersedes: [Old decision](YYYY-MM-DD-old-slug.md)` after Basis. For partial replacement, keep both statuses and explain the overlap with reciprocal links in Related. Use relative Markdown links to existing repository files; do not rely on a central index. Check links after edits. No automatic deletion or mandatory historical backfill.

Structural checks can verify fields, sections, filenames, and local links. They cannot prove alternatives were actually considered, evidence is accurate, or behavior matches a historical decision; those require review.
