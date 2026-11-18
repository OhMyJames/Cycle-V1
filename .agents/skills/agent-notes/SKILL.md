---

name: agent-notes
description: Record or retrieve Cycle decision rationale for durable formats and compatibility, security and permission boundaries, or rejected approaches likely to be proposed again. Not for every change, routine fixes, cosmetic choices, or architecture inventories.
---

# Agent Notes

Write one short note only when a decision defines a long-lived storage, wire, protocol, or configuration format or compatibility rule; defines a security, permission, or approval boundary; or rejects an approach that future contributors are likely to propose again. Otherwise put rationale in the task report or an authorized commit/MR description. Do not backfill the entire history.

1. Read [the format](../../notes/README.md). Search `.agents/notes/` for the mechanism, relevant paths, and linked decisions. Read plausible matches; a keyword miss alone does not establish a new decision.
2. Reuse the existing note for clarification of the same decision. If the decision or rationale changes, create a new note and cross-link it. For full replacement mark the old note `superseded`; for partial replacement explain what remains in `Related`. Preserve history; no automatic deletion, archival, or sealing.
3. Record the problem, decision, actual alternatives and reasons, and consequences. Cite the date and evidence (user request, issue, review, or observed code). If no alternatives were recorded, say so; never invent them to fill a heading. Missing evidence is a limitation, not permission to guess.
4. Use `proposed` for an unresolved proposal and `accepted` for a chosen decision, not as a claim that implementation or tests passed. Notes are historical rationale, never authority for current behavior or additional authorization. Check current code, scoped instructions, and the user's authorization before acting on an old note.
5. Verify the resulting file, required fields, links, and diff. Report exactly what was checked and what remains unverified. Do not create an INDEX, copy the architecture manual, or write a note merely because a file changed.

Source and deliberate migration differences: [references/source.md](references/source.md).
Offline representative and near-miss cases: [references/evaluation.md](references/evaluation.md). These are review cases, not evidence of model A/B runs.
