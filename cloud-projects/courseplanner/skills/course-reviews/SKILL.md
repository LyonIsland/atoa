---
name: course-reviews
description: Maintain the student course assistant's course ratings, review validation, average and count summaries, recent-review rendering, and project-scoped persistence. Use for rating, review, stars, comments, aggregation, safe rendering, or localStorage-related changes.
---

# Course reviews

Preserve these invariants:

1. Accept only integer ratings from 1 through 5 and non-empty trimmed review text.
2. Escape all user-provided content before inserting it into HTML strings.
3. Derive average rating, count, and recent reviews from validated records.
4. Store only non-sensitive review state in the project's `localStorage` namespace.
5. Treat malformed or schema-invalid persisted data as empty rather than partially trusting it.
6. Keep parsing and aggregation functions pure and exportable from `public/app.js`.

When behavior changes, update `tests/app.test.js` with an accepted review and rejected invalid or corrupted data.
