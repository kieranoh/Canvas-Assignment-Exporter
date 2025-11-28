const BASE = "https://canvas.skku.edu";
const PREFIX_REGEX = /^while\s*\(1\);\s*/;

const statusEl = document.getElementById("status");
const etaEl = document.getElementById("eta");
const progressBarEl = document.getElementById("progress-bar");
const exportBtn = document.getElementById("export");

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(done, total, phaseLabel) {
  if (!total || total === 0) {
    progressBarEl.style.width = "0%";
    return;
  }
  const pct = Math.floor((done / total) * 100);
  progressBarEl.style.width = pct + "%";
  statusEl.textContent = `${phaseLabel} ${done} / ${total} (${pct}%)`;
}

function setEta(startTime, done, total) {
  if (!total || total === 0 || done === 0) {
    etaEl.textContent = "";
    return;
  }
  const now = Date.now();
  const elapsedMs = now - startTime;
  const ratio = done / total;
  const estimatedTotalMs = elapsedMs / ratio;
  const remainingMs = estimatedTotalMs - elapsedMs;

  const remainingSec = Math.max(0, Math.round(remainingMs / 1000));
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;

  etaEl.textContent = `예상 남은 시간: ${min}분 ${sec}초 정도`;
}

async function fetchCanvasPage(url) {
  const res = await fetch(url, { credentials: "include" });
  let text = await res.text();
  text = text.replace(PREFIX_REGEX, "");
  const data = JSON.parse(text);

  const link = res.headers.get("link");
  let nextUrl = null;
  if (link) {
    const parts = link.split(",");
    for (const part of parts) {
      const section = part.split(";");
      if (section[1] && section[1].includes('rel="next"')) {
        nextUrl = section[0].trim().slice(1, -1);
      }
    }
  }
  return { data, nextUrl };
}

async function fetchAllPages(url, onPageFetched) {
  const all = [];
  let next = url;
  while (next) {
    const { data, nextUrl } = await fetchCanvasPage(next);
    if (Array.isArray(data)) {
      all.push(...data);
    } else {
      all.push(data);
    }
    next = nextUrl;
    if (onPageFetched) onPageFetched(data);
  }
  return all;
}

async function runExport() {
  exportBtn.disabled = true;
  setStatus("과목 목록 가져오는 중...");
  etaEl.textContent = "";
  progressBarEl.style.width = "0%";

  // 1) 모든 과목 가져오기 (즐겨찾기 상관 없이, 과거 포함)
  const courses = await fetchAllPages(
    `${BASE}/api/v1/users/self/courses?per_page=100&enrollment_state=all`
  );
  const totalCourses = courses.length;

  if (totalCourses === 0) {
    setStatus("과목이 없습니다.");
    exportBtn.disabled = false;
    return;
  }

  // 2) 과목별로 assignments 목록 먼저 다 모으기
  setStatus(`과목 ${totalCourses}개에서 과제 목록 수집 중...`);
  etaEl.textContent = "";
  let courseDone = 0;
  const assignmentsByCourse = {};
  const phase1Start = Date.now();

  for (const course of courses) {
    const courseId = course.id;
    const courseName = course.name;

    const assignments = await fetchAllPages(
      `${BASE}/api/v1/courses/${courseId}/assignments?per_page=100`
    );
    assignmentsByCourse[courseId] = { course, assignments };

    courseDone += 1;
    setProgress(courseDone, totalCourses, "과제 목록 수집:");
    setEta(phase1Start, courseDone, totalCourses);
  }

  // 전체 assignment 개수 계산
  let totalAssignments = 0;
  for (const courseId in assignmentsByCourse) {
    totalAssignments += assignmentsByCourse[courseId].assignments.length;
  }

  if (totalAssignments === 0) {
    setStatus("과제가 없습니다. (강의만 있는 과목일 수 있습니다)");
    etaEl.textContent = "";
    exportBtn.disabled = false;
    return;
  }

  // 3) 모든 assignment에 대해 submissions/self 가져오기 (2단계 진행바 + ETA)
  setStatus(
    `총 ${totalAssignments}개 과제에 대한 제출 정보 수집 중... (시간이 좀 걸릴 수 있습니다)`
  );
  const result = [];
  let assignmentDone = 0;
  const phase2Start = Date.now();

  for (const courseId in assignmentsByCourse) {
    const { course, assignments } = assignmentsByCourse[courseId];
    const cId = course.id;
    const cName = course.name;
    const termName = course.term ? course.term.name : null;

    for (const a of assignments) {
      let submission = null;
      try {
        const subUrl = `${BASE}/api/v1/courses/${cId}/assignments/${a.id}/submissions/self`;
        const { data: subData } = await fetchCanvasPage(subUrl);
        submission = subData;
      } catch (e) {
        console.warn("submission 가져오기 실패:", cId, a.id, e);
      }

      result.push({
        course_id: cId,
        course_name: cName,
        term_name: termName,
        course_start_at: course.start_at,
        course_end_at: course.end_at,

        assignment_id: a.id,
        assignment_name: a.name,
        assignment_description: a.description,
        due_at: a.due_at,
        unlock_at: a.unlock_at,
        lock_at: a.lock_at,
        points_possible: a.points_possible,
        submission_types: a.submission_types,
        html_url: a.html_url,
        assignment_created_at: a.created_at,
        assignment_updated_at: a.updated_at,
        assignment_group_id: a.assignment_group_id,
        grading_type: a.grading_type,
        has_submitted_submissions: a.has_submitted_submissions,

        submitted_at: submission ? submission.submitted_at : null,
        submission_type: submission ? submission.submission_type : null,
        submission_score: submission ? submission.score : null,
        submission_grade: submission ? submission.grade : null,
        submission_attempt: submission ? submission.attempt : null,
        submission_late: submission ? submission.late : null,
        submission_workflow_state: submission
          ? submission.workflow_state
          : null
      });

      assignmentDone += 1;
      setProgress(assignmentDone, totalAssignments, "제출 정보 수집:");
      setEta(phase2Start, assignmentDone, totalAssignments);
    }
  }

  // 4) JSON 다운로드
  setStatus(
    `총 ${result.length}개 레코드 수집 완료. JSON 파일을 생성하는 중입니다...`
  );
  etaEl.textContent = "";

  const blob = new Blob([JSON.stringify(result, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "canvas_all_assignments_with_submissions.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("완료! JSON 파일이 다운로드되었습니다.");
  exportBtn.disabled = false;
}

exportBtn.addEventListener("click", () => {
  runExport().catch((err) => {
    console.error(err);
    setStatus("오류가 발생했습니다. 콘솔을 확인하세요.");
    etaEl.textContent = "";
    exportBtn.disabled = false;
  });
});
