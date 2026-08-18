import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COURSES,
  analyzeSelection,
  buildCoursePlan,
  buildWeeklySchedule,
  createCourseReview,
  createDifficultyRating,
  createTeacherReview,
  escapeHtml,
  filterAndSortCourses,
  hasScheduleConflict,
  parseStoredDifficultyRatings,
  parseStoredReviews,
  parseStoredTeacherReviews,
  recommendCourses,
  renderWeeklySchedule,
  summarizeCourseReviews,
  summarizeDifficultyRatings,
  summarizeTeacherReviews,
  upsertDifficultyRating
} from '../public/app.js';

test('the catalog contains enough interdisciplinary demo courses', () => {
  assert.ok(COURSES.length >= 6);
  assert.ok(COURSES.every(course => course.id && course.name && course.credits > 0));
});

test('schedule conflict detection distinguishes overlapping and non-overlapping courses', () => {
  assert.equal(hasScheduleConflict(COURSES[0], COURSES[1]), true);
  assert.equal(hasScheduleConflict(COURSES[0], COURSES[2]), false);
  assert.equal(hasScheduleConflict(COURSES[2], COURSES[3]), true);
});

test('course plan analysis totals credits, workload, and conflicts', () => {
  const result = analyzeSelection(['AI101', 'DATA220', 'SOC115']);
  assert.equal(result.credits, 9);
  assert.equal(result.hours, 18);
  assert.deepEqual(result.conflicts, [['AI101', 'DATA220']]);
});

test('recommendations prioritize interests and respect per-course workload limits', () => {
  const results = recommendCourses({ interest: 'HCI', maxHours: 6 });
  assert.ok(results.length > 0);
  assert.ok(results.every(course => course.hours <= 6));
  assert.ok(results[0].tags.includes('HCI'));
});

test('dynamic course content is escaped before rendering', () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});


test('automatic planning respects budget, interest, and schedule constraints', () => {
  const result = buildCoursePlan({ interest: 'HCI', maxTotalHours: 18, selectedIds: ['AI101'] });
  assert.ok(result.courses.length > 0);
  assert.ok(result.courses[0].tags.includes('HCI'));
  assert.ok(result.totalHours <= 18);
  assert.ok(result.courses.every(course => course.id !== 'AI101'));
  const analysis = analyzeSelection(['AI101', ...result.ids]);
  assert.deepEqual(analysis.conflicts, []);
});


test('course reviews validate input and summarize average ratings', () => {
  const first = createCourseReview({ courseId: 'AI101', rating: 5, comment: 'Thorough content', createdAt: '2026-01-01' });
  const second = createCourseReview({ courseId: 'AI101', rating: 3, comment: 'A little fast', createdAt: '2026-01-02' });
  const summary = summarizeCourseReviews('AI101', { AI101: [first, second] });
  assert.equal(summary.count, 2);
  assert.equal(summary.average, 4);
  assert.equal(summary.recent[0].comment, 'A little fast');
  assert.throws(() => createCourseReview({ courseId: 'AI101', rating: 6, comment: 'Invalid rating' }), /1 to 5/);
  assert.throws(() => createCourseReview({ courseId: 'AI101', rating: 5, comment: '   ' }), /review comment/);
});

test('stored review parsing rejects malformed and invalid data', () => {
  assert.deepEqual(parseStoredReviews('{bad json'), {});
  const parsed = parseStoredReviews(JSON.stringify({
    AI101: [
      { rating: 5, comment: '<img onerror=alert(1)>', createdAt: '2026-01-01' },
      { rating: 9, comment: 'Invalid rating' }
    ]
  }));
  assert.equal(parsed.AI101.length, 1);
  assert.equal(parsed.AI101[0].comment, '<img onerror=alert(1)>');
  assert.equal(escapeHtml(parsed.AI101[0].comment), '&lt;img onerror=alert(1)&gt;');
});


test('teacher reviews aggregate across courses by teacher and reject invalid input', () => {
  const first = createTeacherReview({ teacher: 'Dr. Chen', rating: 5, comment: 'Clear explanations', createdAt: '2026-01-01' });
  const second = createTeacherReview({ teacher: 'Dr. Chen', rating: 4, comment: 'Helpful feedback', createdAt: '2026-01-02' });
  const summary = summarizeTeacherReviews('Dr. Chen', { 'Dr. Chen': [first, second] });
  assert.equal(summary.count, 2);
  assert.equal(summary.average, 4.5);
  assert.equal(summary.recent[0].comment, 'Helpful feedback');
  assert.throws(() => createTeacherReview({ teacher: 'Dr. Chen', rating: 0, comment: 'Invalid' }), /1 to 5/);
  assert.throws(() => createTeacherReview({ teacher: 'Dr. Chen', rating: 5, comment: '   ' }), /review comment/);
  assert.throws(() => createTeacherReview({ teacher: 'Dr. Chen', rating: 5, comment: 'x'.repeat(301) }), /300 characters/);
});

test('teacher review storage rejects the whole malformed payload and preserves safe text as data', () => {
  const safe = createTeacherReview({
    teacher: 'Dr. Chen',
    rating: 5,
    comment: '<img onerror=alert(1)>',
    createdAt: '2026-01-01'
  });
  const parsed = parseStoredTeacherReviews(JSON.stringify({ 'Dr. Chen': [safe] }));
  assert.equal(parsed['Dr. Chen'].length, 1);
  assert.equal(escapeHtml(parsed['Dr. Chen'][0].comment), '&lt;img onerror=alert(1)&gt;');
  assert.deepEqual(parseStoredTeacherReviews(JSON.stringify({
    'Dr. Chen': [safe],
    'Dr. Lin': [{ teacher: 'Dr. Lin', rating: 9, comment: 'Invalid', createdAt: '2026-01-02' }]
  })), {});
  assert.deepEqual(parseStoredTeacherReviews('{bad json'), {});
});

test('difficulty ratings validate, summarize, and update without duplicating a local rating', () => {
  const first = createDifficultyRating({ courseId: 'AI101', rating: 4, createdAt: '2026-01-01' });
  assert.equal(first.rating, 4);
  let ratings = upsertDifficultyRating({}, first);
  ratings = upsertDifficultyRating(ratings, { courseId: 'AI101', rating: 2, createdAt: '2026-01-02' });
  assert.deepEqual(summarizeDifficultyRatings('AI101', ratings), { count: 1, average: 2 });
  assert.throws(() => createDifficultyRating({ courseId: 'AI101', rating: 0 }), /1 to 5/);
  assert.throws(() => createDifficultyRating({ courseId: 'AI101', rating: 4.5 }), /1 to 5/);
});

test('difficulty storage rejects malformed payloads and catalog filtering does not mutate courses', () => {
  const valid = JSON.stringify({ AI101: [{ courseId: 'AI101', rating: 4, createdAt: '2026-01-01' }] });
  const parsed = parseStoredDifficultyRatings(valid);
  assert.equal(parsed.AI101[0].rating, 4);
  assert.deepEqual(parseStoredDifficultyRatings('{bad json'), {});
  assert.deepEqual(parseStoredDifficultyRatings(JSON.stringify({ AI101: [{ courseId: 'AI101', rating: 9, createdAt: '2026-01-01' }] })), {});

  const ratings = {
    AI101: [{ courseId: 'AI101', rating: 4, createdAt: '2026-01-01' }],
    DATA220: [{ courseId: 'DATA220', rating: 2, createdAt: '2026-01-01' }]
  };
  const originalOrder = COURSES.map(course => course.id);
  assert.deepEqual(filterAndSortCourses(COURSES, { maxDifficulty: '3', ratings }).map(course => course.id), ['DATA220']);
  assert.deepEqual(filterAndSortCourses(COURSES, { sort: 'easiest', ratings }).slice(0, 2).map(course => course.id), ['DATA220', 'AI101']);
  assert.deepEqual(filterAndSortCourses(COURSES, { sort: 'hardest', ratings }).slice(0, 2).map(course => course.id), ['AI101', 'DATA220']);
  assert.deepEqual(COURSES.map(course => course.id), originalOrder);
});

test('weekly schedule maps selected courses into seven ordered day columns and marks conflicts', () => {
  const schedule = buildWeeklySchedule(['SOC115', 'DATA220', 'AI101']);
  assert.deepEqual(schedule.map(column => column.day), [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
  ]);
  assert.deepEqual(schedule[0].courses.map(course => course.id), ['AI101', 'DATA220']);
  assert.ok(schedule[0].courses.every(course => course.conflict));
  assert.deepEqual(schedule[2].courses.map(course => course.id), ['SOC115']);
  assert.equal(schedule[2].courses[0].conflict, false);
  assert.deepEqual(schedule[5].courses, []);
});

test('weekly schedule markup reflects selection changes and exposes conflict text', () => {
  const singleCourse = renderWeeklySchedule(['AI101']);
  assert.match(singleCourse, /AI101/);
  assert.doesNotMatch(singleCourse, /DATA220/);
  assert.doesNotMatch(singleCourse, /schedule-conflict-label/);
  const conflictingCourses = renderWeeklySchedule(['AI101', 'DATA220']);
  assert.match(conflictingCourses, /AI101/);
  assert.match(conflictingCourses, /DATA220/);
  assert.match(conflictingCourses, /Schedule conflict:/);
  assert.match(conflictingCourses, />Conflict</);
});
