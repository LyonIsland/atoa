export const COURSES = Object.freeze([
  { id: 'AI101', name: 'Introduction to Artificial Intelligence', credits: 3, hours: 7, day: 'Monday', start: '10:00', end: '11:30', tags: ['AI', 'Foundations'], teacher: 'Dr. Chen' },
  { id: 'DATA220', name: 'Data Visualization & Storytelling', credits: 3, hours: 6, day: 'Monday', start: '10:00', end: '11:30', tags: ['Data', 'Design'], teacher: 'Dr. Lin' },
  { id: 'HCI204', name: 'Research Methods in HCI', credits: 4, hours: 9, day: 'Tuesday', start: '14:00', end: '17:00', tags: ['HCI', 'Design'], teacher: 'Dr. Zhou' },
  { id: 'ENT201', name: 'Technology Innovation & Entrepreneurship', credits: 2, hours: 5, day: 'Tuesday', start: '15:30', end: '17:00', tags: ['Design', 'Social'], teacher: 'Dr. He' },
  { id: 'SOC115', name: 'Digital Society & Public Life', credits: 3, hours: 5, day: 'Wednesday', start: '19:00', end: '20:30', tags: ['Social', 'HCI'], teacher: 'Dr. Wang' },
  { id: 'DES130', name: 'Service Design Studio', credits: 3, hours: 8, day: 'Thursday', start: '13:30', end: '16:30', tags: ['Design', 'HCI'], teacher: 'Dr. Xu' }
]);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function createDifficultyRating({ courseId, rating, createdAt = new Date().toISOString() } = {}) {
  const normalizedCourseId = String(courseId || '').trim();
  const normalizedRating = Number(rating);
  if (!normalizedCourseId || !Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    throw new TypeError('Please select a difficulty rating from 1 to 5');
  }
  return { courseId: normalizedCourseId, rating: normalizedRating, createdAt: String(createdAt) };
}

export function parseStoredDifficultyRatings(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const groups = Object.entries(parsed);
    const isValid = groups.every(([courseId, entries]) => courseId.trim()
      && Array.isArray(entries)
      && entries.length <= 1
      && entries.every(entry => entry
        && entry.courseId === courseId
        && Number.isInteger(entry.rating)
        && entry.rating >= 1
        && entry.rating <= 5
        && typeof entry.createdAt === 'string'));
    if (!isValid) return {};
    return Object.fromEntries(groups.map(([courseId, entries]) => [courseId, entries.map(entry => ({ ...entry }))]));
  } catch {
    return {};
  }
}

export function summarizeDifficultyRatings(courseId, ratings = {}) {
  const entries = Array.isArray(ratings[courseId]) ? ratings[courseId] : [];
  const total = entries.reduce((sum, entry) => sum + entry.rating, 0);
  return {
    count: entries.length,
    average: entries.length ? Number((total / entries.length).toFixed(1)) : 0
  };
}

export function upsertDifficultyRating(ratings, input) {
  const entry = createDifficultyRating(input);
  return { ...ratings, [entry.courseId]: [entry] };
}

export function filterAndSortCourses(courses, { maxDifficulty = '', sort = 'default', ratings = {} } = {}) {
  const threshold = maxDifficulty === '' ? null : Number(maxDifficulty);
  const ranked = courses.map((course, index) => ({
    course,
    index,
    summary: summarizeDifficultyRatings(course.id, ratings)
  })).filter(item => threshold === null || (item.summary.count > 0 && item.summary.average <= threshold));

  if (sort === 'easiest' || sort === 'hardest') {
    ranked.sort((first, second) => {
      if (!first.summary.count && !second.summary.count) return first.index - second.index;
      if (!first.summary.count) return 1;
      if (!second.summary.count) return -1;
      const difference = first.summary.average - second.summary.average;
      return (sort === 'easiest' ? difference : -difference) || first.index - second.index;
    });
  }
  return ranked.map(item => item.course);
}

export function createCourseReview({ courseId, rating, comment, createdAt = new Date().toISOString() } = {}) {
  const normalizedRating = Number(rating);
  const normalizedComment = String(comment || '').trim();
  if (!courseId || !Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    throw new TypeError('Please select a rating from 1 to 5 stars');
  }
  if (!normalizedComment) throw new TypeError('Please enter a review comment');
  return { courseId: String(courseId), rating: normalizedRating, comment: normalizedComment.slice(0, 300), createdAt };
}

export function parseStoredReviews(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).map(([courseId, entries]) => [
      courseId,
      Array.isArray(entries) ? entries.filter(review => review
        && Number.isInteger(review.rating)
        && review.rating >= 1
        && review.rating <= 5
        && typeof review.comment === 'string'
        && review.comment.trim()) : []
    ]));
  } catch {
    return {};
  }
}

export function summarizeCourseReviews(courseId, reviews = {}) {
  const entries = Array.isArray(reviews[courseId]) ? reviews[courseId] : [];
  const total = entries.reduce((sum, review) => sum + review.rating, 0);
  return {
    count: entries.length,
    average: entries.length ? Number((total / entries.length).toFixed(1)) : 0,
    recent: [...entries].reverse().slice(0, 3)
  };
}

export function createTeacherReview({ teacher, rating, comment, createdAt = new Date().toISOString() } = {}) {
  const normalizedTeacher = String(teacher || '').trim();
  const normalizedRating = Number(rating);
  const normalizedComment = String(comment || '').trim();
  if (!normalizedTeacher) throw new TypeError('Teacher is required');
  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    throw new TypeError('Please select a rating from 1 to 5 stars');
  }
  if (!normalizedComment) throw new TypeError('Please enter a review comment');
  if (normalizedComment.length > 300) throw new TypeError('Teacher reviews must be 300 characters or fewer');
  return {
    teacher: normalizedTeacher,
    rating: normalizedRating,
    comment: normalizedComment,
    createdAt: String(createdAt)
  };
}

export function parseStoredTeacherReviews(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const groups = Object.entries(parsed);
    const isValid = groups.every(([teacher, entries]) => teacher.trim()
      && Array.isArray(entries)
      && entries.every(review => review
        && review.teacher === teacher
        && Number.isInteger(review.rating)
        && review.rating >= 1
        && review.rating <= 5
        && typeof review.comment === 'string'
        && review.comment.trim()
        && review.comment.length <= 300
        && typeof review.createdAt === 'string'));
    if (!isValid) return {};
    return Object.fromEntries(groups.map(([teacher, entries]) => [
      teacher,
      entries.map(review => ({ ...review, comment: review.comment.trim() }))
    ]));
  } catch {
    return {};
  }
}

export function summarizeTeacherReviews(teacher, reviews = {}) {
  const entries = Array.isArray(reviews[teacher]) ? reviews[teacher] : [];
  const total = entries.reduce((sum, review) => sum + review.rating, 0);
  return {
    count: entries.length,
    average: entries.length ? Number((total / entries.length).toFixed(1)) : 0,
    recent: [...entries].reverse().slice(0, 3)
  };
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function hasScheduleConflict(first, second) {
  return first.day === second.day
    && minutes(first.start) < minutes(second.end)
    && minutes(second.start) < minutes(first.end);
}

export function analyzeSelection(ids, courses = COURSES) {
  const selected = ids.map(id => courses.find(course => course.id === id)).filter(Boolean);
  const conflicts = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (hasScheduleConflict(selected[i], selected[j])) {
        conflicts.push([selected[i].id, selected[j].id]);
      }
    }
  }
  return {
    courses: selected,
    credits: selected.reduce((sum, course) => sum + course.credits, 0),
    hours: selected.reduce((sum, course) => sum + course.hours, 0),
    conflicts
  };
}

export const WEEK_DAYS = Object.freeze([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
]);

export function buildWeeklySchedule(ids, courses = COURSES) {
  const analysis = analyzeSelection(ids, courses);
  const conflictIds = new Set(analysis.conflicts.flat());
  return WEEK_DAYS.map(day => ({
    day,
    courses: analysis.courses
      .filter(course => course.day === day)
      .sort((first, second) => minutes(first.start) - minutes(second.start) || first.id.localeCompare(second.id))
      .map(course => ({ ...course, conflict: conflictIds.has(course.id) }))
  }));
}

export function renderWeeklySchedule(ids, courses = COURSES) {
  return buildWeeklySchedule(ids, courses).map(({ day, courses: dayCourses }) => `
    <section class="schedule-day" aria-label="${day}">
      <h3>${day.slice(0, 3)}</h3>
      <div class="schedule-day-events">
        ${dayCourses.length ? dayCourses.map(course => `
          <article class="schedule-event${course.conflict ? ' is-conflict' : ''}" aria-label="${course.conflict ? 'Schedule conflict: ' : ''}${escapeHtml(course.name)}, ${escapeHtml(course.start)} to ${escapeHtml(course.end)}">
            <strong>${escapeHtml(course.id)}</strong>
            <span>${escapeHtml(course.start)}–${escapeHtml(course.end)}</span>
            <small>${escapeHtml(course.name)}</small>
            ${course.conflict ? '<b class="schedule-conflict-label">Conflict</b>' : ''}
          </article>
        `).join('') : '<p class="schedule-empty">No classes</p>'}
      </div>
    </section>
  `).join('');
}

export function recommendCourses({ interest = '', maxHours = 12, selectedIds = [] } = {}, courses = COURSES) {
  const selected = selectedIds
    .map(id => courses.find(course => course.id === id))
    .filter(Boolean);
  return courses
    .filter(course => course.hours <= Number(maxHours)
      && !selectedIds.includes(course.id)
      && !selected.some(chosen => hasScheduleConflict(course, chosen)))
    .map(course => ({
      ...course,
      score: (interest && course.tags.includes(interest) ? 10 : 0) + (12 - course.hours)
    }))
    .sort((a, b) => b.score - a.score || a.hours - b.hours);
}

export function buildCoursePlan({ interest = '', maxTotalHours = 18, selectedIds = [] } = {}, courses = COURSES) {
  const selectedAnalysis = analyzeSelection(selectedIds, courses);
  const budget = Math.max(0, Number(maxTotalHours) || 0);
  const planned = [];
  let totalHours = selectedAnalysis.hours;
  const candidates = recommendCourses({ interest, maxHours: 12, selectedIds }, courses);
  for (const course of candidates) {
    if (totalHours + course.hours > budget) continue;
    if (planned.some(chosen => hasScheduleConflict(course, chosen))) continue;
    planned.push(course);
    totalHours += course.hours;
  }
  return {
    courses: planned,
    ids: planned.map(course => course.id),
    addedHours: planned.reduce((sum, course) => sum + course.hours, 0),
    totalHours,
    remainingHours: Math.max(0, budget - totalHours)
  };
}

export function mountCourseAssistant(root = document) {
  const search = root.querySelector('#search');
  const interest = root.querySelector('#interest');
  const workload = root.querySelector('#workload');
  const difficulty = root.querySelector('#difficulty');
  const difficultySort = root.querySelector('#difficulty-sort');
  const courseList = root.querySelector('#course-list');
  const planBudget = root.querySelector('#plan-budget');
  const plannerPreview = root.querySelector('#planner-preview');
  const autoPlan = root.querySelector('#auto-plan');
  const scheduleBoard = root.querySelector('#schedule-board');
  if (!search || !interest || !workload || !difficulty || !difficultySort || !courseList || !planBudget || !plannerPreview || !autoPlan || !scheduleBoard) return false;

  const selected = new Set();
  const storageKey = 'atoa-teacher-reviews-v1';
  const difficultyStorageKey = 'atoa-courseplanner-difficulty-ratings-v1';
  let reviews = parseStoredTeacherReviews(root.defaultView?.localStorage?.getItem(storageKey));
  let difficultyRatings = parseStoredDifficultyRatings(root.defaultView?.localStorage?.getItem(difficultyStorageKey));
  let recommendedId = '';
  let pendingPlan = null;
  let reviewCourseId = '';
  let reviewError = '';
  let difficultyErrorCourseId = '';
  let difficultyError = '';

  function persistReviews() {
    root.defaultView?.localStorage?.setItem(storageKey, JSON.stringify(reviews));
  }

  function persistDifficultyRatings() {
    root.defaultView?.localStorage?.setItem(difficultyStorageKey, JSON.stringify(difficultyRatings));
  }

  function visibleCourses() {
    const query = search.value.trim().toLowerCase();
    const matches = COURSES.filter(course => {
      const text = `${course.id} ${course.name} ${course.teacher} ${course.tags.join(' ')}`.toLowerCase();
      return (!query || text.includes(query))
        && (!interest.value || course.tags.includes(interest.value))
        && course.hours <= Number(workload.value);
    });
    return filterAndSortCourses(matches, {
      maxDifficulty: difficulty.value,
      sort: difficultySort.value,
      ratings: difficultyRatings
    });
  }

  function renderCourses() {
    const courses = visibleCourses();
    root.querySelector('#result-count').textContent = `${courses.length} courses`;
    courseList.innerHTML = courses.length ? courses.map(course => {
      const summary = summarizeTeacherReviews(course.teacher, reviews);
      const difficultySummary = summarizeDifficultyRatings(course.id, difficultyRatings);
      const savedDifficulty = difficultyRatings[course.id]?.[0]?.rating || '';
      const difficultyOptions = [1, 2, 3, 4, 5].map(value => `<option value="${value}" ${savedDifficulty === value ? 'selected' : ''}>${value} — ${['Very easy', 'Easy', 'Moderate', 'Challenging', 'Very hard'][value - 1]}</option>`).join('');
      const isReviewing = reviewCourseId === course.id;
      return `
      <article class="course ${course.id === recommendedId ? 'recommended' : ''}">
        <div>
          <div class="course-top">
            <span class="code">${escapeHtml(course.id)}</span>
            ${course.id === recommendedId ? '<span class="badge">Recommended</span>' : ''}
          </div>
          <h3>${escapeHtml(course.name)}</h3>
          <div class="course-meta">
            <span>${escapeHtml(course.teacher)}</span>
            <span>${course.day} ${course.start}–${course.end}</span>
            <span>${course.credits} credits · ${course.hours}h/week</span>
          </div>
          <div class="course-tags">${course.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <div class="course-actions">
          <form class="difficulty-form" data-difficulty-form="${course.id}">
            <span class="difficulty-summary" aria-live="polite"><strong>${difficultySummary.count ? `${difficultySummary.average}/5` : 'Not rated'}</strong><span>${difficultySummary.count} difficulty ${difficultySummary.count === 1 ? 'rating' : 'ratings'}</span></span>
            <label><span class="sr-only">Your difficulty rating for ${escapeHtml(course.name)}</span><select name="rating" aria-label="Your difficulty rating for ${escapeHtml(course.name)}" required><option value="">Rate difficulty</option>${difficultyOptions}</select><button type="submit">${savedDifficulty ? 'Update' : 'Rate'}</button></label>
            ${difficultyErrorCourseId === course.id && difficultyError ? `<small class="difficulty-error" role="alert">${escapeHtml(difficultyError)}</small>` : ''}
          </form>
          <button class="review-button" data-review="${course.id}" aria-expanded="${isReviewing}">
            <strong>${summary.count ? `${summary.average} ★` : 'No ratings'}</strong><span>${summary.count} teacher reviews</span>
          </button>
          <button class="add-button ${selected.has(course.id) ? 'selected' : ''}" data-course="${course.id}">
            ${selected.has(course.id) ? 'Added' : 'Add'}
          </button>
        </div>
        ${isReviewing ? `<section class="review-panel">
          <div class="review-panel-head"><strong>${escapeHtml(course.teacher)} Reviews</strong><span>${summary.count ? `${summary.average} average · ${summary.count} reviews` : 'Be the first to review this teacher'}</span></div>
          <form class="review-form" data-review-form="${course.id}">
            <label><span>Rating</span><select name="rating" required><option value="">Select</option><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option><option value="2">2 stars</option><option value="1">1 star</option></select></label>
            <label><span>Teacher review</span><textarea name="comment" maxlength="300" required placeholder="Share constructive feedback on teaching, clarity, and support"></textarea></label>
            ${reviewError ? `<p class="review-error">${escapeHtml(reviewError)}</p>` : ''}
            <button type="submit">Submit Review</button>
          </form>
          <div class="review-list">${summary.recent.length ? summary.recent.map(review => `<blockquote><strong>${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</strong><p>${escapeHtml(review.comment)}</p></blockquote>`).join('') : '<p class="review-empty">No teacher reviews yet</p>'}</div>
        </section>` : ''}
      </article>
    `;
    }).join('') : '<div class="no-results">No courses match these filters. Try broadening your search.</div>';
  }

  function renderPlan() {
    const analysis = analyzeSelection([...selected]);
    root.querySelector('#selected-count').textContent = `${analysis.courses.length} courses`;
    root.querySelector('#credits').textContent = analysis.credits;
    root.querySelector('#hours').textContent = `${analysis.hours}h`;
    scheduleBoard.innerHTML = renderWeeklySchedule([...selected]);
    root.querySelector('#plan-list').innerHTML = analysis.courses.length
      ? analysis.courses.map(course => `<div class="plan-course"><div><strong>${escapeHtml(course.name)}</strong><br><span>${course.day} ${course.start}</span></div><button data-remove="${course.id}" aria-label="Remove ${escapeHtml(course.name)}">×</button></div>`).join('')
      : '<div class="plan-empty">Add courses that interest you from the catalog</div>';

    const status = root.querySelector('#plan-status');
    if (!analysis.courses.length) {
      status.className = 'plan-status neutral';
      status.innerHTML = '<span>✓</span><p><strong>Select your courses</strong><small>Your plan will be analyzed automatically</small></p>';
    } else if (analysis.conflicts.length) {
      status.className = 'plan-status warning';
      status.innerHTML = `<span>!</span><p><strong>${analysis.conflicts.length} schedule conflicts found</strong><small>${analysis.conflicts.map(pair => pair.join(' and ')).join('; ')}</small></p>`;
    } else if (analysis.hours > 24) {
      status.className = 'plan-status warning';
      status.innerHTML = '<span>!</span><p><strong>High weekly workload</strong><small>Consider removing one high-effort course</small></p>';
    } else {
      status.className = 'plan-status good';
      status.innerHTML = '<span>✓</span><p><strong>Your plan works</strong><small>No schedule conflicts and the workload is manageable</small></p>';
    }
  }

  function renderPlanner() {
    if (pendingPlan === null) {
      plannerPreview.hidden = true;
      plannerPreview.innerHTML = '';
      return;
    }
    plannerPreview.hidden = false;
    if (!pendingPlan.length) {
      plannerPreview.innerHTML = '<strong>No more courses fit this budget</strong><span>Increase your weekly budget or remove a high-effort course.</span><button data-plan-cancel>Got it</button>';
      return;
    }
    const addedHours = pendingPlan.reduce((sum, course) => sum + course.hours, 0);
    plannerPreview.innerHTML = '<strong>Add ' + pendingPlan.length + ' courses · ' + addedHours + ' extra hours/week</strong><div>'
      + pendingPlan.map(course => '<span>' + escapeHtml(course.name) + '</span>').join('')
      + '</div><div class="planner-actions"><button data-plan-cancel>Cancel</button><button data-plan-apply>Apply Plan</button></div>';
  }

  function render() {
    renderCourses();
    renderPlan();
    renderPlanner();
  }

  [search, interest, workload, difficulty, difficultySort].forEach(control => control.addEventListener('input', renderCourses));
  courseList.addEventListener('click', event => {
    const reviewButton = event.target.closest('[data-review]');
    if (reviewButton) {
      reviewCourseId = reviewCourseId === reviewButton.dataset.review ? '' : reviewButton.dataset.review;
      reviewError = '';
      renderCourses();
      return;
    }
    const button = event.target.closest('[data-course]');
    if (!button) return;
    selected.has(button.dataset.course) ? selected.delete(button.dataset.course) : selected.add(button.dataset.course);
    pendingPlan = null;
    render();
  });
  courseList.addEventListener('submit', event => {
    const difficultyForm = event.target.closest('[data-difficulty-form]');
    if (difficultyForm) {
      event.preventDefault();
      const data = new root.defaultView.FormData(difficultyForm);
      try {
        difficultyRatings = upsertDifficultyRating(difficultyRatings, {
          courseId: difficultyForm.dataset.difficultyForm,
          rating: data.get('rating')
        });
        persistDifficultyRatings();
        difficultyErrorCourseId = '';
        difficultyError = '';
        renderCourses();
      } catch (error) {
        difficultyErrorCourseId = difficultyForm.dataset.difficultyForm;
        difficultyError = error.message;
        renderCourses();
      }
      return;
    }
    const form = event.target.closest('[data-review-form]');
    if (!form) return;
    event.preventDefault();
    const data = new root.defaultView.FormData(form);
    try {
      const course = COURSES.find(item => item.id === form.dataset.reviewForm);
      const review = createTeacherReview({
        teacher: course?.teacher,
        rating: data.get('rating'),
        comment: data.get('comment')
      });
      reviews = { ...reviews, [review.teacher]: [...(reviews[review.teacher] || []), review] };
      persistReviews();
      reviewError = '';
      renderCourses();
    } catch (error) {
      reviewError = error.message;
      renderCourses();
    }
  });
  root.querySelector('#plan-list').addEventListener('click', event => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    selected.delete(button.dataset.remove);
    pendingPlan = null;
    render();
  });
  root.querySelector('#clear-plan').addEventListener('click', () => {
    selected.clear();
    pendingPlan = null;
    render();
  });
  autoPlan.addEventListener('click', () => {
    pendingPlan = buildCoursePlan({
      interest: interest.value,
      maxTotalHours: planBudget.value,
      selectedIds: [...selected]
    }).courses;
    renderPlanner();
  });
  planBudget.addEventListener('input', () => {
    pendingPlan = null;
    renderPlanner();
  });
  plannerPreview.addEventListener('click', event => {
    if (event.target.closest('[data-plan-apply]')) {
      pendingPlan.forEach(course => selected.add(course.id));
      pendingPlan = null;
      render();
    } else if (event.target.closest('[data-plan-cancel]')) {
      pendingPlan = null;
      renderPlanner();
    }
  });
  root.querySelector('#recommend').addEventListener('click', () => {
    const visibleIds = new Set(visibleCourses().map(course => course.id));
    recommendedId = recommendCourses({
      interest: interest.value,
      maxHours: workload.value,
      selectedIds: [...selected]
    }).find(course => visibleIds.has(course.id))?.id || '';
    renderCourses();
  });

  render();
  return true;
}

if (typeof document !== 'undefined') mountCourseAssistant();
