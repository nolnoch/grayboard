# docs/future

```doc-meta
owns: the refinement path for unbuilt features (idea issue → design doc → implementation)
invariants: every design doc here starts as a GitHub issue; discussion stays on the issue until the doc exists; a future doc is deleted when built, its as-built facts moving to the owner doc
code-pointers: ../../.github/ISSUE_TEMPLATE/feature-idea.md (intake format), org-bridge.md (the doc shape)
companions: ../CONTRACT.md (doc rules and the ownership map)
```

## The path

1. **Idea.** File an issue with the *Feature idea* template: Problem / Idea / Examples / Open questions / Relations. Refinement happens in the issue's comments.
2. **Design.** When the idea gets traction, add `<name>.md` here in the shape of `org-bridge.md`: a `doc-meta` header carrying `trigger:` (the event that justifies building it) and `last-verified:`, then why/decisions/open questions. The issue links to the doc.
3. **Build.** Implementation issues cite the doc. When the feature ships, its as-built facts move to the owning doc (`../CONTRACT.md` §4) and the future doc is deleted.

An issue stays the unit of discussion until step 2 lands; a doc here with no backing issue is a design nobody can find.
