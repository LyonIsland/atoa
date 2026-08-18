---
name: course-planning
description: Maintain the student course assistant's filtering, recommendation, workload budgeting, selection analysis, and schedule-conflict behavior. Use for course planning, recommendation, interest matching, workload, budget, credits, schedules, or conflict-related changes.
---

# Course planning

Preserve the existing domain flow:

1. Filter the catalog without mutating source course data.
2. Rank recommendations by declared interests.
3. Enforce per-course and total weekly workload limits.
4. Reject overlaps with selected courses and with courses already added to the proposed plan.
5. Keep recommendation preview separate from applying the plan.
6. Recalculate credits, workload, and conflicts after every selection change.

Keep domain functions in `public/app.js` pure and exportable for Node tests. Treat time ranges as half-open intervals so adjacent courses do not conflict. When behavior changes, update `tests/app.test.js` with both a valid plan and a rejected conflict or budget case.
