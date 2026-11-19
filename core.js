/**
 * 응급실 RN·AN 근무표 규칙 검사 + 자동 편성
 *
 * 설치: 구글 시트 > 확장 프로그램 > Apps Script > 이 코드 전체를 붙여넣고 저장 > 시트 새로고침.
 * 시트 상단에 [근무표] 메뉴가 생깁니다.
 * 설문 머리 그림(HEADER_IMAGES)은 별도 파일 images.gs에 둡니다.
 */

// ---------- 시트 구조 (RN·AN 탭 공통) ----------
const LAYOUT = {
  dateRow: 3,        // 날짜
  weekdayRow: 4,     // 요일 (일별 위반 메모를 여기에 붙임)
  kindRow: 5,        // 평일 / 휴일
  firstStaffRow: 6,
  groupCol: 1,       // A
  roleCol: 2,        // B
  nameCol: 3,        // C
  prevCol: 4,        // D~H: 전월 말 5일
  prevDays: 5,
  firstDayCol: 9,    // I~AM: 1~31일
  maxDays: 31,
  endMarker: '일별 집계',
};
const NOTE_HEADER = '비고';          // 근무표 맨 오른쪽 비고 열 제목 (원티드 세부내용이 들어감)
const RESULT_SHEET = '검사결과';
const STATUS_SHEET = '원티드현황';
const WISH_SHEET = '원티드해석';
const GUIDE_SHEET = '📌 사용법';
const LOG_SHEET = '원티드 기록';
const REJECT_SHEET = '원티드 거절 요약';
const LOAD_SHEET = '근무 부담 기록';
const LOAD_SUMMARY_SHEET = '근무 부담 요약';
const CHANGE_SHEET = '근무표 변경 기록';
const ARCHIVE_SUFFIX = ' 근무표';     // 보관 탭 이름: "2026-11 근무표"
const RESP_PREFIX = '설문응답 ';       // 설문 응답 탭 이름: "설문응답 2026-11"
const TAB_COLOR = { guide: '#f1c232', work: '#6fa8dc', log: '#93c47d', archive: '#999999' };
const SETTINGS_SHEET = '설정';
const GRID_BORDER = '#cccccc';

// ---------- 근무 코드 ----------
const DAY_CODES = ['D', 'C', '1', '1비'];
const EVE_CODES = ['E', 'E비', 'eE', 'LE'];
const REST_CODES = ['휴', '정', '청', '공', '포'];
// 순방향 순서: 낮번(1) → 얼리 초번(2) → 초번(3) → 레이트 초번(4) → 밤번(5)
const RANK = {
  'D': 1, 'C': 1, '1': 1, '1비': 1, 'TS': 1, '교': 1, '훈': 1, '정A': 1, '정P': 1,
  'eE': 2, 'E': 3, 'E비': 3, 'LE': 4, 'N': 5,
};
const RN_GROUPS = ['시니어', '중간', '막내'];

const MAX_OFF_RUN = 3;        // '휴' 연속 최대 일수 (정기휴가 등 휴가 코드는 세지 않음)
const BLOCK_MIN = 4;          // 연속 근무 최소 일수 (RN·AN)
const AFTER_BLOCK_OFF = 2;    // 근무 묶음 뒤 최소 휴무 일수
const NIGHT3_SOFT = 20;       // RN 3N(밤번 3일 연속) 자동 편성 점수: 되도록 피함 (금지는 아님)
const NIGHT_GAP = 5;          // 밤번 묶음 사이 최소 간격(일). 사이에는 D·E·휴 등 무엇이든 가능
const BLOCK_WEIGHT = 70;     // 최소 4일 연속 근무·근무 사이 2일 휴무 점수. 휴무 개수(100)가 먼저라 그보다 작게 둠

// 리퀘스트(원티드 휴무 희망일·휴가) 전날 밤번: 되도록 금지. 규칙 위반(100)보다 조금 작게 둬서 다른 규칙이 막힐 때만 허용
const REQ_LEAVE = ['정', '청', '공', '포'];
const REQ_E_WEIGHT = 25;   // 원티드·휴가 전날 초번 (지양). 전날 밤번은 금지(HARD)
const HOLI_WEIGHT = 6, HOLI_GAP = 3;   // 휴일 근무 횟수 가급적 고르게 (완전 동등 아님, 다른 규칙보다 뒤). HOLI_GAP 이상 차이면 검사에서 주의
const SOLDIER_PAIR_WEIGHT = 50;   // AN 낮번·초번에 의무병 2명 이상: 되도록 피함 (지양)

/** 리퀘스트 날 목록 (이번 달 날짜 번호 0~). 원티드 휴무 희망(코드 '휴') + 휴가 칸. */
function requestDays(p, prefs) {
  const out = {};
  (prefs || []).forEach(w => { if (w.name === p.name && w.kind !== '금지' && w.code === '휴') out[w.d] = 1; });
  p.codes.forEach((c, d) => { if (REQ_LEAVE.indexOf(c) >= 0) out[d] = 1; });
  return Object.keys(out).map(Number).sort((a, b) => a - b);
}

/** 밤번 최대 연속 일수: AN 2일, RN 3일 */
function maxNights(type) { return type === 'AN' ? 2 : 3; }

/**
 * 근무 묶음 검사. seq = 전월 말 + 이번 달 코드, P0 = 이번 달 첫날 위치.
 * 근무가 4일보다 짧게 끊기거나(short), 근무 사이 휴무가 하루뿐이면(gap) 알려 줌.
 * 휴가·파견·전입 등 휴무가 아닌 쉬는 날이 옆에 있거나, 빈 칸·달 끝에 닿은 묶음은 판단하지 않음.
 * 반환: [{ kind: 'short'|'gap', t: 표시할 위치, len }]
 */
function blockIssues(seq, P0) {
  const cls = c => (isWork(c) ? 'W' : c === '' ? '' : 'O');
  const out = [], n = seq.length;
  for (let a = 0; a < n;) {
    const k = cls(seq[a]);
    let b = a;
    while (b + 1 < n && cls(seq[b + 1]) === k) b++;
    const before = a > 0 ? seq[a - 1] : '', after = b + 1 < n ? seq[b + 1] : '';
    if (b >= P0 && a > 0 && b < n - 1 && before !== '' && after !== '') {
      const len = b - a + 1;
      if (k === 'W' && len < BLOCK_MIN && before === '휴' && after === '휴')
        out.push({ kind: 'short', t: Math.max(a, P0), len });
      if (k === 'O' && len < AFTER_BLOCK_OFF && isWork(before) && isWork(after) &&
          seq.slice(a, b + 1).every(c => c === '휴')) {
        let w = 0;
        for (let x = a - 1; x >= 0 && isWork(seq[x]); x--) w++;   // 바로 앞 근무 묶음 길이
        out.push({ kind: w >= BLOCK_MIN ? 'longGap' : 'gap', t: Math.max(a, P0), len, work: w });
      }
    }
    a = b + 1;
  }
  return out;
}

/** 이번 달에 근무할 수 있는 날이 있는지 (한 달 내내 휴가·교육 등으로 고정이면 false → 밤번·휴일 균등 비교에서 뺌). */
function isActiveMonth(codes) { return codes.some(c => c === '' || c === '휴' || isWork(c)); }

/** 휴무 개수에 드는 날: 휴, 그리고 주말·공휴일에 쓴 정기휴가(정). */
function isOffDay(code, holiday) { return code === '휴' || (code === '정' && !!holiday); }

/** 정기휴가 사용 일수 (정 1일, 정A·정P 0.5일). */
function leaveDays(codes) {
  return codes.reduce((s, c) => s + (c === '정' ? 1 : c === '정A' || c === '정P' ? 0.5 : 0), 0);
}

/** 이름 비교: 시트 이름("다군 이금희", "소령 윤은재(10)")과 짧은 이름("이금희", "윤은재") 모두 맞춤. */
function sameName(full, short) {
  full = String(full).trim(); short = String(short).trim();
  if (full === short) return true;
  full = full.replace(/\s*\([^)]*\)\s*$/, '');   // 끝의 (기수) 떼기
  return !!short && (full === short || full.slice(-short.length - 1) === ' ' + short);
}

function rankOf(code) { return RANK[code] || 0; }
function isWork(code) { return rankOf(code) > 0; }
function isRest(code) { return REST_CODES.indexOf(code) >= 0; }
function isDayShift(code) { return DAY_CODES.indexOf(code) >= 0; }
function isEveShift(code) { return EVE_CODES.indexOf(code) >= 0; }
/** 시간대: 낮번 / 초번 / 밤번 / '' */
/** 휴일에 선 근무 (D·E·N 계열 모두, 콜대기 이름 포함) */
function isHolidayWork(code) { return isDayShift(code) || isEveShift(code) || code === 'N'; }
function shiftClass(code) { return isDayShift(code) ? '낮번' : isEveShift(code) ? '초번' : code === 'N' ? '밤번' : ''; }

/**
 * 규칙 검사 본체. 시트에 의존하지 않습니다.
 * input = {
 *   type: 'RN' | 'AN',
 *   days: [{ day, holiday: bool, weekday: 0(일)~6(토) }],
 *   staff: [{ row, group, role, name, prev: [5 codes], codes: [codes per day] }],
 *   need: { rnDay:[평일,휴일], rnEve:[..], rnEveMin:[..], rnNight:[..], anDay:[..], anEve:[..], anNight:[..] },
 *   offTarget: 이번 달 휴무 기준 개수,
 * }
 * 반환: [{ level: '위반'|'주의', rule, target, day, msg, row, col }]
 *   row/col은 메모를 붙일 셀 (col은 1부터 시작하는 시트 열 번호).
 */
function checkRoster(input) {
  const out = [];
  const L = LAYOUT;
  const nDays = input.days.length;
  const add = (level, rule, target, day, msg, row, col) =>
    out.push({ level, rule, target, day, msg, row, col });

  // ---- 개인별 순서 규칙 ----
  input.staff.forEach(p => {
    const seq = p.prev.concat(p.codes);          // 전월 5일 + 이번 달
    const colOf = t => L.prevCol + t;            // seq 인덱스 → 시트 열
    const dayOf = t => (t < L.prevDays ? '전월' : (t - L.prevDays + 1) + '일');
    const inMonth = t => t >= L.prevDays;
    const isOfficer = p.role === '선임' || p.role === '차선임';
    const maxN = maxNights(input.type);

    let workRun = 0, nightRun = 0, eveRun = 0, offRun = 0, lastNightEnd = -1;
    for (let t = 0; t < seq.length; t++) {
      const c = seq[t], prev = t > 0 ? seq[t - 1] : '';

      // 휴무('휴') 연속 최대 3일 (정기휴가 등은 세지 않음)
      offRun = c === '휴' ? offRun + 1 : 0;
      if (inMonth(t) && offRun === MAX_OFF_RUN + 1)
        add('위반', '연속 휴무', p.name, dayOf(t), '휴무가 ' + offRun + '일 이상 이어집니다 (최대 ' + MAX_OFF_RUN + '일, 정기휴가는 예외).', p.row, colOf(t));

      // 초번 - 하루 휴무 - 낮번 금지
      if (inMonth(t) && isDayShift(c) && prev !== '' && !isWork(prev) && isEveShift(seq[t - 2]))
        add('위반', '초번 후 하루 휴무', p.name, dayOf(t),
          seq[t - 2] + ' - ' + prev + ' - ' + c + ': 초번 뒤 하루만 쉬고 낮번은 안 됩니다.', p.row, colOf(t));

      // 초번 3일 이상 뒤에는 2일 휴무 (밤번은 허용)
      eveRun = isEveShift(c) ? eveRun + 1 : 0;
      if (eveRun >= 3 && !isEveShift(seq[t + 1])) {
        for (let k = 1; k <= 2; k++) {
          const nx = seq[t + k];
          if (nx !== undefined && isWork(nx) && nx !== 'N' && inMonth(t + k))
            add('위반', '초번 후 휴무', p.name, dayOf(t + k),
              '초번 ' + eveRun + '일 연속 뒤에는 최소 2일 휴무가 필요합니다 (' + k + '일째에 ' + nx + ').', p.row, colOf(t + k));
        }
      }

      workRun = isWork(c) ? workRun + 1 : 0;
      if (workRun === 6 && inMonth(t))
        add('위반', '연속 근무', p.name, dayOf(t), '6일 연속 근무입니다 (최대 5일).', p.row, colOf(t));

      nightRun = c === 'N' ? nightRun + 1 : 0;
      // 밤번 묶음 사이 간격 최소 NIGHT_GAP일
      if (c === 'N' && prev !== 'N') {
        if (lastNightEnd >= 0 && inMonth(t) && t - lastNightEnd - 1 < NIGHT_GAP)
          add('위반', '밤번 간격', p.name, dayOf(t),
            '이전 밤번과 간격이 ' + (t - lastNightEnd - 1) + '일입니다 (최소 ' + NIGHT_GAP + '일).', p.row, colOf(t));
      }
      if (c === 'N') lastNightEnd = t;
      if (nightRun === maxN + 1 && inMonth(t))
        add('위반', '연속 밤번', p.name, dayOf(t), '밤번이 ' + nightRun + '일 연속입니다 (' + input.type + '은 최대 ' + maxN + '일).', p.row, colOf(t));
      if (nightRun === 3 && maxN === 3 && inMonth(t))
        add('주의', '3N', p.name, dayOf(t), '밤번 3일 연속(3N)입니다. 되도록 피합니다.', p.row, colOf(t));

      if (inMonth(t) && isWork(prev) && isWork(c) && rankOf(c) < rankOf(prev))
        add('위반', '순방향', p.name, dayOf(t), prev + ' 다음 날 ' + c + '는 역방향입니다.', p.row, colOf(t));

      if (inMonth(t) && (prev === '1비' || prev === 'E비') && isDayShift(c))
        add('주의', '콜대기 후 데이', p.name, dayOf(t), prev + ' 다음 날 낮번은 지양합니다.', p.row, colOf(t));

      // 밤번이 끝난 다음 날부터 휴무 확인
      if (c === 'N' && seq[t + 1] !== 'N') {
        const run = nightRun;
        for (let k = 1; k <= 2; k++) {
          const nx = seq[t + k];
          if (nx !== undefined && isWork(nx))
            add('위반', '밤번 후 휴무', p.name, dayOf(t + k),
              '밤번 후 최소 2일 휴무가 필요합니다 (' + k + '일째에 ' + nx + ').', p.row, colOf(t + k));
        }
        const third = seq[t + 3];
        if (run >= 3 && third !== undefined && isWork(third))
          add('위반', '3N 후 휴무', p.name, dayOf(t + 3),
            '3일 연속 밤번 뒤에는 3일 휴무가 필요합니다 (3일째에 ' + third + ').', p.row, colOf(t + 3));
      }
    }

    // 연속 근무는 최소 4일, 근무 묶음 사이 휴무는 최소 2일
    blockIssues(seq, L.prevDays).forEach(b => {
      if (b.kind === 'short')
        add('주의', '짧은 연속 근무', p.name, dayOf(b.t),
          '연속 근무가 ' + b.len + '일입니다 (최소 ' + BLOCK_MIN + '일).', p.row, colOf(b.t));
      else if (b.kind === 'longGap')
        add('위반', '연속 근무 후 휴무', p.name, dayOf(b.t),
          b.work + '일 연속 근무 뒤 휴무가 ' + b.len + '일입니다 (' + BLOCK_MIN + '일 이상 근무 뒤에는 최소 ' + AFTER_BLOCK_OFF + '일).', p.row, colOf(b.t));
      else
        add('주의', '근무 사이 휴무', p.name, dayOf(b.t),
          '근무 묶음 사이 휴무가 ' + b.len + '일입니다 (최소 ' + AFTER_BLOCK_OFF + '일).', p.row, colOf(b.t));
    });

    // 전입 전·전출/전역 후 근무
    const inIdx = p.codes.indexOf('입');
    const outIdx = Math.max(p.codes.indexOf('출'), p.codes.indexOf('역'));
    p.codes.forEach((c, d) => {
      if (!isWork(c)) return;
      if (inIdx >= 0 && d < inIdx)
        add('위반', '전입 전 근무', p.name, (d + 1) + '일', '전입일 이전에는 근무를 넣지 않습니다.', p.row, L.firstDayCol + d);
      if (outIdx >= 0 && d > outIdx)
        add('위반', '전출·전역 후 근무', p.name, (d + 1) + '일', '전출·전역 이후에는 근무를 넣지 않습니다.', p.row, L.firstDayCol + d);
    });

    // 선임·차선임은 낮번만
    p.codes.forEach((c, d) => {
      if (isOfficer && (isEveShift(c) || c === 'N'))
        add('위반', '장교 낮번 전용', p.name, (d + 1) + '일', p.role + '간호장교는 낮번만 근무합니다.', p.row, L.firstDayCol + d);
    });

    // 평일·휴일 코드 구분
    p.codes.forEach((c, d) => {
      const info = input.days[d];
      if (!info) return;
      if (!info.holiday && (c === '1' || c === '1비' || c === 'E비'))
        add('주의', '평일 코드', p.name, (d + 1) + '일', '평일에 ' + c + '가 들어 있습니다 (평일은 D·C·E).', p.row, L.firstDayCol + d);
      if (info.holiday && (c === 'D' || c === 'C'))
        add('주의', '휴일 코드', p.name, (d + 1) + '일', '휴일 낮번은 1 또는 1비로 표기합니다.', p.row, L.firstDayCol + d);
    });

    // 휴무 개수 (전입 전·전출 후 빈 칸은 세지 않음)
    const blanks = p.codes.filter((c, d) =>
      c === '' && !(inIdx >= 0 && d < inIdx) && !(outIdx >= 0 && d > outIdx)).length;
    if (blanks > 0) {
      add('주의', '빈 칸', p.name, '', '아직 비어 있는 날이 ' + blanks + '일 있습니다. 휴무 개수 검사는 건너뜁니다.', p.row, L.nameCol);
    }
    // 개인별 예외 근무 ([규칙·요구사항] 예외 표). 휴가·교육 등 근무·휴무가 아닌 칸은 건너뜀
    (input.excepts || []).filter(e => sameName(p.name, e.name)).forEach(e => {
      const c = p.codes[e.d];
      if (c && (shiftClass(c) || c === '휴') && !matchShift(c, e.allowed))
        add('위반', '개인 예외 근무', p.name, (e.d + 1) + '일',
          WEEKDAY_KO[input.days[e.d].weekday] + '요일은 ' + e.allowed.replace(/,/g, ' 또는 ') + '만 됩니다' +
          (e.memo ? ' (' + e.memo + ')' : '') + '. 지금 ' + c + '입니다.', p.row, L.firstDayCol + e.d);
    });
    // 리퀘스트(원티드 휴무 희망·휴가) 전날: 밤번 금지, 초번 지양
    requestDays(p, input.prefs).forEach(d => {
      const before = d > 0 ? p.codes[d - 1] : p.prev[p.prev.length - 1];
      if (!p.codes[d] || isWork(p.codes[d])) return;
      const where = (d > 0 ? d + '일' : '전월 말'), col = d > 0 ? L.firstDayCol + d - 1 : L.firstDayCol;
      if (before === 'N')
        add('위반', '리퀘스트 전날 밤번', p.name, where, (d + 1) + '일 리퀘스트(' + p.codes[d] + ') 전날이 밤번입니다. 금지입니다.', p.row, col);
      else if (isEveShift(before))
        add('주의', '리퀘스트 전날 초번', p.name, where, (d + 1) + '일 리퀘스트(' + p.codes[d] + ') 전날이 초번입니다. 되도록 피합니다.', p.row, col);
    });
    if (blanks === 0) {
      // 일직 횟수 ([규칙·요구사항] 일직 표)
      const duty = (input.duty || []).find(x => sameName(p.name, x.name));
      if (duty) {
        const n = p.codes.filter((c, d) => isDutyDay(c, input.days[d] && input.days[d].holiday)).length;
        const want = duty.base === duty.max ? '월 ' + duty.base + '회' : duty.base + '회 원칙, 최대 ' + duty.max + '회';
        if (n < duty.base || n > duty.max)
          add('위반', '일직 횟수', p.name, '', '일직 ' + n + '회입니다 (' + want + ').', p.row, L.nameCol);
        else if (n > duty.base)
          add('주의', '일직 횟수', p.name, '', '일직 ' + n + '회입니다 (' + want + '). 되도록 ' + duty.base + '회로 맞춰 주세요.', p.row, L.nameCol);
      }
      const target = offTargetFor(p, input);
      const offs = p.codes.filter((c, d) => isOffDay(c, input.days[d] && input.days[d].holiday)).length;
      const wkLeave = p.codes.filter((c, d) => c === '정' && input.days[d] && input.days[d].holiday).length;
      if (offs !== target)
        add('위반', '휴무 개수', p.name, '', '휴무 ' + offs + '개' + (wkLeave ? ' (주말 정기휴가 ' + wkLeave + '일 포함)' : '') +
          ', 기준 ' + target + '개입니다.', p.row, L.nameCol);
    }
  });

  // ---- 원티드 희망·금지 ([원티드해석] 탭) ----
  (input.prefs || []).forEach(w => {
    const p = input.staff.find(s => s.name === w.name);
    const c = p && p.codes[w.d];
    if (!c) return;
    const hit = matchShift(c, w.code);
    if (w.kind === '금지' ? hit : !hit)
      add('주의', '원티드 미반영', p.name, (w.d + 1) + '일',
        w.code + ' ' + w.kind + (w.rank ? ' (' + w.rank + '순위)' : '') + '인데 ' + c + '입니다.' +
        (w.boost ? ' 지금까지 원티드를 ' + w.boost + '번 이상 못 들어준 사람입니다.' : ''), p.row, L.firstDayCol + w.d);
  });

  // ---- 밤번 개수 균등 (2개 이상 차이 금지) ----
  const eligible = input.staff.filter(p =>
    p.role !== '선임' && p.role !== '차선임' && p.group !== '실습' &&
    !p.codes.some(c => ['입', '출', '역', '파'].indexOf(c) >= 0) && !noNightByException(p, input.excepts, nDays) &&
    isActiveMonth(p.codes));
  if (eligible.length > 1) {
    const nCount = p => p.codes.filter(c => c === 'N').length;
    const counts = eligible.map(nCount);
    const mn = Math.min.apply(null, counts), mx = Math.max.apply(null, counts);
    if (mx - mn >= 2) {
      eligible.forEach(p => {
        const n = nCount(p);
        if (n === mn || n === mx)
          add('위반', '밤번 균등', p.name, '', '밤번 ' + n + '개 (전체 최소 ' + mn + ', 최대 ' + mx + '). 2개 이상 차이 납니다.', p.row, L.nameCol);
      });
    }
    // ---- 휴일 근무 가급적 고르게 (D·E·N 상관없이 횟수, HOLI_GAP번 이상 차이면 주의) ----
    const hCount = p => p.codes.filter((c, d) => input.days[d] && input.days[d].holiday && isHolidayWork(c)).length;
    const groups = eligible.map(p => p.group).filter((g, k, a) => a.indexOf(g) === k);
    groups.forEach(g => {
      const mem = eligible.filter(p => p.group === g);
      if (mem.length < 2) return;
      const hc = mem.map(hCount);
      const hMn = Math.min.apply(null, hc), hMx = Math.max.apply(null, hc);
      if (hMx - hMn < HOLI_GAP) return;
      mem.forEach(p => {
        const n = hCount(p);
        if (n === hMn || n === hMx)
          add('주의', '휴일 근무 균등', p.name, '', '휴일 근무 ' + n + '번 (' + g + ' 그룹 최소 ' + hMn + ', 최대 ' + hMx + '). ' + HOLI_GAP + '번 이상 차이 납니다.', p.row, L.nameCol);
      });
    });
  }

  // ---- 일별 인원·구성 ----
  for (let d = 0; d < nDays; d++) {
    const info = input.days[d];
    const h = info.holiday ? 1 : 0;
    const dayLabel = (d + 1) + '일';
    const col = L.firstDayCol + d;
    const on = input.staff
      .filter(p => p.group !== '실습')
      .map(p => ({ p, c: p.codes[d] }));
    if (on.every(x => x.c === '')) continue;      // 아직 편성 안 한 날은 건너뜀
    const dayP = on.filter(x => isDayShift(x.c));
    const eveP = on.filter(x => isEveShift(x.c));
    const nightP = on.filter(x => x.c === 'N');
    const cnt = code => on.filter(x => x.c === code).length;
    const dayErr = (level, rule, msg) => add(level, rule, '일별', dayLabel, msg, L.weekdayRow, col);
    const missingGroups = (list, groups) => groups.filter(g => !list.some(x => x.p.group === g));

    if (input.type === 'RN') {
      const nd = input.need;
      if (!h) {
        if (dayP.length < nd.rnDay[0]) dayErr('위반', '낮번 인원', '평일 낮번 ' + dayP.length + '명 (최소 ' + nd.rnDay[0] + '명).');
        if (cnt('C') !== 1) dayErr('위반', 'C 배정', '평일 낮번 중 C는 1명이어야 합니다 (현재 ' + cnt('C') + '명).');
        if (!dayP.some(x => x.p.role === '선임' || x.p.role === '차선임'))
          dayErr('위반', '장교 포함', '평일 낮번에 선임·차선임 중 1명 이상이 있어야 합니다.');
        if (!dayP.some(x => x.p.group === '시니어' || x.p.group === '중간'))
          dayErr('위반', '낮번 구성', '평일 낮번에 시니어 또는 중간 그룹이 1명 이상 있어야 합니다.');
        if (eveP.length < nd.rnEveMin[0]) dayErr('위반', '초번 인원', '평일 초번 ' + eveP.length + '명 (최소 ' + nd.rnEveMin[0] + '명).');
        else if (eveP.length < nd.rnEve[0]) dayErr('주의', '초번 인원', '평일 초번 ' + eveP.length + '명 (원칙 ' + nd.rnEve[0] + '명).');
        else if (eveP.length > nd.rnEve[0]) dayErr('주의', '초번 인원', '평일 초번 ' + eveP.length + '명 (원칙 ' + nd.rnEve[0] + '명보다 많음).');
        if (nightP.length && !nightP.some(x => x.p.group === '시니어'))
          dayErr('위반', '밤번 시니어', '평일 밤번에 시니어(선임 그룹)가 1명 이상 있어야 합니다.');
      } else {
        if (dayP.length !== nd.rnDay[1]) dayErr('위반', '낮번 인원', '휴일 낮번 ' + dayP.length + '명 (' + nd.rnDay[1] + '명).');
        if (cnt('1비') !== 1) dayErr('위반', '1비 배정', '휴일 낮번 중 1비는 1명이어야 합니다 (현재 ' + cnt('1비') + '명).');
        if (eveP.length !== nd.rnEve[1]) dayErr('위반', '초번 인원', '휴일 초번 ' + eveP.length + '명 (' + nd.rnEve[1] + '명).');
        if (cnt('E비') !== 1) dayErr('위반', 'E비 배정', '휴일 초번 중 E비는 1명이어야 합니다 (현재 ' + cnt('E비') + '명).');
        [['낮번', dayP], ['초번', eveP], ['밤번', nightP]].forEach(([label, list]) => {
          const miss = missingGroups(list, RN_GROUPS);
          if (list.length && miss.length) dayErr('위반', '휴일 그룹 구성', '휴일 ' + label + '에 ' + miss.join('·') + ' 그룹이 없습니다.');
        });
      }
      const nNeed = nd.rnNight[h], nMin = Math.min(nNeed, (nd.rnNightMin || nd.rnNight)[h]);
      if (nightP.length < nMin) dayErr('위반', '밤번 인원', '밤번 ' + nightP.length + '명 (최소 ' + nMin + '명).');
      else if (nightP.length > nNeed) dayErr('위반', '밤번 인원', '밤번 ' + nightP.length + '명 (' + nNeed + '명보다 많음).');
      else if (nightP.length < nNeed) dayErr('주의', '밤번 인원', '밤번 ' + nightP.length + '명 (원칙 ' + nNeed + '명).');
    } else {
      const nd = input.need;
      if (dayP.length < nd.anDay[h]) dayErr('위반', '낮번 인원', '낮번 ' + dayP.length + '명 (최소 ' + nd.anDay[h] + '명).');
      if (dayP.length && !dayP.some(x => x.p.group === '주무관')) dayErr('위반', '낮번 구성', '낮번에 주무관이 1명 이상 있어야 합니다.');
      if (eveP.length !== nd.anEve[h]) dayErr('위반', '초번 인원', '초번 ' + eveP.length + '명 (' + nd.anEve[h] + '명).');
      if (eveP.length && !eveP.some(x => x.p.group === '주무관')) dayErr('위반', '초번 구성', '초번에 주무관이 1명 이상 있어야 합니다.');
      if (nightP.length !== nd.anNight[h]) dayErr('위반', '밤번 인원', '밤번 ' + nightP.length + '명 (' + nd.anNight[h] + '명).');
      if ((info.weekday === 1 || info.weekday === 3) && nightP.some(x => x.p.group !== '주무관'))
        dayErr('위반', '월·수 밤번', '월요일·수요일 밤번은 의무병을 넣지 않습니다 (주무관만).');
      [['낮번', dayP], ['초번', eveP]].forEach(([label, list]) => {
        const s = list.filter(x => x.p.group === '의무병');
        if (s.length >= 2) dayErr('주의', '의무병끼리 근무', label + '에 의무병 ' + s.length + '명(' + s.map(x => x.p.name).join('·') + ')이 함께 있습니다. 되도록 피합니다.');
      });
    }
    // 같은 시간대 근무 금지 짝 ([규칙·요구사항] 탭)
    (input.pairs || []).forEach(pr => {
      const a = input.staff.find(s => sameName(s.name, pr[0])), b = input.staff.find(s => sameName(s.name, pr[1]));
      if (!a || !b) return;
      const k = shiftClass(a.codes[d]);
      if (k && k === shiftClass(b.codes[d]))
        dayErr('위반', '같은 시간대 금지', a.name + '·' + b.name + ': 같은 ' + k + ' 근무입니다 (같은 시간대 금지 짝).');
    });
  }
  return out;
}

/** 전입·전출·전역·파견이 있으면 실제 근무 기간의 휴일 수, 없으면 이번 달 기준. */
function offTargetFor(p, input) {
  const inIdx = p.codes.indexOf('입');
  const outIdx = Math.max(p.codes.indexOf('출'), p.codes.indexOf('역'));
  if (inIdx < 0 && outIdx < 0 && p.codes.indexOf('파') < 0) return input.offTarget;
  let n = 0;
  input.days.forEach((info, d) => {
    if (info.holiday && d > inIdx && (outIdx < 0 || d < outIdx) && p.codes[d] !== '파') n++;
  });
  return n;
}

/** 그룹별 근무 분포 (RN 균등 편성 참고용). */
function groupStats(input) {
  const groups = input.type === 'RN' ? RN_GROUPS : ['주무관', '의무병'];
  return groups.map(g => {
    const ps = input.staff.filter(p => p.group === g && p.role !== '선임' && p.role !== '차선임');
    const avg = fn => ps.length ? Math.round(ps.reduce((s, p) => s + p.codes.filter(fn).length, 0) / ps.length * 10) / 10 : 0;
    return [g, ps.length, avg(isDayShift), avg(isEveShift), avg(c => c === 'N'), avg(c => c === '휴')];
  });
}

// =====================================================================
// 자동 편성
//   1) 빈 칸을 날짜순으로 대강 채운 뒤
//   2) 같은 날 두 사람 근무 바꾸기 / 한 사람의 두 날 바꾸기 / 한 칸 바꾸기를
//      수만 번 시도하며 규칙 위반 점수가 낮아지는 쪽으로 다듬습니다.
//   편성 중에는 D·E·N·휴만 쓰고, 마지막에 C·1·1비·E비로 이름을 붙입니다.
// =====================================================================

const GEN_SECONDS = { RN: 200, AN: 60 };  // 탐색 시간(초). Apps Script 1회 실행 한도는 6분.
const AUTO_COLOR = '#1155cc';  // 자동으로 채운 칸의 글자색. [자동 편성 지우기]는 이 색 칸만 지움.
const HARD = 100;              // 규칙 위반 1건 점수
const STAFF_HARD = 400;        // 근무 시간대별 최소 인원·휴일 그룹 구성 위반 1건 점수: 다른 금지 규칙보다 훨씬 먼저 지킴
const NIGHT_SENIOR = 3000;     // RN 밤번에 시니어(선임 그룹) 0명: 무조건 지킬 규칙이라 어떤 위반보다도 먼저 (2026-11 간호 요청)

function shiftNeeds(input, d) {
  const h = input.days[d].holiday ? 1 : 0, nd = input.need;
  return input.type === 'RN'
    ? { D: nd.rnDay[h], E: nd.rnEve[h], Emin: nd.rnEveMin[h], N: nd.rnNight[h],
        Nmin: Math.min(nd.rnNight[h], (nd.rnNightMin || nd.rnNight)[h]) }
    : { D: nd.anDay[h], E: nd.anEve[h], Emin: nd.anEve[h], N: nd.anNight[h], Nmin: nd.anNight[h] };
}

function buildModel(input) {
  const people = input.staff.map(p => {
    const inIdx = p.codes.indexOf('입');
    const outIdx = Math.max(p.codes.indexOf('출'), p.codes.indexOf('역'));
    const officer = p.role === '선임' || p.role === '차선임';
    const partial = p.codes.some(c => ['입', '출', '역', '파'].indexOf(c) >= 0) || !isActiveMonth(p.codes) ||
      noNightByException(p, input.excepts, input.days.length);   // 임부 등 밤번을 못 서는 사람·한 달 내내 휴가인 사람도 균등 비교에서 뺌
    return {
      src: p,
      free: p.codes.map((c, d) => c === '' && !(inIdx >= 0 && d <= inIdx) && !(outIdx >= 0 && d >= outIdx)),
      officer,
      trainee: p.group === '실습',
      fair: !officer && p.group !== '실습' && !partial,   // 밤번 2개 차이 금지 대상
      even: !officer && !partial,                         // 밤번·초번 고르게 (실습 포함)
      offTarget: offTargetFor(p, input),
      allowed: officer ? ['D', '휴'] : ['D', 'E', 'N', '휴'],
      wishes: (input.prefs || []).filter(w => w.name === p.name).map(w => ({ d: w.d, kind: w.kind, code: w.code, weight: wishWeight(w) })),
      duty: (input.duty || []).find(x => sameName(p.name, x.name)) || null,
      exc: (input.excepts || []).reduce((o, e) => { if (sameName(p.name, e.name)) o[e.d] = e.allowed; return o; }, {}),
      req: requestDays(p, input.prefs),
    };
  });
  const idx = n => input.staff.findIndex(s => sameName(s.name, n));
  const pairs = (input.pairs || []).map(pr => [idx(pr[0]), idx(pr[1])]).filter(([a, b]) => a >= 0 && b >= 0 && a !== b);
  return { input, people, pairs, nDays: input.days.length };
}

/** 한 사람의 순서·휴무 개수 점수. */
function personPenalty(m, i, cur) {
  const p = m.people[i];
  const seq = p.src.prev.concat(cur[i]);
  const P0 = LAYOUT.prevDays;
  const maxN = maxNights(m.input.type);
  let pen = 0, workRun = 0, nightRun = 0, eveRun = 0, offs = 0, offRun = 0, lastNightEnd = -1;
  for (let t = 0; t < seq.length; t++) {
    const c = seq[t], prev = t > 0 ? seq[t - 1] : '', next = seq[t + 1];
    if (c === 'N' && prev !== 'N' && lastNightEnd >= 0 && t >= P0 && t - lastNightEnd - 1 < NIGHT_GAP) pen += HARD;   // 밤번 간격
    if (c === 'N') lastNightEnd = t;
    workRun = isWork(c) ? workRun + 1 : 0;
    offRun = c === '휴' ? offRun + 1 : 0;
    if (offRun > MAX_OFF_RUN && t >= P0) pen += HARD;   // 휴무 연속 최대 3일
    nightRun = c === 'N' ? nightRun + 1 : 0;
    eveRun = isEveShift(c) ? eveRun + 1 : 0;
    if (c === 'N' && next !== 'N') {
      for (let k = 1; k <= 2; k++) if (t + k >= P0 && isWork(seq[t + k])) pen += HARD;
      const third = seq[t + 3];
      if (nightRun >= 3 && t + 3 >= P0 && isWork(third)) pen += HARD;   // 3N 뒤에는 3일 휴무
    }
    if (nightRun === 3 && maxN === 3 && t >= P0) pen += NIGHT3_SOFT;    // RN 3N은 되도록 피함
    // 초번 3일 이상 뒤에는 2일 휴무 (밤번은 허용)
    if (eveRun >= 3 && !isEveShift(next)) {
      for (let k = 1; k <= 2; k++) if (t + k >= P0 && isWork(seq[t + k]) && seq[t + k] !== 'N') pen += HARD;
    }
    if (t < P0) continue;
    if (isOffDay(c, m.input.days[t - P0] && m.input.days[t - P0].holiday)) offs++;
    if (workRun > 5) pen += HARD;
    if (nightRun > maxN) pen += HARD;
    if (isWork(prev) && isWork(c) && rankOf(c) < rankOf(prev)) pen += HARD;
    // 초번 - 하루 휴무 - 낮번 금지
    if (isDayShift(c) && prev !== '' && !isWork(prev) && isEveShift(seq[t - 2])) pen += HARD;
    // 되도록 피할 모양: 휴-근무-휴(하루짜리 근무), 근무-휴-근무(하루짜리 휴무)
    if (next !== undefined && t > P0) {
      if (isWork(c) && prev === '휴' && next === '휴') pen += 3;
      if (c === '휴' && isWork(prev) && isWork(next)) pen += 2;
    }
  }
  // 원티드 희망·금지
  p.wishes.forEach(w => {
    const hit = matchShift(cur[i][w.d], w.code);
    if (w.kind === '금지' ? hit : !hit) pen += w.weight;
  });
  // 연속 근무 최소 4일·근무 사이 휴무 2일은 지양, 4일 이상 근무 뒤 휴무 2일은 금지
  blockIssues(seq, P0).forEach(b => { pen += b.kind === 'longGap' ? HARD : BLOCK_WEIGHT; });
  pen += dutyPenalty(p.duty, cur[i].filter((c, d) => isDutyDay(c, m.input.days[d].holiday)).length);
  // 개인별 예외 근무 (적힌 근무 밖이면 규칙 위반)
  Object.keys(p.exc).forEach(d => { if (p.free[d] && !matchShift(cur[i][d], p.exc[d])) pen += HARD; });
  // 리퀘스트(원티드 휴무·휴가) 전날: 밤번 금지, 초번 지양
  p.req.forEach(d => {
    if (isWork(cur[i][d])) return;
    const b = seq[P0 + d - 1];
    if (b === 'N') pen += HARD; else if (isEveShift(b)) pen += REQ_E_WEIGHT;
  });
  return pen + HARD * Math.abs(offs - p.offTarget);
}

/** 일직 횟수 점수: 원칙보다 적거나 최대보다 많으면 규칙 위반, 원칙~최대 사이면 지양 점수. */
function dutyPenalty(duty, n) {
  if (!duty) return 0;
  if (n < duty.base) return HARD * (duty.base - n);
  if (n > duty.max) return HARD * (n - duty.max) + DUTY_SOFT * (duty.max - duty.base);
  return DUTY_SOFT * (n - duty.base);
}

/** 하루의 인원·구성 점수. */
function dayPenalty(m, d, cur) {
  const info = m.input.days[d], need = shiftNeeds(m.input, d);
  let D = 0, E = 0, N = 0, officerD = false, seniorD = false;
  let dJ = false, eJ = false, nNonJ = false;                 // AN: 주무관 포함 여부
  let dS = 0, eS = 0;                                        // AN: 낮번·초번 의무병 수
  const gD = {}, gE = {}, gN = {};
  m.people.forEach((p, i) => {
    if (p.trainee) return;
    const c = cur[i][d], g = p.src.group;
    if (isDayShift(c)) {
      D++; gD[g] = 1;
      if (p.officer) officerD = true;
      if (g === '시니어' || g === '중간') seniorD = true;
      if (g === '주무관') dJ = true;
      if (g === '의무병') dS++;
    } else if (isEveShift(c)) {
      E++; gE[g] = 1;
      if (g === '주무관') eJ = true;
      if (g === '의무병') eS++;
    } else if (c === 'N') {
      N++; gN[g] = 1;
      if (g !== '주무관') nNonJ = true;
    }
  });
  // 밤번: 최소 허용보다 적거나 기준보다 많으면 위반, 그 사이(최소~기준)면 작은 점수
  // 근무 시간대별 최소 인원·휴일 그룹 구성은 다른 금지 규칙보다 먼저 (STAFF_HARD)
  let pen = STAFF_HARD * Math.max(0, need.Nmin - N) + HARD * Math.max(0, N - need.N) +
    10 * Math.max(0, need.N - Math.max(N, need.Nmin));
  if (m.input.type === 'RN') {
    if (!info.holiday) {
      pen += STAFF_HARD * Math.max(0, need.D - D);
      if (!officerD) pen += HARD;
      if (!seniorD) pen += HARD;
      if (E < need.Emin) pen += STAFF_HARD * (need.Emin - E) + 10;
      else pen += 10 * Math.abs(E - need.E);
      if (!gN['시니어']) pen += NIGHT_SENIOR;   // 평일 밤번에도 시니어(선임 그룹) 1명 이상
    } else {
      pen += STAFF_HARD * (Math.max(0, need.D - D) + Math.max(0, need.E - E)) +
        HARD * (Math.max(0, D - need.D) + Math.max(0, E - need.E));
      [gD, gE, gN].forEach(g => RN_GROUPS.forEach(name => { if (!g[name]) pen += STAFF_HARD; }));
      if (!gN['시니어']) pen += NIGHT_SENIOR - STAFF_HARD;   // 휴일 밤번 시니어도 무조건 (위 STAFF_HARD와 합쳐 NIGHT_SENIOR)
      // 휴일 1비·E비: 이미 고정된 1비/E비가 없으면, 이름을 붙일 수 있는(자동 편성 칸) 낮번·초번이 1명 이상 있어야 함
      const canLabel = (fixed, test) => m.people.some((p, i) =>
        (!p.free[d] && cur[i][d] === fixed) || (p.free[d] && !p.trainee && test(cur[i][d])));
      if (!canLabel('1비', isDayShift)) pen += HARD;
      if (!canLabel('E비', isEveShift)) pen += HARD;
    }
  } else {
    pen += STAFF_HARD * Math.max(0, need.D - D) + STAFF_HARD * Math.max(0, need.E - E) + HARD * Math.max(0, E - need.E);
    if (!dJ) pen += HARD;
    if (!eJ) pen += HARD;
    if ((info.weekday === 1 || info.weekday === 3) && nNonJ) pen += HARD;
    pen += SOLDIER_PAIR_WEIGHT * (Math.max(0, dS - 1) + Math.max(0, eS - 1));   // 의무병 2명 이상 같은 근무 지양
  }
  m.pairs.forEach(([a, b]) => {
    const k = shiftClass(cur[a][d]);
    if (k && k === shiftClass(cur[b][d])) pen += HARD;
  });
  return pen;
}

/** 밤번 2개 이상 차이 금지 + 밤번·초번 개수 고르게. */
function globalPenalty(m, nC, eC, hC) {
  let pen = 0, mn = Infinity, mx = -Infinity, fc = 0, fs = 0, cnt = 0, sN = 0, sE = 0;
  const hS = {}, hN = {};
  m.people.forEach((p, i) => {
    if (p.fair) { mn = Math.min(mn, nC[i]); mx = Math.max(mx, nC[i]); fc++; fs += nC[i]; }
    if (p.fair && hC) { const g = p.src.group; hS[g] = (hS[g] || 0) + hC[i]; hN[g] = (hN[g] || 0) + 1; }
    if (p.even) { cnt++; sN += nC[i]; sE += eC[i]; }
  });
  if (mx > mn) pen += HARD * Math.max(0, mx - mn - 1);
  // 휴일 근무(D·E·N 상관없이) 횟수 가급적 고르게 (같은 그룹 안에서): 그룹 평균에서 벗어난 만큼 작은 점수
  if (hC) m.people.forEach((p, i) => {
    if (!p.fair || hN[p.src.group] < 2) return;
    const dv = hC[i] - hS[p.src.group] / hN[p.src.group];
    pen += HOLI_WEIGHT * dv * dv;
  });
  // 평균에서 많이 벗어난 사람마다 점수를 더해, 한 명씩 고쳐 갈 때도 점수가 줄어들게 함
  if (fc) {
    const fa = fs / fc;
    m.people.forEach((p, i) => { if (p.fair) pen += HARD / 2 * Math.max(0, Math.abs(nC[i] - fa) - 0.5); });
  }
  if (cnt < 2) return pen;
  const aN = sN / cnt, aE = sE / cnt;
  m.people.forEach((p, i) => {
    if (p.even) pen += 4 * (nC[i] - aN) * (nC[i] - aN) + (eC[i] - aE) * (eC[i] - aE);
  });
  return pen;
}

/** 빈 칸을 날짜순으로 대강 채움. 인원 수와 휴무 개수를 먼저 맞춤. */
function initialFill(m, cur) {
  const P0 = LAYOUT.prevDays;
  const offsLeft = m.people.map((p, i) => p.offTarget - cur[i].filter((c, d) => isOffDay(c, m.input.days[d].holiday)).length);
  const freeLeft = m.people.map(p => p.free.filter(Boolean).length);
  const nCount = m.people.map(() => 0);
  const hCnt = m.people.map(() => 0);   // 지금까지 휴일 근무 수 (적은 사람을 휴일에 먼저 넣음)
  const prevCode = (i, d, k) => (d - k >= 0 ? cur[i][d - k] : m.people[i].src.prev[P0 + d - k]);
  const nightRun = (i, d) => { let r = 0; while (r < 3 && prevCode(i, d, r + 1) === 'N') r++; return r; };
  const jitter = () => Math.random() * 0.5;

  for (let d = 0; d < m.nDays; d++) {
    const need = shiftNeeds(m.input, d);
    const isHol = !!m.input.days[d].holiday;
    const hb = i => (isHol ? -1.5 * hCnt[i] : 0);
    const have = { D: 0, E: 0, N: 0 };
    const todo = [];
    m.people.forEach((p, i) => {
      if (p.free[d]) { todo.push(i); return; }
      if (p.trainee) return;
      const c = cur[i][d];
      if (isDayShift(c)) have.D++; else if (isEveShift(c)) have.E++; else if (c === 'N') have.N++;
    });
    const set = (i, c) => {
      cur[i][d] = c; freeLeft[i]--;
      if (c === '휴') offsLeft[i]--;
      if (isHol && isHolidayWork(c)) hCnt[i]++;
      if (c === 'N') nCount[i]++;
      todo.splice(todo.indexOf(i), 1);
    };
    // 밤번 3일을 채웠거나 밤번 뒤 이틀째면 휴무
    todo.slice().forEach(i => {
      const y = prevCode(i, d, 1), y2 = prevCode(i, d, 2);
      const after3N = y !== 'N' && y2 !== 'N' && [3, 4, 5].every(k => prevCode(i, d, k) === 'N');
      if ((y === 'N' && nightRun(i, d) >= maxNights(m.input.type)) || (y !== 'N' && y2 === 'N') || after3N ||
          m.people[i].exc[d] === '휴') set(i, '휴');
    });
    const excOk = (i, shift) => { const a = m.people[i].exc[d]; return !a || matchShift(shift, a); };
    const workNeed = i => (freeLeft[i] - offsLeft[i]) / Math.max(1, freeLeft[i]);
    const pick = (shift, count, ok, score) => {
      const cand = todo.filter(i => !m.people[i].trainee && ok(i));
      cand.sort((a, b) => score(b) - score(a));
      cand.slice(0, Math.max(0, count)).forEach(i => set(i, shift));
    };
    // RN: 그날 밤번에 시니어가 없으면 시니어 1명을 먼저 넣음 (가장 먼저 지킬 규칙)
    if (m.input.type === 'RN' && need.N - have.N > 0 &&
        !m.people.some((p, i) => !p.free[d] && !p.trainee && p.src.group === '시니어' && cur[i][d] === 'N')) {
      const before = todo.length;
      pick('N', 1, i => m.people[i].src.group === '시니어' && !m.people[i].officer && excOk(i, 'N') && m.people[i].req.indexOf(d + 1) < 0,
        i => (prevCode(i, d, 1) === 'N' ? 10 : 0) - nCount[i] + jitter());
      if (todo.length < before) have.N++;
    }
    // 밤번은 어제 밤번이던 사람이 이어서 서는 쪽을 먼저 (2~3일 묶음)
    pick('N', need.N - have.N, i => !m.people[i].officer && excOk(i, 'N') && m.people[i].req.indexOf(d + 1) < 0,
      i => (prevCode(i, d, 1) === 'N' ? 10 : 0) - nCount[i] + (m.people[i].exc[d] ? 5 : 0) + hb(i) + jitter());
    pick('E', need.E - have.E, i => !m.people[i].officer && excOk(i, 'E') && rankOf(prevCode(i, d, 1)) <= 3,
      i => workNeed(i) + (m.people[i].exc[d] ? 5 : 0) + hb(i) - (m.people[i].req.indexOf(d + 1) >= 0 ? 3 : 0) + jitter());
    pick('D', need.D - have.D, i => excOk(i, 'D') && rankOf(prevCode(i, d, 1)) <= 1 &&
      !(isEveShift(prevCode(i, d, 2)) && !isWork(prevCode(i, d, 1))),
      i => workNeed(i) + (m.people[i].officer ? 1 : 0) + hb(i) + jitter());
    todo.slice().forEach(i => {
      const y = prevCode(i, d, 1);
      const offRun3 = [1, 2, 3].every(k => prevCode(i, d, k) === '휴');   // 휴무 연속 최대 3일
      const mustRest = y === 'N' || (offsLeft[i] >= freeLeft[i] && !offRun3);
      const mustWork = offsLeft[i] <= 0 || offRun3;
      const ex = m.people[i].exc[d];
      if (ex) {   // 개인별 예외 칸: 적힌 근무 중에서만 고름
        const opts = ['휴', 'N', 'E', 'D'].filter(c => matchShift(c, ex));
        const work = opts.filter(c => c !== '휴' && rankOf(c) >= rankOf(y));
        set(i, (mustRest || !work.length) && opts.indexOf('휴') >= 0 ? '휴' : (work[0] || opts[0]));
      } else if (mustRest || (!mustWork && Math.random() < offsLeft[i] / freeLeft[i])) set(i, '휴');
      else set(i, rankOf(y) > 1 && !m.people[i].officer ? 'E' : 'D');
    });
  }
}

/** 점수를 낮추는 방향으로 근무를 바꿔 가며 다듬음. */
function improve(m, cur, seconds) {
  const np = m.people.length, nd = m.nDays;
  const pp = [], dp = [];
  for (let i = 0; i < np; i++) pp[i] = personPenalty(m, i, cur);
  for (let d = 0; d < nd; d++) dp[d] = dayPenalty(m, d, cur);
  const countOf = (i, c) => cur[i].filter(x => x === c).length;
  const nC = cur.map((_, i) => countOf(i, 'N'));
  const eC = cur.map((_, i) => countOf(i, 'E'));
  const hol = m.input.days.map(x => !!x.holiday);
  const hC = cur.map(r => r.filter((c, d) => hol[d] && isHolidayWork(c)).length);
  let g = globalPenalty(m, nC, eC, hC);
  let total = pp.reduce((a, b) => a + b, 0) + dp.reduce((a, b) => a + b, 0) + g;
  let best = total, bestCur = cur.map(r => r.slice());

  const byDay = [], byPerson = [], cells = [];
  for (let d = 0; d < nd; d++) byDay[d] = [];
  for (let i = 0; i < np; i++) {
    byPerson[i] = [];
    for (let d = 0; d < nd; d++) if (m.people[i].free[d]) { byDay[d].push(i); byPerson[i].push(d); cells.push([i, d]); }
  }
  if (!cells.length) return { cur, penalty: total, iterations: 0 };
  const swappable = byPerson.map((l, i) => i).filter(i => byPerson[i].length >= 2);
  const rnd = n => Math.floor(Math.random() * n);
  // 개인별 예외(대학원·임부 등) 칸은 적힌 근무 밖으로는 아예 바꾸지 않음
  const allowedAt = (i, d, c) => m.people[i].allowed.indexOf(c) >= 0 && (!m.people[i].exc[d] || matchShift(c, m.people[i].exc[d]));
  // RN 시니어(선임 그룹): 밤번에 시니어가 빠진 날을 골라 고치는 맞바꾸기에 씀
  const nsIdx = m.input.type === 'RN' ? m.people.map((p, i) => i).filter(i => !m.people[i].trainee && m.people[i].src.group === '시니어') : [];

  const start = Date.now(), end = start + seconds * 1000;
  const T0 = 40, T1 = 0.5;
  let T = T0, it = 0;
  for (;;) {
    if ((it & 511) === 0) {
      const now = Date.now();
      if (now >= end || best === 0) break;
      T = T0 * Math.pow(T1 / T0, (now - start) / (end - start));
    }
    it++;
    let ch = null;
    if (nsIdx.length && Math.random() < 0.06) {
      // 밤번 시니어가 없는 날: 그날 밤번인 비시니어와 시니어의 1~5일을 맞바꿈 (밤번 묶음째로 옮기기)
      const miss = [];
      for (let d = 0; d < nd; d++) if (!nsIdx.some(i => cur[i][d] === 'N')) miss.push(d);
      if (miss.length) {
        const d = miss[rnd(miss.length)];
        const js = byDay[d].filter(j => cur[j][d] === 'N' && m.people[j].src.group !== '시니어');
        const is = nsIdx.filter(i => m.people[i].free[d] && allowedAt(i, d, 'N'));
        if (js.length && is.length) {
          const i = is[rnd(is.length)], j = js[rnd(js.length)], len = 1 + rnd(5);
          const d0 = Math.max(0, Math.min(nd - len, d - rnd(len)));
          let ok = true;
          ch = [];
          for (let x = d0; x < d0 + len && ok; x++) {
            const a = cur[i][x], b = cur[j][x];
            if (a === b) continue;
            if (!m.people[i].free[x] || !m.people[j].free[x] || !allowedAt(i, x, b) || !allowedAt(j, x, a)) ok = false;
            else ch.push([i, x, b], [j, x, a]);
          }
          if (!ok || !ch.length) ch = null;
        }
      }
    }
    if (!ch) {
    const r = Math.random();
    if (r < 0.25) {
      // 두 사람의 연속된 2~5일을 통째로 맞바꿈 (밤번 묶음+휴무를 옮길 때 필요)
      const i = rnd(np), j = rnd(np), len = 2 + rnd(4), d0 = rnd(nd - len + 1);
      if (i === j) continue;
      ch = [];
      let ok = true, same = true;
      for (let d = d0; d < d0 + len && ok; d++) {
        const a = cur[i][d], b = cur[j][d];
        if (!m.people[i].free[d] || !m.people[j].free[d] || !allowedAt(i, d, b) || !allowedAt(j, d, a)) ok = false;
        if (a !== b) { same = false; ch.push([i, d, b], [j, d, a]); }
      }
      if (!ok || same) continue;
    } else if (r < 0.55) {
      const d = rnd(nd), l = byDay[d];
      if (l.length < 2) continue;
      const i = l[rnd(l.length)], j = l[rnd(l.length)];
      const a = cur[i][d], b = cur[j][d];
      if (i === j || a === b || !allowedAt(i, d, b) || !allowedAt(j, d, a)) continue;
      ch = [[i, d, b], [j, d, a]];
    } else if (r < 0.85) {
      if (!swappable.length) continue;
      const i = swappable[rnd(swappable.length)], l = byPerson[i];
      const d1 = l[rnd(l.length)], d2 = l[rnd(l.length)];
      const a = cur[i][d1], b = cur[i][d2];
      if (a === b || !allowedAt(i, d1, b) || !allowedAt(i, d2, a)) continue;
      ch = [[i, d1, b], [i, d2, a]];
    } else {
      const [i, d] = cells[rnd(cells.length)];
      const opts = m.people[i].allowed.filter(c => c !== cur[i][d] && allowedAt(i, d, c));
      if (!opts.length) continue;
      ch = [[i, d, opts[rnd(opts.length)]]];
    }
    }

    const ps = [], ds = [], old = [];
    ch.forEach(([i, d]) => { if (ps.indexOf(i) < 0) ps.push(i); if (ds.indexOf(d) < 0) ds.push(d); });
    const oldN = ps.map(i => nC[i]), oldE = ps.map(i => eC[i]), oldH = ps.map(i => hC[i]);
    ch.forEach(([i, d, c]) => {
      const o = cur[i][d];
      old.push([i, d, o]);
      cur[i][d] = c;
      nC[i] += (c === 'N') - (o === 'N');
      eC[i] += (c === 'E') - (o === 'E');
      if (hol[d]) hC[i] += isHolidayWork(c) - isHolidayWork(o);
    });
    const newPP = ps.map(i => personPenalty(m, i, cur));
    const newDP = ds.map(d => dayPenalty(m, d, cur));
    const newG = globalPenalty(m, nC, eC, hC);
    let delta = newG - g;
    ps.forEach((i, k) => { delta += newPP[k] - pp[i]; });
    ds.forEach((d, k) => { delta += newDP[k] - dp[d]; });

    if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
      ps.forEach((i, k) => { pp[i] = newPP[k]; });
      ds.forEach((d, k) => { dp[d] = newDP[k]; });
      g = newG;
      total += delta;
      if (total < best) { best = total; bestCur = cur.map(row => row.slice()); }
    } else {
      old.reverse().forEach(([i, d, c]) => { cur[i][d] = c; });
      ps.forEach((i, k) => { nC[i] = oldN[k]; eC[i] = oldE[k]; hC[i] = oldH[k]; });
    }
  }
  return { cur: bestCur, penalty: best, iterations: it };
}

/** 편성 후 C·1·1비·E비 이름 붙이기. 콜대기는 사람마다 고르게, 실습·장교는 되도록 제외. */
function labelShifts(m, cur) {
  const callCount = m.people.map(() => 0);
  const choose = (list, d, avoidNextDay) => {
    if (!list.length) return -1;
    const score = i => callCount[i] * 10 + (m.people[i].officer ? 50 : 0) + (m.people[i].exc[d] ? 100 : 0) +   // 임부 등 예외자는 콜대기 제외
      (avoidNextDay && d + 1 < m.nDays && isDayShift(cur[i][d + 1]) ? 20 : 0) + Math.random();
    return list.slice().sort((a, b) => score(a) - score(b))[0];
  };
  for (let d = 0; d < m.nDays; d++) {
    const holiday = m.input.days[d].holiday;
    const fixedHas = code => m.people.some((p, i) => !p.free[d] && cur[i][d] === code);
    const gen = code => m.people.map((p, i) => i).filter(i => m.people[i].free[d] && !m.people[i].trainee && cur[i][d] === code);
    if (!holiday) {
      if (m.input.type === 'RN' && !fixedHas('C')) {
        const i = choose(gen('D'), d, false);
        if (i >= 0) { cur[i][d] = 'C'; callCount[i]++; }
      }
    } else {
      m.people.forEach((p, i) => { if (p.free[d] && cur[i][d] === 'D') cur[i][d] = '1'; });
      if (m.input.type === 'RN') {
        if (!fixedHas('1비')) {
          let list = gen('1');
          if (!list.length)   // 주말 1비는 반드시: 일반 후보가 없으면 실습 낮번도 후보로
            list = m.people.map((p, i) => i).filter(i => m.people[i].free[d] && cur[i][d] === '1');
          const i = choose(list, d, true);
          if (i >= 0) { cur[i][d] = '1비'; callCount[i]++; }
        }
        if (!fixedHas('E비')) {
          const i = choose(gen('E'), d, true);
          if (i >= 0) { cur[i][d] = 'E비'; callCount[i]++; }
        }
      }
    }
  }
}

// =====================================================================
// 원티드
//   설문 (한 페이지): 이름 → 1·2·3순위마다 [시작 날짜 · 끝 날짜 · 신청 · 메모] → 자유 글.
//   끝 날짜를 비우면 하루 신청. 기간 신청은 날짜마다 나눠서 표·근무표에 넣음.
//   제출할 때마다 [원티드현황] 탭과 공유용 현황 파일이 다시 그려집니다.
//   [③ 원티드 날짜 반영]을 누르면
//     · 1·2순위와, 순위와 상관없이 휴가·교육·인사는 근무표 칸에 고정 (겹치는 근무·휴무 신청은 우선순위대로 조정)
//     · 근무·휴무 3순위는 [원티드해석]에 희망(순위 3)으로 들어가 자동 편성이 지켜 주려고 함
//     · 순위별 세부내용과 맨 아래 자유 글은 근무표 맨 오른쪽 [비고] 열에 표시
// =====================================================================

// 설문 [신청] 목록에 보이는 이름 → 근무표 코드 (간호 대표가 정한 목록, 이 순서대로 나옴)
// 콜대기(C·1비·E비), 얼리·레이트 초번(eE·LE)은 설문에 없음: 원티드를 모은 뒤 관리자가 정함
const WANT_OLD_LABELS = [   // 잠깐 쓴 설문 이름. 이 이름으로 낸 응답도 읽을 수 있게 둠.
  ['쉬는 날 (휴무)', '휴'], ['낮번 (D)', 'D'], ['초번 (E)', 'E'], ['밤번 (N)', 'N'],
  ['오전 반휴', '정A'], ['오후 반휴', '정P'],
];
const WANT_ITEMS = [
  ['D', 'D'], ['E', 'E'], ['N', 'N'], ['1', '1'], ['TS', 'TS'],
  ['휴무', '휴'], ['정기휴가', '정'], ['청원휴가', '청'], ['공가', '공'], ['포상휴가', '포'],
  ['오전반휴', '정A'], ['오후반휴', '정P'], ['교육', '교'], ['훈련', '훈'],
  ['파견', '파'], ['전입', '입'], ['전역', '역'], ['전출', '출'],
];
const CONFLICT_MARK = '⚠';   // 신청이 넘쳐 조정이 필요한 칸 표시
const WANT_SHIFT = ['D', 'E', 'N', '1'];      // 근무 희망: 겹치면 조정 대상
const WANT_OFF = ['휴'];                      // 휴무 희망: 겹치면 조정 대상
const WANT_ONE_DAY = ['입', '역', '출'];      // 하루만 넣는 코드 (끝 날짜를 골라도 시작 날짜만)
const WANT_RANKS = 3;                         // 설문 순위 수: 순위마다 날짜 · 원티드 · 세부내용

const WANT_CHOICES = ['휴', '휴가', 'D', 'E', 'N'];                        // 예전 설문 날짜표 (예전 응답을 읽을 때만 씀)
const WANT_CODE = { '휴': '휴', '휴가': '정', 'D': 'D', 'E': 'E', 'N': 'N' };
const WANT_MAX_DAYS = 4;
const WISH_WEIGHT = { 희망1: 80, 희망2: 30, 희망3: 15, 희망: 30, 금지: 60 };   // 규칙 위반(100)보다 작게. 1순위는 연속 근무 최소·사이 휴무(70)보다 먼저
const WISH_BOOST = 10;          // 지금까지 원티드를 못 들어준 횟수 1번마다 더하는 점수 (최대 BOOST_MAX번)
const BOOST_MAX = 3;
const RANK_GRIDS = 2;           // 예전 설문의 날짜표 수 (1·2순위)
const COND_COUNT = 3;           // 예전 설문의 조건 칸 수 (예전 응답을 읽을 때만 씀)
const COND_KINDS = { '희망 (이 근무였으면)': '희망', '금지 (이 근무는 빼 주세요)': '금지' };
const COND_CODES = ['D', 'E', 'N', '휴'];

function wantCodeOf(label) {
  const t = String(label).trim();
  const it = WANT_ITEMS.concat(WANT_OLD_LABELS).find(x => x[0] === t);
  return it ? it[1] : '';
}

function wantLabelOf(code) {
  const it = WANT_ITEMS.find(x => x[1] === code);
  return it ? it[0] : code;
}

/** 근무·휴무 신청이면 true (겹치면 조정함). 휴가·교육·인사는 false (그대로 넣음). */
function isAdjustable(code) { return WANT_SHIFT.indexOf(code) >= 0 || WANT_OFF.indexOf(code) >= 0; }

/** 근무 신청의 종류: 낮번 'D', 초번 'E', 밤번 'N', 근무 신청이 아니면 '' */
function shiftLab(code) {
  if (code === 'N') return 'N';
  if (isEveShift(code)) return 'E';
  if (isDayShift(code)) return 'D';
  return '';
}

/** 근무표 칸에 고정하는 신청인지. 휴가·일정·인사는 순위와 상관없이, 근무·휴무는 1·2순위만. */
function isPinned(code, rank) { return !isAdjustable(code) || rank === 1 || rank === 2; }

/** 평일·휴일에 맞는 코드: 휴일의 D는 1, 평일의 1은 D. */
function codeForDay(code, holiday) {
  if (code === 'D' && holiday) return '1';
  if (code === '1' && !holiday) return 'D';
  return code;
}

/** 신청 1건을 글로: "3~5일 교육: 방사선 비상진료 교육" */
function entryText(e) {
  return (e.from === e.to ? (e.from + 1) : (e.from + 1) + '~' + (e.to + 1)) + '일 ' + wantLabelOf(e.code) +
    (e.note ? ': ' + e.note : '');
}

/** 근무 코드가 원티드 코드(D/E/N/휴, 또는 "D,휴"처럼 여러 개)와 같은 종류인지. */
function matchShift(c, code) {
  if (code.indexOf(',') >= 0) return code.split(',').some(x => matchShift(c, x.trim()));
  if (code === 'D') return isDayShift(c);
  if (code === 'E') return isEveShift(c);
  return c === code;
}

function wishWeight(w) {
  const base = w.kind === '금지' ? WISH_WEIGHT.금지 : (WISH_WEIGHT['희망' + (w.rank || '')] || WISH_WEIGHT.희망);
  return base + Math.min(BOOST_MAX, Number(w.boost) || 0) * WISH_BOOST;
}

// 순위별 색. 현황표는 칸 배경, 근무표(RN·AN)는 글자색 (근무표 배경은 근무 종류 색이라서).
const RANK_BG = ['#fff2cc', '#f6b26b', '#9fc5e8', '#b6d7a8'];          // [순위 없음, 1순위 주황, 2순위 파랑, 3순위 초록]
const RANK_FONT = ['#000000', '#cc0000', '#0b5394', '#38761d'];        // [직접 입력 검정, 1순위 빨강, 2순위 진한 파랑, 3순위 초록]
const RANK_LABEL = ['', '1순위', '2순위', '3순위 (근무·휴무는 되도록 반영, 휴가·교육·인사는 순위와 상관없이 고정)'];

/** 근무표 칸 글자색 → 원티드 순위 (1~3), 아니면 0 */
function rankOfFont(color) {
  const c = String(color).toLowerCase();
  return RANK_FONT.indexOf(c) > 0 ? RANK_FONT.indexOf(c) : 0;
}

/**
 * 같은 날 신청이 몰려 다 들어줄 수 없을 때 누구 것을 뺄지 정함. 시트에 의존하지 않습니다.
 * 우선순위: ① 신청 순위(1순위 먼저) ② 지금까지 원티드를 못 받은 횟수가 많은 사람 ③ 설문을 먼저 낸 사람.
 * 빼는 것은 근무 신청(D·E·N·1)과 휴무(휴)뿐입니다. 휴가·교육·인사는 빼지 않고, 그날 근무할 수 없는 사람으로 셉니다.
 * 근무표 칸에 이미 적힌 것(교육·휴가 등)이 신청보다 먼저입니다. 근무·휴무 3순위는 고정하지 않으므로 여기서 다루지 않습니다.
 * wants = { 이름: { codes, ranks, time } }, history = { 이름: 못 받은 횟수 }
 * 반환: [{ name, d, code, rank, hist, reason }]  (뺀 신청)
 */
function resolveConflicts(input, wants, history) {
  history = history || {};
  const cuts = [];
  const crew = input.staff.filter(p => p.group !== '실습');
  const officer = p => p.role === '선임' || p.role === '차선임';
  const hist = p => history[p.name] || 0;
  const prio = (a, b) => (a.rank || 9) - (b.rank || 9) || hist(b.p) - hist(a.p) || a.time - b.time;
  const SHIFTS = [['D', isDayShift], ['E', isEveShift], ['N', c => c === 'N']];
  input.days.forEach((_, d) => {
    const need = shiftNeeds(input, d);
    let reqs = [];
    crew.forEach(p => {
      const w = wants[p.name];
      const c = w && w.codes[d];
      const rank = (w && w.ranks && w.ranks[d]) || 0;
      if (c && !p.codes[d] && isPinned(c, rank)) reqs.push({ p, code: c, lab: shiftLab(c), rank, time: w.time || 0 });
    });
    const cut = (r, why) => {
      cuts.push({ name: r.p.name, d, code: r.code, rank: r.rank, hist: hist(r.p),
        reason: why + ' → ' + (r.rank || '-') + '순위, 못 받은 횟수 ' + hist(r.p) + '번이라 우선순위가 가장 낮음' });
      reqs = reqs.filter(x => x !== r);
    };
    // 1) 근무 신청이 필요 인원보다 많으면 우선순위 낮은 신청부터 뺌
    SHIFTS.forEach(([lab, fn]) => {
      const fixed = crew.filter(p => fn(p.codes[d])).length;
      const rs = reqs.filter(r => isAdjustable(r.code) && r.lab === lab).sort(prio);
      rs.slice(Math.max(0, need[lab] - fixed)).forEach(r => cut(r, d + 1 + '일 ' + wantLabelOf(r.code) + ' 신청이 필요 인원(' + need[lab] + '명)보다 많음'));
    });
    // 2) 쉬는 신청(휴무·휴가·교육 등) 때문에 근무 설 사람이 모자라면, 우선순위 낮은 "휴" 신청부터 뺌
    const shortage = () => {
      const reqOf = p => reqs.find(x => x.p === p);
      // 근무할 수 있는 사람: 근무표 칸이 비었거나 근무가 적혀 있고, 근무 아닌 신청(휴무·휴가·교육 등)이 없는 사람
      const pool = crew.filter(p => (p.codes[d] === '' || isWork(p.codes[d])) && (!reqOf(p) || reqOf(p).lab));
      const can = (p, lab, fn) => (p.codes[d] ? fn(p.codes[d]) : (!reqOf(p) || reqOf(p).lab === lab)) && (lab === 'D' || !officer(p));
      if (pool.length < need.D + need.E + need.N) return { lab: 'D', msg: d + 1 + '일 쉬는 신청이 많아 근무 인원(' + (need.D + need.E + need.N) + '명)을 못 채움' };
      for (let k = SHIFTS.length - 1; k >= 0; k--) {
        const [lab, fn] = SHIFTS[k];
        if (pool.filter(p => can(p, lab, fn)).length < need[lab]) return { lab, msg: d + 1 + '일 ' + lab + ' 설 사람이 모자람' };
      }
      const late = pool.filter(p => can(p, 'E', isEveShift) || can(p, 'N', c => c === 'N')).length;
      if (late < need.E + need.N) return { lab: 'E', msg: d + 1 + '일 초번·밤번 설 사람이 모자람' };
      return null;
    };
    for (let s = shortage(); s; s = shortage()) {
      const cands = reqs.filter(r => r.code === '휴' && (s.lab === 'D' || !officer(r.p))).sort(prio);
      if (!cands.length) break;
      cut(cands[cands.length - 1], s.msg);
    }
  });
  return cuts;
}

/**
 * [원티드 거절 요약] 표. 시트에 의존하지 않습니다.
 * logRows = [원티드 기록] 줄들 (월, 구분, 이름, 날짜, 종류, 신청, 실제, 반영, 메모, 순위, 거절 사유)
 */
function buildRejectSummary(logRows) {
  const by = {};
  logRows.forEach(r => {
    const name = String(r[2]).trim(), ok = String(r[7]).trim();
    if (!name || (ok !== 'O' && ok !== 'X')) return;
    const s = by[name] = by[name] || { name, type: r[1], total: 0, x: 0, r1: 0, r2: 0, r3: 0, list: [] };
    s.total++;
    if (ok !== 'X') return;
    s.x++;
    const rank = parseInt(r[9], 10) || parseInt(String(r[5]).replace(/.*\((\d)순위\).*/, '$1'), 10) || 0;
    if (rank >= 1 && rank <= 3) s['r' + rank]++;
    const month = String(r[0]).replace(/^'/, '');
    s.list.push({ month, text: month.slice(2).replace('-', '/') + '/' + r[3] + ' ' + String(r[5]).replace(/ \(\d순위\)/, '') +
      (r[4] === '금지' ? ' 금지' : '') + (rank ? '(' + rank + '순위)' : '') + (r[10] ? ': ' + r[10] : '') });
  });
  const people = Object.keys(by).map(k => by[k]).sort((a, b) => b.x - a.x || (a.name < b.name ? -1 : 1));
  const rows = [['이름', '구분', '신청', '반영', '거절', '1순위 거절', '2순위 거절', '3순위 거절', '거절 비율', '거절 내역 (최근 순: 연/월/일 신청: 사유)']];
  people.forEach(s => {
    const recent = s.list.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)).map(x => x.text);
    rows.push([s.name, s.type, s.total, s.total - s.x, s.x, s.r1, s.r2, s.r3,
      s.total ? Math.round(s.x / s.total * 100) + '%' : '', recent.join(' / ')]);
  });
  return rows;
}

/**
 * 마감 날짜 글을 Date로. "11/20", "11/20 18:00", "11월 20일 18시", "2026-11-20 18:00".
 * 시각이 없으면 23:59. 해가 없으면 근무표 달 기준으로 정함 (1월 근무표에 12/20이면 전년도).
 */
function parseDeadline(text, rosterYear, rosterMonth) {
  const t = String(text).trim().replace(/^\d{4}\s*[-./년]\s*/, '');
  const m = t.match(/^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\s*(?:\([^)]*\))?\s*(?:(\d{1,2})\s*(?:[:시]\s*(\d{1,2})?\s*분?)?)?\s*$/);
  if (!m) return null;
  const mon = +m[1], day = +m[2], hh = m[3] === undefined ? 23 : +m[3], mm = m[3] === undefined ? 59 : +(m[4] || 0);
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const year = mon > rosterMonth ? rosterYear - 1 : rosterYear;
  const dt = new Date(year, mon - 1, day, hh, mm);
  return dt.getDate() === day ? dt : null;
}

function fmtDeadline(dt) {
  const p = n => (n < 10 ? '0' : '') + n;
  return (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일(' + DAY_NAMES[dt.getDay()] + ') ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
}

/** 메일 제목: "AFCH 26년 12월 간호당직" */
/**
 * 메일 본문용 규칙 검사 요약. results = [{type, found:[{level, rule, target, day, msg}]}]
 * 위반은 전부, 주의는 규칙별 건수만 적음 (자세한 것은 첨부의 검사결과 탭).
 */
function checkSummaryText(results, when) {
  const lines = ['[규칙 검사 결과] ' + when];
  results.forEach(r => {
    const bad = r.found.filter(f => f.level === '위반'), warn = r.found.filter(f => f.level !== '위반');
    lines.push('', '■ ' + r.type + ': 위반 ' + bad.length + '건, 주의 ' + warn.length + '건');
    bad.forEach(f => lines.push('  - [위반] ' + f.rule + ' · ' + f.target + (f.day ? ' ' + f.day : '') + ': ' + f.msg));
    const byRule = {};
    warn.forEach(f => { byRule[f.rule] = (byRule[f.rule] || 0) + 1; });
    const ws = Object.keys(byRule).map(k => k + ' ' + byRule[k] + '건');
    if (ws.length) lines.push('  - [주의] ' + ws.join(', '));
  });
  return lines.join('\n');
}

/**
 * 메일 제목·xlsx 파일 이름. 예: [AFCH 응급실] 간호 근무표 26년 12월 (확정 v3, 261109_1158)
 * version: 확정 버전 번호 (없으면 '초안'), stamp: 보낸 시각 'yyMMdd_HHmm'
 */
function mailSubject(year, month, version, stamp) {
  const tag = (version ? '확정 v' + version : '초안') + (stamp ? ', ' + stamp : '');
  return '[AFCH 응급실] 간호 근무표 ' + String(year).slice(-2) + '년 ' + Number(month) + '월 (' + tag + ')';
}

/**
 * 설문 조건을 [원티드해석] 줄로 바꿈. 금지는 날짜·근무마다 한 줄, 희망은 날짜마다 한 줄("D,휴" = 둘 중 하나).
 * conds = [{ rank, kind, codes: [..], days: [0부터 시작하는 날짜] }]
 */
function condRows(name, conds) {
  const rows = [];
  conds.forEach(c => {
    const src = '설문 ' + c.rank + '순위: ' + c.days.map(d => d + 1).join('·') + '일 ' + c.codes.join('·') + ' ' + c.kind;
    c.days.forEach(d => {
      if (c.kind === '금지') c.codes.forEach(code => rows.push([name, d + 1, '금지', code, c.rank, src, '설문']));
      else rows.push([name, d + 1, '희망', c.codes.join(','), c.rank, src, '설문']);
    });
  });
  return rows;
}

/** 근무·휴무 3순위 신청을 [원티드해석] 줄로 (고정하지 않고 자동 편성이 지켜 주려고 함). */
function rank3Rows(name, w) {
  const rows = [];
  (w.codes || []).forEach((c, d) => {
    if (!c || isPinned(c, (w.ranks && w.ranks[d]) || 0)) return;
    const code = shiftLab(c) || c;
    rows.push([name, d + 1, '희망', code, 3, '설문 3순위: ' + (d + 1) + '일 ' + wantLabelOf(c) +
      (w.notes && w.notes[d] ? ' (' + w.notes[d] + ')' : ''), '설문']);
  });
  return rows;
}

/** 원티드 이름을 명단 이름에 맞춤. "박철우"처럼 짧게 써도 "대위 박철우(22)"를 찾음. */
function findStaffName(staff, name) {
  if (staff.some(p => p.name === name)) return name;
  const hits = staff.filter(p => p.name.indexOf(name) >= 0);
  return hits.length === 1 ? hits[0].name : '';
}

/**
 * 원티드 현황 계산. 시트에 의존하지 않습니다.
 * wants = { 이름: { codes: [날짜별 코드 또는 ''], ranks, entries, memo } }
 * 반환: { people: [{ p, codes, ranks, memo, notes, warn: [..] }], days: [{ offs, cap, over: [..] }] }
 */
function wantedReport(input, wants) {
  const people = input.staff.map(p => {
    const w = wants[p.name] || { codes: [], memo: '' };
    const codes = input.days.map((_, d) => w.codes[d] || '');
    const ranks = input.days.map((_, d) => (w.ranks && w.ranks[d]) || 0);
    const conds = w.conds || [];
    // 날짜별 조건 표시 (예전 설문): 금지는 "✕N", 희망은 "○D"
    const marks = input.days.map((_, d) => conds.filter(c => c.days.indexOf(d) >= 0)
      .map(c => (c.kind === '금지' ? '✕' : '○') + c.codes.join('')).join(' '));
    const forbid = input.days.map((_, d) => {
      const s = {};
      conds.forEach(c => { if (c.kind === '금지' && c.days.indexOf(d) >= 0) c.codes.forEach(x => { s[x] = true; }); });
      return s;
    });
    const officer = p.role === '선임' || p.role === '차선임';
    const warn = [];
    const used = {};
    codes.forEach((c, d) => { if (c && isAdjustable(c)) used[d] = true; });   // 휴가·교육·인사 기간은 세지 않음
    conds.forEach(c => c.days.forEach(d => { used[d] = true; }));
    const n = Object.keys(used).length;
    if (n > WANT_MAX_DAYS) warn.push('근무·휴무 신청 ' + n + '일 (최대 ' + WANT_MAX_DAYS + '일)');
    const fixedCodes = codes.map((c, d) => (c ? codeForDay(c, input.days[d].holiday) : ''));
    fixedCodes.forEach((c, d) => {
      if (!c) return;
      const y = d > 0 ? fixedCodes[d - 1] : '', y2 = d > 1 ? fixedCodes[d - 2] : '';
      if (p.codes[d] && p.codes[d] !== c && !(shiftLab(c) && shiftLab(c) === shiftLab(p.codes[d])))
        warn.push((d + 1) + '일: 근무표에 이미 ' + p.codes[d]);
      if (officer && (c === 'E' || c === 'N')) warn.push((d + 1) + '일 ' + wantLabelOf(c) + ': 장교는 낮번만');
      if (codes[d] === '1' && !input.days[d].holiday) warn.push((d + 1) + '일: 평일이라 1 대신 D로 넣음');
      if (isWork(y) && isWork(c) && rankOf(c) < rankOf(y)) warn.push((d + 1) + '일: ' + y + ' 다음 ' + c + ' 역방향');
      if (isWork(c) && c !== 'N' && (y === 'N' || (y2 === 'N' && y !== 'N'))) warn.push((d + 1) + '일: 밤번 뒤 2일은 휴무');
    });
    (w.incomplete || []).forEach(t => warn.push(t));
    const notes = (w.entries || []).filter(e => e.note).map(entryText);
    return { p, codes, ranks, marks, forbid, officer, memo: w.memo || '', notes, warn };
  });

  const days = input.days.map((info, d) => {
    const need = shiftNeeds(input, d);
    const crew = people.filter(x => x.p.group !== '실습');
    const pinned = x => x.codes[d] && isPinned(x.codes[d], x.ranks[d]);
    // 그날 근무할 수 있는 사람 = 근무표 칸이 비었거나 이미 근무가 적힌 사람
    const able = crew.filter(x => x.p.codes[d] === '' || isWork(x.p.codes[d]));
    const cap = able.length - need.D - need.E - need.N;
    // 오프 신청 = 휴무·휴가·교육·인사 등 근무가 아닌 신청 (고정되는 것만)
    const offs = crew.filter(x => pinned(x) && !shiftLab(x.codes[d])).length;
    const over = [];
    let offOver = false;
    const shiftOver = {};
    if (offs > cap) { over.push('오프 ' + offs + '명 > 가능 ' + cap + '명'); offOver = true; }
    [['D', need.D, isDayShift], ['E', need.E, isEveShift], ['N', need.N, c => c === 'N']].forEach(([lab, k, fn]) => {
      const r = crew.filter(x => pinned(x) && shiftLab(x.codes[d]) === lab).length;
      if (r > k) { over.push(lab + ' 신청 ' + r + '명 > 필요 ' + k + '명'); shiftOver[lab] = true; }
      // 오프·휴가 신청, 금지 조건, 다른 근무 신청을 빼고도 이 근무를 설 수 있는 사람이 충분한지
      const free = able.filter(x => {
        const sheet = x.p.codes[d], req = x.codes[d];
        if (sheet) return fn(sheet);
        if (req) return shiftLab(req) === lab;
        if (x.forbid[d][lab]) return false;
        return lab === 'D' || !x.officer;
      }).length;
      if (free < k) { over.push(lab + ' 설 수 있는 사람 ' + free + '명 < 필요 ' + k + '명'); offOver = true; }
    });
    return { offs, cap, over, offOver, shiftOver };
  });

  // 사람별 "조정 필요" 칸: 넘치는 날에 낸 근무·휴무 신청 (휴가·교육·인사는 빼지 않으므로 표시하지 않음)
  people.forEach(x => {
    x.conflict = input.days.map((_, d) => {
      const c = x.codes[d];
      if (x.p.group === '실습' || !c || x.p.codes[d] || !isAdjustable(c) || !isPinned(c, x.ranks[d])) return false;
      const lab = shiftLab(c);
      return lab ? !!days[d].shiftOver[lab] : days[d].offOver;
    });
    const hits = x.conflict.map((f, d) => (f ? (d + 1) + '일 ' + wantLabelOf(x.codes[d]) : '')).filter(Boolean);
    if (hits.length) x.warn.unshift(CONFLICT_MARK + ' 조정 필요: ' + hits.join(', ') + ' (신청이 넘침)');
  });
  return { people, days };
}

/**
 * [원티드 기록]에 쌓을 줄. 시트에 의존하지 않습니다.
 * 열: 월 | 구분 | 이름 | 날짜 | 종류 | 신청 | 실제 근무 | 반영 | 메모·원문 | 순위 | 거절 사유
 * cuts = resolveConflicts 결과 (③에서 겹쳐서 뺀 날짜 신청). 거절 사유를 남기는 데 씀.
 */
function buildLogRows(key, type, input, wants, cuts) {
  const rows = [];
  const got = (want, actual) => (shiftLab(want) ? shiftLab(actual) === shiftLab(want) : actual === want);
  input.staff.forEach(p => {
    const w = wants[p.name];
    if (w) {
      w.codes.forEach((c, d) => {
        if (!c || d >= input.days.length) return;
        const rank = (w.ranks && w.ranks[d]) || '';
        if (!isPinned(c, rank)) return;   // 근무·휴무 3순위는 아래 [원티드해석] 줄로 기록
        const actual = p.codes[d] || '';
        const ok = got(c, actual);
        const cut = (cuts || []).find(x => x.name === p.name && x.d === d);
        const why = ok ? '' : cut ? '신청 겹침: ' + cut.reason : '근무표에서 다른 근무로 바뀜 (직접 수정·교환 등)';
        rows.push([key, type, p.name, d + 1, '날짜 신청', wantLabelOf(c), actual, ok ? 'O' : 'X', (w.notes && w.notes[d]) || '', rank, why]);
      });
      if (w.memo) rows.push([key, type, p.name, '', '3순위·메모', '', '', '', w.memo, 3, '']);
    }
    // ③에서 날짜 신청을 뺄 때 넣은 희망 줄은 위 "날짜 신청" 줄과 같은 것이라 다시 쓰지 않음
    (input.prefs || []).filter(x => x.name === p.name && x.origin !== '조정').forEach(x => {
      const actual = p.codes[x.d] || '';
      const hit = matchShift(actual, x.code);
      const ok = x.kind === '금지' ? !hit : hit;
      rows.push([key, type, p.name, x.d + 1, x.kind, x.code + (x.rank ? ' (' + x.rank + '순위)' : ''), actual,
        ok ? 'O' : 'X', x.src || '', x.rank || '', ok ? '' : '규칙·필요 인원 때문에 못 맞춤']);
    });
  });
  return rows;
}

/**
 * [근무 부담 기록]에 쌓을 줄. 시트에 의존하지 않습니다.
 * 열: 월 | 구분 | 이름 | 그룹 | 근무일 | 밤번 | 휴일 근무 | 콜대기 | 휴무 | 휴무 기준 | 휴무 차이 | 비교 대상 | 밤번 편차 | 휴일근무 편차 | 콜대기 편차 | 정기휴가
 * 휴무 = 휴 + 주말·공휴일 정기휴가. 정기휴가 = 그달 쓴 정기휴가 일수 (정A·정P 0.5일).
 * 비교 대상: 장교·실습·전입/전출/파견·교육 5일 넘는 사람을 뺀 사람. 편차 = 본인 − 비교 대상 평균 (+면 남보다 많이 일함).
 */
function buildLoadRows(key, type, input) {
  const stats = input.staff.map(p => {
    const c = p.codes;
    const officer = p.role === '선임' || p.role === '차선임';
    const partial = c.some(x => ['입', '출', '역', '파'].indexOf(x) >= 0) || !isActiveMonth(c) ||
      noNightByException(p, input.excepts, input.days.length);   // 임부·한 달 내내 휴가 등은 부담 비교에서 뺌
    const edu =c.filter(x => x === '교' || x === '훈').length;
    const off = c.filter((x, d) => isOffDay(x, input.days[d] && input.days[d].holiday)).length;
    const target = offTargetFor(p, input);
    return {
      p,
      work: c.filter(isWork).length,
      night: c.filter(x => x === 'N').length,
      holiday: c.filter((x, d) => input.days[d] && input.days[d].holiday && (isDayShift(x) || isEveShift(x) || x === 'N')).length,
      call: c.filter(x => x === 'C' || x === '1비' || x === 'E비').length,
      off, target,
      comparable: !officer && p.group !== '실습' && !partial && edu <= 5,
    };
  });
  const cmp = stats.filter(s => s.comparable);
  const avg = f => (cmp.length ? cmp.reduce((a, s) => a + s[f], 0) / cmp.length : 0);
  const aN = avg('night'), aH = avg('holiday'), aC = avg('call');
  const r1 = v => Math.round(v * 10) / 10;
  return stats.map(s => [key, type, s.p.name, s.p.group, s.work, s.night, s.holiday, s.call, s.off, s.target, s.off - s.target,
    s.comparable ? 'O' : '',
    s.comparable ? r1(s.night - aN) : '', s.comparable ? r1(s.holiday - aH) : '', s.comparable ? r1(s.call - aC) : '',
    leaveDays(s.p.codes)]);
}

/**
 * 확정본과 지금 근무표 비교. 시트에 의존하지 않습니다.
 * prev, cur = { 이름: [날짜별 코드] }. 반환: [[이름, 날짜, 이전, 이후]] (사람이 빠지거나 새로 들어온 경우 포함)
 */
function diffRoster(prev, cur) {
  const out = [];
  const names = Object.keys(prev);
  Object.keys(cur).forEach(n => { if (names.indexOf(n) < 0) names.push(n); });
  names.forEach(n => {
    const a = prev[n] || [], b = cur[n] || [];
    const len = Math.max(a.length, b.length);
    for (let d = 0; d < len; d++) {
      const x = a[d] || '', y = b[d] || '';
      if (x !== y) out.push([n, d + 1, x, y]);
    }
  });
  return out;
}

const GROUP_ORDER = { RN: ['시니어', '중간', '막내', '실습'], AN: ['주무관', '의무병'] };

/**
 * 명단 줄을 그룹 순서로 늘어놓을 순서(원래 줄 번호 배열). 같은 그룹 안에서는 원래 순서를 유지하고,
 * 이름이 빈 줄은 맨 아래로 보냄. rows = [[그룹, 직책, 이름, ...]]
 */
function rosterOrder(rows, groups) {
  const rank = r => {
    if (!String(r[2]).trim()) return 999;
    const i = groups.indexOf(String(r[0]).trim());
    return i < 0 ? 500 : i;
  };
  return rows.map((_, i) => i).sort((a, b) => rank(rows[a]) - rank(rows[b]) || a - b);
}

/** 자동 편성 본체. 시트에 의존하지 않습니다. 반환: staff 순서대로 이번 달 코드 배열. */
function generateRoster(input, seconds) {
  const m = buildModel(input);
  const cur = input.staff.map(p => p.codes.slice());
  initialFill(m, cur);
  const res = improve(m, cur, seconds);
  labelShifts(m, res.cur);
  return { codes: res.cur, free: m.people.map(p => p.free), penalty: res.penalty, iterations: res.iterations };
}

// =====================================================================
// 시트 연결부
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('근무표')
    .addItem('① 원티드 설문 만들기 (마감 날짜 정하기)', 'createWantedForm')
    .addItem('　 원티드 마감 날짜 바꾸기 / 다시 열기', 'changeDeadline')
    .addItem('　 원티드 지금 마감하기', 'closeWantedNow')
    .addItem('　 지금 설문 문구만 새로 바꾸기 (응답 유지)', 'updateWantedFormText')
    .addItem('② 원티드 현황 새로고침', 'refreshWantedStatus')
    .addItem('③ 원티드 날짜를 근무표에 반영', 'applyWantedDates')
    .addSeparator()
    .addItem('⑤ 근무표 확정 (공지한 버전 저장)', 'confirmRoster')
    .addItem('⑥ 수정 사항 기록 (확정 후 고쳤을 때)', 'recordChanges')
    .addSeparator()
    .addItem('⑦ 확정본 보관하고 다음 달 작성 시작', 'closeMonth')
    .addSeparator()
    .addItem('규칙 검사 (RN + AN)', 'checkAll')
    .addItem('규칙 검사 (현재 탭)', 'checkActive')
    .addSeparator()
    .addItem('자동 편성 (현재 탭, 빈 칸만)', 'autoFillActive')
    .addItem('자동 편성 지우기 (현재 탭)', 'clearAutoActive')
    .addSeparator()
    .addItem('검사 표시 지우기 (현재 탭)', 'clearActive')
    .addItem('명단 그룹 순으로 정렬 (현재 탭)', 'sortActive')
    .addSeparator()
    .addItem('원티드 거절 요약 새로고침', 'refreshRejectSummary')
    .addItem('규칙·요구사항 탭 새로 만들기', 'buildRulesSheet')
    .addSeparator()
    .addItem('xlsx 만들기 + 이메일 보내기 (' + MAIL_TO.split(',').length + '명)', 'exportPlainXlsx')
    .addToUi();
}

const LOGIC_SHEET = '편성 로직';   // 우선순위·기준 값을 한눈에 보는 탭 (메일 xlsx에 함께 넣음)
const MAIL_TO ='afch86@mnd.go.kr, mainstey@naver.com';   // 완성된 근무표 xlsx를 받는 주소 (여러 명은 쉼표로)

// ---------- 국방망용 xlsx: 수식·조건부서식 없이 값과 색만 남긴 사본 ----------
// 간호 요청(11월 근무표 모양): D·C·E·휴는 색 없음, N은 빨간 글자, 일직·콜대기(1·1비·E비)와 청원휴가는 노랑,
// 정기휴가·공가·포상은 하늘색, 교육·훈련·전입/전출은 연두, 파견은 회색. (RN·AN 탭의 조건부 서식과 같은 색)
const CODE_COLORS = {
  '1': '#ffff00', '1비': '#ffff00', 'E비': '#ffff00', '청': '#ffff00',
  '정': '#c9daf8', '공': '#c9daf8', '포': '#c9daf8', '정A': '#c9daf8', '정P': '#c9daf8',
  '교': '#b6d7a8', '훈': '#b6d7a8', 'TS': '#b6d7a8', '입': '#b6d7a8', '역': '#b6d7a8', '출': '#b6d7a8',
  '파': '#999999',
};
const N_FONT = '#ff0000';   // 밤번 글자색 (원티드 1순위 빨강 #cc0000과 다른 값)

/** 내보내기·보관용 글자색: 원티드 순위 색은 남기고, N은 빨강, 나머지(자동 편성 파랑 포함)는 검정. */
function plainFonts(vals, fonts) {
  return vals.map((r, i) => r.map((v, c) => (v === 'N' ? N_FONT : rankOfFont(fonts[i][c]) ? fonts[i][c] : '#000000')));
}

/**
 * RN·AN 두 탭만 값과 색으로 남긴 새 파일을 만들고, 원하면 그 xlsx를 MAIL_TO로 메일 보냄.
 * (원티드 메모·기록 탭은 넣지 않음. 근무표의 비고 열은 들어감)
 */
function exportPlainXlsx() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const set = ss.getSheetByName(SETTINGS_SHEET);
  const snap = loadSnapshot('RN');
  const confirmed = snap && snap.key === monthKey();
  const year = set.getRange('B3').getValue(), month = set.getRange('B4').getValue();
  const sentAt = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyMMdd_HHmm');
  const subject = mailSubject(year, month, confirmed ? snap.version : 0, sentAt);
  const send = ui.alert('xlsx 만들기',
    'RN·AN 근무표를 xlsx로 만듭니다.\n\n' +
    '이메일로도 보낼까요? (보낼 때는 규칙 검사를 새로 돌려 검사결과와 편성 로직 탭도 함께 보냅니다)\n받는 사람: ' + MAIL_TO + '\n제목: ' + subject +
    (confirmed ? '\n(확정 v' + snap.version + ' 상태)' : '\n\n※ 아직 [⑤ 근무표 확정]을 하지 않은 근무표입니다.') +
    '\n\n[예] 만들고 보내기   [아니요] 만들기만', ui.ButtonSet.YES_NO_CANCEL);
  if (send === ui.Button.CANCEL || send === ui.Button.CLOSE) return;

  const copy = SpreadsheetApp.create(subject);
  ['RN', 'AN'].forEach(name => {
    const src = ss.getSheetByName(name);
    const sh = src.copyTo(copy).setName(name);
    const shown = src.getDataRange().getDisplayValues();   // 원본에 보이는 값 (다른 탭을 참조하는 수식이 깨지지 않게)
    sh.clearConditionalFormatRules();
    sh.getDataRange().clearDataValidations();
    sh.getRange(1, 1, shown.length, shown[0].length).setValues(shown);
    const L = LAYOUT;
    const n = findLastStaffRow(src) - L.firstStaffRow + 1;
    const grid = sh.getRange(L.firstStaffRow, L.prevCol, n, L.prevDays + L.maxDays);
    const vals = grid.getDisplayValues();
    const fonts = src.getRange(L.firstStaffRow, L.prevCol, n, L.prevDays + L.maxDays).getFontColors();
    grid.setBackgrounds(vals.map(r => r.map(v => CODE_COLORS[v] || null)));
    grid.setFontColors(plainFonts(vals, fonts));
  });
  // 메일로 보낼 때는 규칙 검사를 새로 돌려 [검사결과] 탭을 함께 넣고, 본문에도 요약을 적음
  let checkText = '';
  if (send === ui.Button.YES) {
    const results = ['RN', 'AN'].map(n => ss.getSheetByName(n)).filter(Boolean).map(runCheck);
    writeResults(results);
    SpreadsheetApp.flush();
    const rs = ss.getSheetByName(RESULT_SHEET);
    if (rs) {
      const rc = rs.copyTo(copy).setName(RESULT_SHEET);
      const shown = rs.getDataRange().getDisplayValues();
      rc.getRange(1, 1, shown.length, shown[0].length).setValues(shown);
    }
    checkText = checkSummaryText(results, Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'));
  }
  // 편성 로직(우선순위·기준 값) 탭: 로직이 자주 바뀌므로 그때 기준을 같이 보냄 (설정 탭 참조 수식은 값으로)
  const logic = ss.getSheetByName(LOGIC_SHEET);
  if (logic) {
    const lc = logic.copyTo(copy).setName(LOGIC_SHEET);
    const shown = logic.getDataRange().getDisplayValues();
    lc.getRange(1, 1, shown.length, shown[0].length).setValues(shown);
  }
  copy.deleteSheet(copy.getSheets()[0]);   // 새 파일에 처음 있던 빈 탭
  SpreadsheetApp.flush();
  const url = 'https://docs.google.com/spreadsheets/d/' + copy.getId() + '/export?format=xlsx';

  let mailMsg = '';
  if (send === ui.Button.YES) {
    try {
      const blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } })
        .getBlob().setName(subject + '.xlsx');
      MailApp.sendEmail({
        to: MAIL_TO, subject, name: FORM_ORG + ' 근무표',
        body: String(year).slice(-2) + '년 ' + Number(month) + '월 응급실 간호 근무표를 보내드립니다' +
          (confirmed ? ' (확정 v' + snap.version + ')' : ' (확정 전 초안)') + '.\n\n첨부: ' + subject + '.xlsx' +
          ' (RN·AN 근무표 + ' + RESULT_SHEET + ' + ' + LOGIC_SHEET + ' 탭)\n\n' + checkText + '\n\n' + FORM_ORG,
        attachments: [blob],
      });
      const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
      changeSheet(ss).appendRow([stamp, "'" + monthKey(), confirmed ? 'v' + snap.version : '', 'RN·AN', '', '', '', '',
        'xlsx 메일 발송 → ' + MAIL_TO + ' (' + subject + ')']);
      mailMsg = '<p style="color:#38761d"><b>' + MAIL_TO + '</b> 로 보냈습니다.<br>제목: ' + subject + '</p>';
    } catch (e) {
      mailMsg = '<p style="color:#cc0000">메일을 보내지 못했습니다: ' + e.message + '<br>아래 링크로 받아서 직접 보내 주세요.</p>';
    }
  }
  const html = HtmlService.createHtmlOutput(mailMsg +
    '<p><a href="' + url + '" target="_blank">xlsx 내려받기</a></p>' +
    '<p style="color:#666">파일은 내 드라이브에 "' + subject + '"로 남아 있습니다. 다 쓰면 지워도 됩니다.</p>')
    .setWidth(400).setHeight(200);
  ui.showModalDialog(html, 'xlsx');
}

function autoFillActive() {
  const sh = SpreadsheetApp.getActiveSheet();
  const ui = SpreadsheetApp.getUi();
  if (['RN', 'AN'].indexOf(sh.getName()) < 0) {
    ui.alert('RN 또는 AN 탭에서 실행하세요.');
    return;
  }
  const seconds = GEN_SECONDS[sh.getName()];
  const snap = loadSnapshot(sh.getName());
  if (snap && snap.key === monthKey()) {
    const b = ui.alert('자동 편성', '이미 확정(v' + snap.version + ')한 근무표입니다.\n다시 편성하면 파란 칸이 모두 바뀌고, [⑥ 수정 사항 기록] 때 바뀐 칸이 전부 기록됩니다.\n그래도 진행할까요?', ui.ButtonSet.OK_CANCEL);
    if (b !== ui.Button.OK) return;
  }
  const answer = ui.alert('자동 편성',
    '직접 적어 둔 칸(리퀘스트, 휴가, 교육 등)은 그대로 두고 나머지를 채웁니다.\n' +
    '전에 자동 편성한 칸(파란 글씨)은 지우고 다시 짭니다.\n' +
    '약 ' + seconds + '초 걸립니다. 진행할까요?', ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;

  clearAutoActive();
  const lastStaffRow = findLastStaffRow(sh);
  const input = readInput(sh, sh.getName(), lastStaffRow);
  SpreadsheetApp.getActive().toast('편성 중입니다. 약 ' + seconds + '초 걸립니다.', '자동 편성', seconds);
  const res = generateRoster(input, seconds);

  // 빈 칸이던 곳만 값과 글자색을 바꿔서 한 번에 씀
  const L = LAYOUT;
  const nRows = lastStaffRow - L.firstStaffRow + 1;
  const rng = sh.getRange(L.firstStaffRow, L.firstDayCol, nRows, input.days.length);
  const values = rng.getValues();
  const colors = rng.getFontColors();
  input.staff.forEach((p, k) => {
    const r = p.row - L.firstStaffRow;
    res.free[k].forEach((isFree, d) => {
      if (!isFree) return;
      values[r][d] = res.codes[k][d];
      colors[r][d] = AUTO_COLOR;
    });
  });
  rng.setValues(values);
  rng.setFontColors(colors);
  SpreadsheetApp.flush();
  writeResults([runCheck(sh)]);
}

function clearAutoActive() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (['RN', 'AN'].indexOf(sh.getName()) < 0) return;
  const L = LAYOUT;
  const lastStaffRow = findLastStaffRow(sh);
  const rng = sh.getRange(L.firstStaffRow, L.firstDayCol, lastStaffRow - L.firstStaffRow + 1, L.maxDays);
  const values = rng.getValues();
  const colors = rng.getFontColors();
  values.forEach((row, r) => row.forEach((v, d) => {
    const fc = String(colors[r][d]).toLowerCase();
    // 보관본·xlsx에서 복사해 오면 자동 편성 칸이 흰 글씨 N으로 바뀜 → 이것도 자동 칸으로 봄 (원티드 N은 순위 색이라 남음)
    if (fc === AUTO_COLOR || (fc === '#ffffff' && String(v).trim() === 'N')) {
      values[r][d] = '';
      colors[r][d] = '#000000';
    }
  }));
  rng.setValues(values);
  rng.setFontColors(colors);
  clearMarks(sh, lastStaffRow);
}

function checkAll() {
  const ss = SpreadsheetApp.getActive();
  const results = [];
  ['RN', 'AN'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) results.push(runCheck(sh));
  });
  writeResults(results);
}

function checkActive() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (['RN', 'AN'].indexOf(sh.getName()) < 0) {
    SpreadsheetApp.getUi().alert('RN 또는 AN 탭에서 실행하세요.');
    return;
  }
  writeResults([runCheck(sh)]);
}

function clearActive() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (['RN', 'AN'].indexOf(sh.getName()) < 0) return;
  clearMarks(sh, findLastStaffRow(sh));
}

function runCheck(sh) {
  const type = sh.getName();
  const L = LAYOUT;
  const lastStaffRow = findLastStaffRow(sh);
  const input = readInput(sh, type, lastStaffRow);
  const found = checkRoster(input);
  clearMarks(sh, lastStaffRow);
  markCells(sh, found);
  // 직접 입력한 칸(검정 글씨) 수: 원티드·휴가·교육 등 자동 편성이 건드리지 않은 칸
  const n = lastStaffRow - L.firstStaffRow + 1;
  const vals = sh.getRange(L.firstStaffRow, L.firstDayCol, n, input.days.length).getDisplayValues();
  const colors = sh.getRange(L.firstStaffRow, L.firstDayCol, n, input.days.length).getFontColors();
  let manual = 0, auto = 0;
  vals.forEach((r, i) => r.forEach((v, d) => {
    if (!v) return;
    if (String(colors[i][d]).toLowerCase() === AUTO_COLOR) auto++; else manual++;
  }));
  return { type, input, found, manual, auto, cuts: loadCuts(type) };
}

/** ③에서 겹쳐서 뺀 날짜 신청 (이번 달 것만). */
function loadCuts(type) {
  const raw = PropertiesService.getDocumentProperties().getProperty('wantedCuts');
  const saved = raw ? JSON.parse(raw) : null;
  if (!saved || saved.key !== monthKey()) return [];
  return saved.cuts.filter(c => !type || c.type === type);
}

/**
 * 편성 보고서 표. 시트에 의존하지 않습니다.
 * results = [{ type, input, found, manual, auto }]. 반환: { rows, styles } (styles: 줄별 'title'|'section'|'head'|'bad'|'ok'|null, cellBg: {줄: {열: 색}})
 */
function buildReport(results, stamp) {
  const W = 10;
  const rows = [], styles = [], cellBg = {};
  const add = (r, style) => { const v = r.slice(); while (v.length < W) v.push(''); rows.push(v); styles.push(style || null); return rows.length - 1; };
  const tint = (row, col, color) => { (cellBg[row] = cellBg[row] || {})[col] = color; };
  const r1 = v => Math.round(v * 10) / 10;

  add(['편성 보고서', '', '만든 시각 ' + stamp], 'title');
  add(['자동 편성이나 규칙 검사를 누를 때마다 새로 만들어집니다. 빨간 줄 = 확인이 필요한 곳.']);

  results.forEach(res => {
    const inp = res.input, found = res.found;
    const hard = found.filter(f => f.level === '위반');
    const soft = found.filter(f => f.level !== '위반');
    // 조건(희망·금지) 반영 여부
    const wishRows = (inp.prefs || []).map(w => {
      const p = inp.staff.find(s => s.name === w.name);
      const actual = p ? p.codes[w.d] || '' : '';
      const hit = matchShift(actual, w.code);
      const ok = actual ? (w.kind === '금지' ? !hit : hit) : null;
      return { w, actual, ok };
    });
    const judged = wishRows.filter(x => x.ok !== null);
    const okCount = judged.filter(x => x.ok).length;
    // 사람별 분배
    const load = buildLoadRows('', res.type, inp);   // [.., 이름, 그룹, 근무일, 밤번, 휴일, 콜, 휴, 기준, 차이, 비교, 편차들]
    const dist = inp.staff.map((p, k) => ({
      p, D: p.codes.filter(isDayShift).length, E: p.codes.filter(isEveShift).length,
      N: load[k][5], H: load[k][6], call: load[k][7], off: load[k][8], target: load[k][9], cmp: load[k][11] === 'O',
    }));
    const cmp = dist.filter(x => x.cmp);
    const avg = f => (cmp.length ? cmp.reduce((s, x) => s + x[f], 0) / cmp.length : 0);
    const nVals = cmp.map(x => x.N);
    const offBad = dist.filter(x => x.off !== x.target && !x.p.codes.some(c => c === '')).length;
    const blanks = inp.staff.reduce((s, p) => s + p.codes.filter(c => c === '').length, 0);

    add(['■ ' + res.type + ' 요약'], 'section');
    const sumRows = [
      ['규칙 위반', hard.length + '건', hard.length ? '아래 위반 목록과 근무표의 빨간 테두리 칸을 확인하세요.' : '없음'],
      ['주의', soft.length + '건', '원티드 미반영, 콜대기 다음 날 낮번 등 (아래 목록)'],
      ['조건(희망·금지) 반영', judged.length ? okCount + ' / ' + judged.length + ' (' + Math.round(okCount / judged.length * 100) + '%)' : '조건 없음',
        '[원티드해석]의 희망·금지가 지켜졌는지'],
      ['직접 입력 칸', res.manual + '칸', '원티드·휴가·교육 등. 자동 편성이 바꾸지 않음'],
      ['자동 편성 칸', res.auto + '칸', '파란 글씨'],
      ['빈 칸', blanks + '칸', blanks ? '아직 편성 안 된 칸이 있습니다' : ''],
      ['밤번 개수 (비교 대상)', nVals.length ? Math.min.apply(null, nVals) + ' ~ ' + Math.max.apply(null, nVals) + '개' : '-',
        '규칙: 2개 이상 차이 나면 안 됨'],
      ['휴무 기준 안 맞는 사람', offBad + '명', ''],
    ];
    sumRows.forEach(r => {
      const bad = (r[0] === '규칙 위반' && hard.length) || (r[0] === '휴무 기준 안 맞는 사람' && offBad) ||
        (r[0].indexOf('밤번') === 0 && nVals.length && Math.max.apply(null, nVals) - Math.min.apply(null, nVals) >= 2);
      add(r, bad ? 'bad' : null);
    });

    add([]);
    add(['■ ' + res.type + ' 원티드 조건 반영'], 'section');
    if (!wishRows.length) add(['[원티드해석]에 이 탭 사람의 조건이 없습니다. 날짜 신청은 근무표 칸에 고정되어 항상 반영됩니다.']);
    else {
      add(['이름', '날짜', '희망/금지', '근무', '순위', '실제', '반영', '원문'], 'head');
      wishRows.forEach(x => add([x.w.name, (x.w.d + 1) + '일', x.w.kind, x.w.code, x.w.rank || '', x.actual,
        x.ok === null ? '미편성' : (x.ok ? 'O' : 'X'), x.w.src || ''], x.ok === false ? 'bad' : null));
    }

    add([]);
    add(['■ ' + res.type + ' 날짜 신청이 겹쳐서 뺀 것 (③ 반영 때)'], 'section');
    const cuts = res.cuts || [];
    if (!cuts.length) add(['없음 (날짜 신청은 모두 근무표에 고정됨)'], 'ok');
    else {
      add(['기준: ① 신청 순위(1순위 먼저) → ② 지금까지 원티드를 못 받은 횟수가 많은 사람 → ③ 설문을 먼저 낸 사람. 휴가·교육·인사는 빼지 않음.']);
      add(['뺀 신청은 자동 편성에서 "희망"으로 한 번 더 시도합니다. 아래 "결과"가 O면 결국 들어준 것입니다.']);
      add(['이름', '날짜', '신청', '순위', '못 받은 횟수', '결과', '이유'], 'head');
      cuts.forEach(c => {
        const p = inp.staff.find(s => s.name === c.name);
        const actual = p ? p.codes[c.d] || '' : '';
        const ok = actual ? (shiftLab(c.code) ? shiftLab(actual) === shiftLab(c.code) : actual === c.code) : null;
        add([c.name, (c.d + 1) + '일', wantLabelOf(c.code), c.rank || '', c.hist + '번', ok === null ? '미편성' : ok ? 'O' : 'X', c.reason],
          ok === false ? 'bad' : null);
      });
    }

    add([]);
    add(['■ ' + res.type + ' 사람별 근무 분배'], 'section');
    add(['진한 주황 = 비교 대상 평균보다 1개 이상 많음, 하늘색 = 1개 이상 적음. 비교 대상: 장교·실습·전입/전출/파견·장기 교육 제외']);
    add(['이름', '그룹', '낮번', '초번', '밤번', '휴일 근무', '콜대기', '휴무', '휴무 기준', '비교 대상'], 'head');
    const aD = avg('D'), aE = avg('E'), aN = avg('N'), aH = avg('H'), aC = avg('call');
    dist.forEach(x => {
      const i = add([x.p.name, x.p.group, x.D, x.E, x.N, x.H, x.call, x.off, x.target, x.cmp ? 'O' : ''],
        x.off !== x.target && !x.p.codes.some(c => c === '') ? 'bad' : null);
      if (!x.cmp) return;
      [[2, x.D, aD], [3, x.E, aE], [4, x.N, aN], [5, x.H, aH], [6, x.call, aC]].forEach(([col, v, a]) => {
        if (v >= a + 1) tint(i, col, '#f6b26b');
        else if (v <= a - 1) tint(i, col, '#cfe2f3');
      });
    });
    add(['비교 대상 평균', '', r1(aD), r1(aE), r1(aN), r1(aH), r1(aC)], 'head');
    add(['그룹별 1인 평균 (장교 제외)', '인원', '낮번', '초번', '밤번', '휴'], 'head');
    groupStats(inp).forEach(s => add(s));

    add([]);
    add(['■ ' + res.type + ' 위반·주의 목록'], 'section');
    if (!found.length) add(['없음'], 'ok');
    else {
      add(['수준', '규칙', '대상', '날짜', '내용'], 'head');
      hard.concat(soft).forEach(f => add([f.level, f.rule, f.target, f.day, f.msg], f.level === '위반' ? 'bad' : null));
    }
    add([]);
  });

  add(['■ 자동 편성은 이렇게 짭니다'], 'section');
  [
    ['1', '직접 입력한 칸(검정 글씨: 원티드 날짜 신청, 휴가, 교육, 파견 등)은 절대 바꾸지 않고, 빈 칸만 채웁니다.'],
    ['2', '날짜순으로 필요 인원(N → E → D)과 사람별 휴무 개수를 먼저 맞춘 초안을 만듭니다.'],
    ['3', '두 사람의 근무 맞바꾸기, 한 사람의 두 날 맞바꾸기 등을 수십만 번 시도하며 아래 점수 합이 가장 낮은 근무표를 고릅니다.'],
    ['4', '점수 (낮을수록 좋음): 규칙 위반 100 > 원티드 금지 60 > 1순위 희망 45 > 2순위 30 > 3순위 15 > 밤번·초번 고르게 > 하루짜리 근무·휴무 피하기. 지금까지 원티드를 못 받은 횟수 1번마다 +10 (최대 +30).'],
    ['5', '그래서 규칙과 원티드가 부딪히면 규칙이 먼저이고, 원티드끼리는 금지 → 1순위 → 2순위 → 3순위 순으로 지켜집니다. 같은 순위끼리는 그동안 덜 받은 사람이 먼저입니다. 못 지킨 것은 위 "원티드 조건 반영"에 X로 남고, 월 마감 때 [' + REJECT_SHEET + ']에 쌓입니다.'],
    ['6', '마지막에 평일 낮번 1명을 C로, 휴일 낮번은 1(일직), 그중 1명을 1비, 휴일 초번 1명을 E비로 바꿉니다. 콜대기는 사람마다 고르게 돌립니다.'],
  ].forEach(r => add(r));
  return { rows, styles, cellBg, W };
}

function findLastStaffRow(sh) {
  const names = sh.getRange(LAYOUT.firstStaffRow, LAYOUT.nameCol, sh.getLastRow(), 1).getDisplayValues();
  for (let i = 0; i < names.length; i++) {
    if (names[i][0] === LAYOUT.endMarker) return LAYOUT.firstStaffRow + i - 1;
  }
  throw new Error('"' + LAYOUT.endMarker + '" 줄을 찾지 못했습니다. C열의 일별 집계 표시를 지우지 마세요.');
}

/**
 * 근무표 맨 오른쪽 [비고] 열 번호 (3행 제목이 "비고"인 열). 없으면 create=true일 때 맨 오른쪽에 만듦, 아니면 0.
 */
function noteColumn(sh, create) {
  const L = LAYOUT;
  const lastCol = sh.getLastColumn();
  const head = sh.getRange(L.dateRow, 1, 1, lastCol).getDisplayValues()[0];
  const i = head.indexOf(NOTE_HEADER);
  if (i >= 0) return i + 1;
  if (!create) return 0;
  if (sh.getMaxColumns() <= lastCol) sh.insertColumnAfter(lastCol);
  const c = lastCol + 1;
  sh.getRange(L.dateRow, c).setValue(NOTE_HEADER).setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange(L.dateRow, c, 3, 1).setBackground('#d9e1f2');
  const n = findLastStaffRow(sh) - L.firstStaffRow + 1;
  sh.getRange(L.firstStaffRow, c, n, 1).setWrap(true).setFontSize(9)
    .setVerticalAlignment('middle').setHorizontalAlignment('left')
    .setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidth(c, 260);
  return c;
}

/**
 * [설정] 필요 인원 (B=평일, C=휴일). 9 RN 낮번, 10 RN 초번, 11 RN 초번 최소 허용, 12 RN 밤번,
 * 13 AN 낮번 최소, 14 AN 초번, 15 AN 밤번, 16 RN 밤번 최소 허용 (비어 있으면 RN 밤번과 같음).
 */
function readNeed(set) {
  const nv = set.getRange('B9:C16').getValues();
  const num = (v, dflt) => (v === '' || v === null || isNaN(Number(v)) ? dflt : Number(v));
  return {
    rnDay: nv[0], rnEve: nv[1], rnEveMin: nv[2], rnNight: nv[3], anDay: nv[4], anEve: nv[5], anNight: nv[6],
    rnNightMin: [num(nv[7][0], nv[3][0]), num(nv[7][1], nv[3][1])],
  };
}

function readInput(sh, type, lastStaffRow) {
  const L = LAYOUT;
  const ss = sh.getParent();
  const set = ss.getSheetByName(SETTINGS_SHEET);
  const need = readNeed(set);
  const offTarget = Number(set.getRange('B6').getValue());

  const dates = sh.getRange(L.dateRow, L.firstDayCol, 1, L.maxDays).getValues()[0];
  const kinds = sh.getRange(L.kindRow, L.firstDayCol, 1, L.maxDays).getDisplayValues()[0];
  const days = [];
  for (let d = 0; d < L.maxDays; d++) {
    if (!(dates[d] instanceof Date)) break;
    days.push({ day: d + 1, holiday: kinds[d] === '휴일', weekday: dates[d].getDay() });
  }

  const nRows = lastStaffRow - L.firstStaffRow + 1;
  const width = L.firstDayCol + L.maxDays - 1;
  const vals = sh.getRange(L.firstStaffRow, 1, nRows, width).getDisplayValues();
  const staff = [];
  vals.forEach((r, i) => {
    const name = String(r[L.nameCol - 1]).trim();
    if (!name) return;
    const norm = v => String(v).trim();
    staff.push({
      row: L.firstStaffRow + i,
      group: norm(r[L.groupCol - 1]),
      role: norm(r[L.roleCol - 1]),
      name,
      prev: r.slice(L.prevCol - 1, L.prevCol - 1 + L.prevDays).map(norm),
      codes: r.slice(L.firstDayCol - 1, L.firstDayCol - 1 + days.length).map(norm),
    });
  });
  const prefs = readWishes(ss, staff, days.length);
  const missed = rejectCounts(ss);
  prefs.forEach(w => { if (missed[w.name]) w.boost = missed[w.name]; });
  const pairs = readPairs(ss).filter(r => r.type === type).map(r => [r.a, r.b]);
  const duty = readDuty(ss).filter(r => r.type === type);
  const first = dates[0] instanceof Date ? dates[0] : new Date();
  const excepts = expandExceptions(readExceptions(ss).filter(r => r.type === type), first.getFullYear(), first.getMonth(), days);
  return { type, days, staff, need, offTarget, prefs, pairs, duty, excepts };
}

// ---------- [규칙·요구사항] 탭 ----------
// 다른 부서도 볼 수 있게 규칙을 한 탭에 정리. "같은 시간대 근무 금지" 표만 사람이 고치고,
// 나머지는 [근무표 > 규칙·요구사항 탭 새로 만들기]로 코드·설정 값에서 다시 씀.
const RULES_SHEET = '규칙·요구사항';
const PAIR_HEADER = ['구분', '이름 1', '이름 2', '메모'];
const DEFAULT_PAIRS = [['AN', '이금희', '이은이', '같은 시간대(낮번·초번·밤번) 근무 금지']];

// 개인별 일직(휴일 낮번 1·1비) 횟수. 원칙보다 적거나 최대보다 많으면 금지, 원칙~최대 사이면 지양(주의).
const DUTY_HEADER = ['구분', '이름', '일직 원칙', '일직 최대', '메모'];
const DEFAULT_DUTY = [
  ['RN', '김지현', 1, 1, '선임: 일직 월 1회'],
  ['RN', '윤은재', 1, 2, '차선임: 가급적 1회, 규칙상 어려우면 2회까지'],
];
const DUTY_SOFT = 40;   // 원칙보다 1회 많을 때 점수 (규칙 위반 100보다 작게)

/** 휴일에 서는 낮번 = 일직 (편성 중에는 D, 이름 붙인 뒤에는 1·1비). */
function isDutyDay(code, holiday) { return !!holiday && isDayShift(code); }

/** [규칙·요구사항]에서 header로 시작하는 표를 읽음. 탭이 없으면 defaults. 반환: 줄 배열 (빈 줄에서 멈춤) */
function readRulesTable(ss, header, defaults) {
  const sh = ss.getSheetByName(RULES_SHEET);
  if (!sh) return defaults.map(r => r.map(String));   // 탭을 만들기 전에도 기본값은 지킴
  if (sh.getLastRow() < 2) return [];
  const w = Math.min(header.length, sh.getMaxColumns());
  const vals = sh.getRange(1, 1, sh.getLastRow(), w).getDisplayValues().map(r => r.concat(Array(header.length - w).fill('')));
  const h = vals.findIndex(r => header.every((x, k) => String(r[k]).trim() === x));
  if (h < 0) return defaults.map(r => r.map(String));
  const out = [];
  for (let i = h + 1; i < vals.length; i++) {
    const r = vals[i].map(v => String(v).trim());
    if (!r[0] && !r[1]) break;
    if (r[0] === 'RN' || r[0] === 'AN') out.push(r);
  }
  return out;
}

// 개인별 예외 근무: 기간·요일마다 넣을 수 있는 근무를 정함 (대학원 등). 적힌 근무 밖이면 금지.
const EXC_HEADER = ['구분', '이름', '시작', '끝', '요일', '가능 근무', '메모'];
const DEFAULT_EXC = [
  ['RN', '안선영', '', '2026-12-20', '수', 'E,N', '대학원: 수요일 초번 또는 밤번'],
  ['RN', '안선영', '', '2026-12-20', '목', '휴', '대학원: 목요일 휴무'],
  ['RN', '안선영', '', '2026-12-20', '금', 'N,휴', '대학원: 금요일 밤번 또는 휴무'],
  ['RN', '김슬기', '', '', '평일', 'D,E,휴', '임부: 평일 낮번·초번만 (밤번 없음, E 다음 날 D 금지)'],
  ['RN', '김슬기', '', '', '휴일', '휴', '임부: 주말·공휴일 근무 없음'],
  ['RN', '김지연', '', '', '평일', 'D,E,휴', '임부: 평일 낮번·초번만 (밤번 없음, E 다음 날 D 금지)'],
  ['RN', '김지연', '', '', '휴일', '휴', '임부: 주말·공휴일 근무 없음'],
];

/** 예외 표 때문에 이번 달 밤번을 아예 설 수 없는 사람 (밤번 균등 비교에서 뺌) */
function noNightByException(p, excepts, nDays) {
  const mine = (excepts || []).filter(e => sameName(p.name, e.name));
  if (!mine.length) return false;
  const byDay = {};
  mine.forEach(e => { byDay[e.d] = e.allowed; });
  for (let d = 0; d < nDays; d++) if (!(d in byDay) || matchShift('N', byDay[d])) return false;
  return true;
}
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** "2026-12-20", "2026. 12. 20", "12/20" → Date. 빈 칸이면 null */
function parseRuleDate(text, year) {
  const s = String(text).trim();
  let m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(year, Number(m[1]) - 1, Number(m[2]));
  return null;
}

/** 개인별 예외 근무. 반환 [{ type, name, from, to, weekdays:[0~6], allowed, memo }] (from·to는 표 글자 그대로) */
function readExceptions(ss) {
  return readRulesTable(ss, EXC_HEADER, DEFAULT_EXC).filter(r => r[1] && r[5]).map(r => {
    const toks = String(r[4]).split(/[,·\s]+/).filter(Boolean);
    const wd = toks.map(x => WEEKDAY_KO.indexOf(x.replace('요일', ''))).filter(x => x >= 0);
    // 요일 칸: 월~일, 또는 평일(근무표의 평일)·휴일(주말·공휴일), 빈 칸·매일이면 모든 날
    const kind = toks.indexOf('평일') >= 0 ? '평일' : toks.indexOf('휴일') >= 0 ? '휴일' : '';
    return { type: r[0], name: r[1], from: r[2], to: r[3], when: String(r[4]).trim(),
      weekdays: wd.length ? wd : [0, 1, 2, 3, 4, 5, 6], kind,
      allowed: String(r[5]).replace(/\s/g, '').replace(/오프/g, '휴'), memo: r[6] };
  });
}

/** 예외 표를 이번 달 날짜별로 펼침. 반환 [{ name, d, allowed, memo }] */
function expandExceptions(list, year, month0, days) {
  const out = [];
  list.forEach(e => {
    const from = parseRuleDate(e.from, year), to = parseRuleDate(e.to, year);
    days.forEach((info, d) => {
      const date = new Date(year, month0, d + 1);
      if ((from && date < from) || (to && date > to) || e.weekdays.indexOf(info.weekday) < 0) return;
      if ((e.kind === '평일' && info.holiday) || (e.kind === '휴일' && !info.holiday)) return;
      out.push({ name: e.name, d, allowed: e.allowed, memo: e.memo });
    });
  });
  return out;
}

/** 같은 시간대 금지 짝. 반환 [{ type, a, b, memo }] */
function readPairs(ss) {
  return readRulesTable(ss, PAIR_HEADER, DEFAULT_PAIRS).filter(r => r[1] && r[2])
    .map(r => ({ type: r[0], a: r[1], b: r[2], memo: r[3] }));
}

/** 일직 횟수. 반환 [{ type, name, base, max, memo }] */
function readDuty(ss) {
  return readRulesTable(ss, DUTY_HEADER, DEFAULT_DUTY).filter(r => r[1] && r[2] !== '')
    .map(r => {
      const base = Number(r[2]) || 0;
      return { type: r[0], name: r[1], base, max: Math.max(base, Number(r[3]) || base), memo: r[4] };
    });
}

/**
 * 규칙 목록 줄: [구분, 규칙, 수준, 내용]. 수준: 금지(검사 '위반') / 지양(검사 '주의', 되도록 피함) / 안내.
 * need = 설정의 필요 인원, offTarget = 휴무 기준. 시트에 의존하지 않습니다.
 */
function buildRuleRows(need, offTarget) {
  const LV = { '위반': '금지', '주의': '지양', '위반/주의': '금지/지양', '-': '안내' };
  return ruleRowsRaw(need, offTarget).map(r => [r[0], r[1], LV[r[2]] || r[2], r[3]]);
}

function ruleRowsRaw(need, offTarget) {
  const p = a => a[0] + '명 / 휴일 ' + a[1] + '명';
  return [
    ['공통', '근무 순서', '위반', '낮번 → 초번 → 밤번 순서로만 이어짐 (밤번 다음 날 낮번 같은 역방향 금지)'],
    ['공통', '연속 근무 최대', '위반', '최대 5일 연속 근무'],
    ['공통', '밤번 뒤 휴무', '위반', '밤번이 끝나면 2일 휴무'],
    ['공통', '밤번 간격', '위반', '밤번 묶음 사이 간격 최소 ' + NIGHT_GAP + '일 (사이에는 D·E·휴 등 섞어도 됨)'],
    ['공통', '연속 근무 후 휴무', '위반', BLOCK_MIN + '일 이상 연속 근무하면 그 뒤 휴무는 최소 ' + AFTER_BLOCK_OFF + '일'],
    ['공통', '초번-하루 휴무-낮번', '위반', '초번 뒤 하루만 쉬고 낮번 금지 (E-휴-D)'],
    ['공통', '초번 3일 이상 뒤', '위반', '초번 3일 이상 연속이면 그 뒤 최소 2일 휴무 (밤번으로 이어지는 것은 허용)'],
    ['공통', '연속 근무 최소', '주의', '근무는 되도록 최소 ' + BLOCK_MIN + '일 연속 (휴휴EE휴휴 같은 짧은 근무 피함)'],
    ['공통', '근무 사이 휴무', '주의', '근무 묶음 사이 휴무는 되도록 최소 ' + AFTER_BLOCK_OFF + '일 (' + BLOCK_MIN + '일 이상 근무 뒤에는 금지)'],
    ['공통', '연속 휴무 최대', '위반', '휴무(휴)는 최대 ' + MAX_OFF_RUN + '일 연속. 정기휴가 등 휴가는 붙여도 됨 (휴가 날은 세지 않음)'],
    ['공통', '휴무 개수', '위반', '한 달 휴무 = 휴무 기준(이번 달 ' + offTarget + '개). 휴 + 주말·공휴일에 쓴 정기휴가(정)를 셈. 전입·전출·파견자는 실제 근무 기간의 휴일 수'],
    ['공통', '밤번 균등', '위반', '밤번 개수 차이 2개 이상 금지 (선임·차선임·실습·전입/전출/파견 제외)'],
    ['공통', '휴일 근무 균등', '주의', '주말·공휴일 근무 횟수(D·E·N 상관없이)를 같은 그룹(시니어·중간·막내 / 주무관·의무병) 안에서 가급적 고르게 (완전 동등은 아님, 다른 규칙이 먼저. 휴일마다 그룹별 1명 이상이 필요해 그룹끼리는 횟수가 다를 수 있음). ' + HOLI_GAP + '번 이상 차이 나면 검사에서 알림 (2026년 12월부터. 선임·차선임·실습·전입/전출/파견·임부 등 제외)'],
    ['공통', '휴일 낮번 표기', '주의', '휴일 낮번은 1 또는 1비로 표기'],
    ['RN', '밤번 연속', '위반', '최대 3일 연속 (4일 이상 금지)'],
    ['RN', '3N', '주의', '밤번 3일 연속은 되도록 피함 (금지는 아님)'],
    ['RN', '3N 뒤 휴무', '위반', '3N을 했으면 그 뒤 3일 휴무'],
    ['RN', '선임·차선임 일직', '위반/주의', '아래 [일직 횟수] 표대로. 원칙보다 적거나 최대보다 많으면 금지, 원칙보다 많고 최대 이하면 지양 (예: 김지현 월 1회, 윤은재 1회·어려우면 2회)'],
    ['RN', '평일 낮번', '위반', '최소 ' + need.rnDay[0] + '명, C 1명, 선임·차선임 1명 이상, 시니어 또는 중간 1명 이상'],
    ['RN', '평일 초번', '위반/주의', '최소 ' + need.rnEveMin[0] + '명 (원칙 ' + need.rnEve[0] + '명)'],
    ['RN', '밤번 시니어', '위반', '평일·휴일 모든 밤번에 시니어(선임 그룹) 1명 이상'],
    ['RN', '휴일 낮번', '위반', need.rnDay[1] + '명, 1비 반드시 1명, 시니어·중간·막내 각 1명 이상'],
    ['RN', '휴일 초번', '위반', need.rnEve[1] + '명, E비 1명, 시니어·중간·막내 각 1명 이상'],
    ['RN', '밤번 인원', '위반', '평일 ' + p(need.rnNight) + ', 최소 허용 평일 ' + p(need.rnNightMin || need.rnNight) +
      ' (최소보다 적으면 금지. 휴일은 시니어·중간·막내 각 1명 이상)'],
    ['AN', '밤번 연속', '위반', '최대 2일 연속 (3N 금지)'],
    ['AN', '낮번', '위반', '최소 평일 ' + p(need.anDay) + ', 주무관 1명 이상'],
    ['AN', '초번', '위반', '평일 ' + p(need.anEve) + ', 주무관 1명 이상'],
    ['AN', '밤번', '위반', '평일 ' + p(need.anNight)],
    ['AN', '월·수 밤번', '위반', '월요일·수요일 밤번에 의무병 편성 금지 (주무관만)'],
    ['AN', '의무병끼리 근무', '주의', '낮번·초번에 의무병(이현수·장태윤·이상민 등) 2명 이상이 같이 서는 것은 되도록 피함 (밤번은 1명이라 해당 없음)'],
    ['RN·AN', '같은 시간대 근무 금지', '위반', '아래 표의 두 사람은 같은 날 같은 시간대(낮번·초번·밤번)에 넣지 않음'],
    ['RN·AN', '개인별 예외 근무', '위반', '아래 [개인별 예외 근무] 표의 기간·요일에는 적힌 근무만 넣음 (대학원·임부 등. 휴가·교육 칸은 예외). 밤번을 못 서는 사람은 밤번 균등 비교에서 뺌'],
    ['RN·AN', '리퀘스트 전날 밤번', '위반', '원티드 휴무 희망일·휴가(정·청·공·포) 전날 밤번 금지. 예: 가족 여행 전날 밤번이면 다음 날 쉬지 못함'],
    ['RN·AN', '리퀘스트 전날 초번', '주의', '원티드 휴무 희망일·휴가(정·청·공·포) 전날 초번은 되도록 피함'],
    ['원티드', '신청', '-', '1순위(꼭 필요) · 2순위(되면 좋음) · 3순위(들어주면 고마움), 순위마다 시작·끝 날짜. 근무 날짜 최대 ' + WANT_MAX_DAYS + '일'],
    ['원티드', '1순위 메모', '-', '세부사유를 꼭 적음. 메모는 공개 현황표에 보임'],
    ['원티드', '반영 순서', '-', '겹치면 1순위 → 2순위 → 3순위, 같은 순위면 지난달까지 거절이 많은 사람 먼저'],
    ['자동 편성', '우선순위', '-', '★ RN 매일 밤번에 시니어(선임 그룹) 1명: 무조건, 가장 먼저 ⓪ 근무 시간대별 최소 인원(밤번 최소 3명 등)·휴일 그룹 구성 ①금지 규칙·휴무 개수 (밤번 뒤 2일 휴무, 밤번 간격 ' + NIGHT_GAP + '일, ' + BLOCK_MIN + '일 이상 근무 뒤 2일 휴무, 휴일 1비, 리퀘스트 전날 밤번 금지 포함) ② 원티드 1순위 ③ 연속 근무 최소 ' + BLOCK_MIN + '일·사이 휴무 ' + AFTER_BLOCK_OFF + '일 ④ 원티드 금지 ⑤ 2·3순위 희망 ⑥ 일직 원칙 횟수 ⑦ 리퀘스트 전날 초번 피하기 ⑧ 휴일 근무 균등 ⑨ RN 3N 피하기 (자세한 순서는 [편성 로직] 탭)'],
    ['자동 편성', '거절 보상', '-', '원티드를 못 받은 횟수만큼(최대 ' + BOOST_MAX + '번) 다음 달 원티드를 더 무겁게 봄'],
    ['기록', '근무 부담', '-', '마감 때 [근무 부담 기록]에 밤번·휴일 근무·콜대기·휴무·정기휴가(정 1일, 정A·정P 0.5일)를 쌓고 [근무 부담 요약]에서 누적'],
  ];
}

function buildRulesSheet() {
  const ss = SpreadsheetApp.getActive();
  const set = ss.getSheetByName(SETTINGS_SHEET);
  const need = readNeed(set);
  const offTarget = Number(set.getRange('B6').getValue());
  const pairs = readPairs(ss).map(r => [r.type, r.a, r.b, r.memo]);
  const duty = readDuty(ss).map(r => [r.type, r.name, r.base, r.max, r.memo]);
  const excs = readExceptions(ss).map(r => [r.type, r.name, r.from, r.to, r.when, r.allowed, r.memo]);

  let sh = ss.getSheetByName(RULES_SHEET);
  if (!sh) sh = ss.insertSheet(RULES_SHEET);
  sh.clear();
  sh.clearConditionalFormatRules();
  if (sh.getMaxColumns() < 7) sh.insertColumnsAfter(sh.getMaxColumns(), 7 - sh.getMaxColumns());
  sh.getRange(1, 1).setValue('근무표 규칙·요구사항').setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1).setValue('금지 = 절대 안 됨 (검사 \'위반\'), 지양 = 되도록 피함 (검사 \'주의\'), 안내 = 운영 방법. 인원 수는 [설정] 탭 값 (' +
    monthKey() + '). 아래 두 표(같은 시간대 금지·일직 횟수)는 직접 고쳐도 검사·자동 편성에 반영됩니다.').setWrap(false).setFontColor('#666666');
  const rules = buildRuleRows(need, offTarget);
  const top = 4;
  sh.getRange(top, 1, 1, 4).setValues([['구분', '규칙', '수준', '내용']]).setFontWeight('bold').setBackground('#d9e1f2');
  sh.getRange(top + 1, 1, rules.length, 4).setValues(rules);
  const color = { 공통: '#ffffff', RN: '#eaf1fb', AN: '#fdf2e9', 'RN·AN': '#f3eefa', 원티드: '#fff8e1', '자동 편성': '#eef7ee', 기록: '#f3f3f3' };
  sh.getRange(top + 1, 1, rules.length, 4).setBackgrounds(rules.map(r => Array(4).fill(color[r[0]] || '#ffffff')));
  sh.getRange(top + 1, 3, rules.length, 1).setFontWeight('bold')
    .setFontColors(rules.map(r => [r[2].indexOf('금지') === 0 ? '#cc0000' : r[2] === '지양' ? '#b45f06' : '#666666']));
  sh.getRange(top, 1, rules.length + 1, 4).setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID)
    .setVerticalAlignment('middle');

  const pt = top + rules.length + 3;
  sh.getRange(pt - 1, 1).setValue('같은 시간대 근무 금지 (이 표는 직접 고쳐도 됩니다. 구분은 RN 또는 AN, 이름은 근무표 이름 그대로 또는 "다군" 등을 뺀 이름)')
    .setFontWeight('bold');
  sh.getRange(pt, 1, 1, 4).setValues([PAIR_HEADER]).setFontWeight('bold').setBackground('#d9e1f2');
  if (pairs.length) sh.getRange(pt + 1, 1, pairs.length, 4).setValues(pairs);
  sh.getRange(pt, 1, pairs.length + 1, 4).setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);

  const dt = pt + pairs.length + 4;
  sh.getRange(dt - 1, 1).setValue('일직 횟수 (휴일 낮번 1·1비. 원칙보다 적거나 최대보다 많으면 금지, 그 사이면 지양)').setFontWeight('bold');
  sh.getRange(dt, 1, 1, 5).setValues([DUTY_HEADER]).setFontWeight('bold').setBackground('#d9e1f2');
  if (duty.length) sh.getRange(dt + 1, 1, duty.length, 5).setValues(duty);
  sh.getRange(dt, 1, duty.length + 1, 5).setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);

  const et = dt + duty.length + 4;
  sh.getRange(et - 1, 1).setValue('개인별 예외 근무 (예외 규정. 시작·끝은 2026-12-20 또는 12/20, 빈 칸이면 제한 없음. 요일은 수,목처럼. 가능 근무는 D·E·N·휴를 쉼표로)')
    .setFontWeight('bold');
  sh.getRange(et, 1, 1, 7).setValues([EXC_HEADER]).setFontWeight('bold').setBackground('#d9e1f2');
  if (excs.length) sh.getRange(et + 1, 1, excs.length, 7).setNumberFormat('@').setValues(excs);
  sh.getRange(et, 1, excs.length + 1, 7).setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);

  sh.setColumnWidth(1, 80); sh.setColumnWidth(2, 170); sh.setColumnWidth(3, 70); sh.setColumnWidth(4, 640);
  sh.getRange(top + 1, 4, rules.length, 1).setWrap(true);
  sh.setFrozenRows(top);
  arrangeTabs();
  ss.setActiveSheet(sh);
  sh.setColumnWidth(5, 280); sh.setColumnWidth(6, 90); sh.setColumnWidth(7, 280);
  ss.toast('규칙 ' + rules.length + '개, 같은 시간대 금지 ' + pairs.length + '쌍, 일직 ' + duty.length + '명, 예외 ' + excs.length + '줄', RULES_SHEET, 5);
}

/**
 * [원티드 기록]에서 사람별로 원티드를 못 받은(X) 횟수. 지난 달까지 전부 합침.
 * 자동 편성 점수(+10씩)와, 신청이 겹칠 때 누구 것을 먼저 들어줄지에 씀.
 */
function rejectCounts(ss) {
  const log = ss.getSheetByName(LOG_SHEET);
  const out = {};
  if (!log || log.getLastRow() < 2) return out;
  log.getRange(2, 1, log.getLastRow() - 1, 8).getDisplayValues().forEach(r => {
    if (r[7] === 'X') out[r[2]] = (out[r[2]] || 0) + 1;
  });
  return out;
}

/** [원티드 기록]을 모아 [원티드 거절 요약] 탭을 다시 씀. */
function refreshRejectSummary() {
  const ss = SpreadsheetApp.getActive();
  const log = ss.getSheetByName(LOG_SHEET);
  const rows = buildRejectSummary(log && log.getLastRow() > 1
    ? log.getRange(2, 1, log.getLastRow() - 1, Math.max(11, log.getLastColumn())).getDisplayValues() : []);
  let sh = ss.getSheetByName(REJECT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(REJECT_SHEET);
    sh.protect().setDescription('원티드 거절 요약: 자동으로 만들어지는 표입니다').setWarningOnly(true);
  }
  sh.clear();
  const tz = ss.getSpreadsheetTimeZone();
  sh.getRange(1, 1).setValue('원티드 거절 요약 (갱신 ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') +
    ') · 거절이 많은 사람이 위. 거절 횟수가 많을수록 다음 달 신청이 겹칠 때 먼저 들어주고, 자동 편성에서도 점수를 더 받습니다.')
    .setFontWeight('bold');
  sh.getRange(3, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(3, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#d9e1f2');
  if (rows.length > 1) {
    sh.getRange(4, 2, rows.length - 1, 8).setHorizontalAlignment('center');
    sh.getRange(4, 5, rows.length - 1, 1).setBackgrounds(rows.slice(1).map(r => [r[4] >= 3 ? '#f4cccc' : r[4] ? '#fce5cd' : null]));
  }
  sh.setColumnWidth(1, 150);
  sh.setColumnWidths(2, 8, 70);
  sh.setColumnWidth(10, 700);
  sh.setFrozenRows(3);
  arrangeTabs();
  ss.toast('[' + REJECT_SHEET + '] 탭을 새로 만들었습니다.', '원티드', 5);
}

/** [원티드해석] 탭: 이름 | 날짜(일) | 종류(희망/금지) | 코드(D/E/N/휴) | 순위 | 원문 | 출처(설문/조정/직접) */
function readWishes(ss, staff, nDays) {
  const sh = ss.getSheetByName(WISH_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const prefs = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getDisplayValues().forEach(r => {
    const [rawName, day, kind, rawCode, rank, src, origin] = r.map(v => String(v).trim());
    const name = rawName && findStaffName(staff, rawName);
    const d = parseInt(day, 10) - 1;
    const code = rawCode === '오프' ? '휴' : rawCode;
    if (!name || isNaN(d) || d < 0 || d >= nDays || (kind !== '희망' && kind !== '금지') || !code) return;
    prefs.push({ name, d, kind, code, rank: parseInt(rank, 10) || 0, src, origin });
  });
  return prefs;
}

function clearMarks(sh, lastStaffRow) {
  const L = LAYOUT;
  const width = L.firstDayCol + L.maxDays - 1;
  const rng = sh.getRange(L.firstStaffRow, 1, lastStaffRow - L.firstStaffRow + 1, width);
  rng.clearNote();
  rng.setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);
  const head = sh.getRange(L.weekdayRow, L.firstDayCol, 1, L.maxDays);
  head.clearNote();
  head.setBorder(true, true, true, true, true, true, GRID_BORDER, SpreadsheetApp.BorderStyle.SOLID);
}

function markCells(sh, found) {
  // 같은 셀의 메모는 한데 모아 한 번에 씀
  const byCell = {};
  found.forEach(f => {
    const key = f.row + ':' + f.col;
    (byCell[key] = byCell[key] || { row: f.row, col: f.col, lines: [], hard: false });
    byCell[key].lines.push('[' + f.level + '] ' + f.rule + ': ' + f.msg);
    if (f.level === '위반') byCell[key].hard = true;
  });
  Object.keys(byCell).forEach(k => {
    const c = byCell[k];
    const cell = sh.getRange(c.row, c.col);
    cell.setNote(c.lines.join('\n'));
    cell.setBorder(true, true, true, true, null, null, c.hard ? '#cc0000' : '#e69138',
      SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
}

function writeResults(results) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(RESULT_SHEET) || ss.insertSheet(RESULT_SHEET);
  sh.clear();
  sh.setFrozenRows(0);
  const tz = ss.getSpreadsheetTimeZone();
  const rep = buildReport(results, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'));
  const STYLE_BG = { title: null, section: '#d9e1f2', head: '#efefef', bad: '#f4cccc', ok: '#d9ead3' };
  const bgs = rep.rows.map((r, i) => r.map((_, c) => (rep.cellBg[i] && rep.cellBg[i][c]) || STYLE_BG[rep.styles[i]] || null));
  const rng = sh.getRange(1, 1, rep.rows.length, rep.W);
  rng.setValues(rep.rows).setBackgrounds(bgs).setVerticalAlignment('middle').setWrap(false);
  rep.styles.forEach((s, i) => {
    if (s === 'title') sh.getRange(i + 1, 1).setFontSize(15).setFontWeight('bold');
    if (s === 'section') sh.getRange(i + 1, 1, 1, rep.W).setFontWeight('bold').setFontSize(12);
    if (s === 'head') sh.getRange(i + 1, 1, 1, rep.W).setFontWeight('bold');
  });
  // 숫자·짧은 값은 가운데, 이름과 설명 글은 왼쪽
  rng.setHorizontalAlignments(rep.rows.map(r => r.map((v, c) =>
    (c === 0 || (typeof v === 'string' && v.length > 8) ? 'left' : 'center'))));
  sh.setColumnWidth(1, 170);
  sh.setColumnWidths(2, rep.W - 1, 80);

  const total = results.reduce((s, r) => s + r.found.filter(f => f.level === '위반').length, 0);
  ss.toast(total ? '위반 ' + total + '건. 빨간 테두리 칸의 메모와 [검사결과] 탭을 확인하세요.' : '위반 없음.', '규칙 검사', 8);
}

// ---------- 원티드: 설문 만들기 ----------
const FORM_ORG = '수도병원 응급실';
const Q_NAME = '1. 내 이름 고르기';
const Q_GRID = k => ['', '2. 1순위 · 꼭 필요한 날', '3. 2순위 · 되면 좋은 날'][k];    // 순위 구역 제목 (예전 설문에서는 날짜표 제목)
const Q_RANK = (k, field) => k + '순위 ' + field;                    // 질문 제목: "1순위 날짜", "1순위 원티드"
const Q_RANK_RE = /^([123])순위 (시작 날짜|끝 날짜|날짜|신청|메모|원티드|세부내용)$/;   // 날짜·원티드·세부내용은 예전 질문 이름
const Q_FIELD = { '시작 날짜': '시작', '끝 날짜': '끝', 날짜: '시작', 신청: '신청', 메모: '메모', 원티드: '신청', 세부내용: '메모' };
// 구글 설문은 글자·칸 색을 바꿀 수 없어서, 현황표 색(주황·파랑·초록)과 같은 색 네모로 순위를 구분함
const RANK_SECTION = ['', '🟧 1순위 · 꼭 필요한 날', '🟦 2순위 · 되면 좋은 날', '🟩 3순위 · 들어주면 고마운 날'];
const RANK_SECTION_OLD = ['', '1순위 · 꼭 필요한 날', '2순위 · 되면 좋은 날', '3순위 · 들어주면 고마운 날'];
const RANK_HELP = ['',
  '꼭 필요한 날입니다. 없으면 건너뛰세요.',
  '1순위보다 덜 중요하지만 되면 좋은 날입니다. 없으면 건너뛰세요.',
  '근무·휴무는 되도록 맞춰 드리지만 못 맞출 수도 있습니다. 없으면 건너뛰세요.'];
const Q_MEMO = '세부내용 · 그 밖의 신청 (자유롭게)';
const Q_GRID_OLD = ['2. 원하는 날짜 누르기', '1순위 · 원하는 날짜 누르기', '2순위 · 원하는 날짜 누르기'];   // 더 예전 설문 (순서대로 1,1,2순위로 봄)
const Q_MEMO_OLD = ['4. 3순위 · 그 밖의 신청이나 사유 (글로 적기)', '4. 하고 싶은 말 (없으면 비워 두세요)', '하고 싶은 말 (없으면 비워 두세요)'];
const Q_COND_DAYS = k => k + '순위 조건 · 날짜';
const Q_COND_KIND = k => k + '순위 조건 · 희망/금지';
const Q_COND_CODES = k => k + '순위 조건 · 근무';
const DAY_NAMES = '일월화수목금토';

function readBoth() {
  const ss = SpreadsheetApp.getActive();
  return ['RN', 'AN'].map(t => {
    const sh = ss.getSheetByName(t);
    return { type: t, input: readInput(sh, t, findLastStaffRow(sh)) };
  });
}

function createWantedForm() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getDocumentProperties();
  const set = ss.getSheetByName(SETTINGS_SHEET);
  const label = set.getRange('B3').getDisplayValue() + '년 ' + set.getRange('B4').getDisplayValue() + '월';
  if (props.getProperty('wantedFormId')) {
    const a = ui.alert('원티드 설문', '이미 만든 설문이 있습니다. ' + label + ' 설문을 새로 만들까요?\n' +
      '(이전 설문은 닫히고 구글 드라이브에 남습니다. 현황은 새 설문 기준으로 바뀌니, 이미 낸 사람도 새 설문에 다시 내야 합니다.)', ui.ButtonSet.OK_CANCEL);
    if (a !== ui.Button.OK) return;
    try { FormApp.openById(props.getProperty('wantedFormId')).setAcceptingResponses(false); } catch (e) { /* 설문을 지운 경우 */ }
  }
  const deadline = askDeadline(ui, '원티드 마감 날짜',
    label + ' 원티드 신청을 언제까지 받을까요?\n이 시각이 되면 설문이 자동으로 닫힙니다.');
  if (!deadline) return;
  const blocks = readBoth();
  const days = blocks[0].input.days;
  const names = [].concat.apply([], blocks.map(b => b.input.staff.map(p => p.name)));

  // 다른 사람이 보는 현황 파일 (메모·세부내용도 보임). 설문 안내에 링크를 넣으려고 먼저 만듦.
  const pub = SpreadsheetApp.create(FORM_ORG + ' ' + label + ' 원티드 현황 (보기 전용)');

  const form = FormApp.create(FORM_ORG + ' ' + label + ' 원티드 신청');
  form.setTitle(FORM_ORG + ' ' + label + ' 원티드 신청');
  form.setDescription(formDescription(label, deadline));
  form.setAllowResponseEdits(true);
  form.setShowLinkToRespondAgain(true);
  form.addListItem().setTitle(Q_NAME).setChoiceValues(names).setRequired(true);
  const dayLabels = days.map(x => x.day + '일 (' + DAY_NAMES[x.weekday] + ')' + (x.holiday ? ' 휴일' : ''));
  for (let k = 1; k <= WANT_RANKS; k++) {
    form.addListItem().setTitle(Q_RANK(k, '시작 날짜')).setChoiceValues(dayLabels);
    form.addListItem().setTitle(Q_RANK(k, '끝 날짜')).setChoiceValues(dayLabels);
    form.addListItem().setTitle(Q_RANK(k, '신청')).setChoiceValues(WANT_ITEMS.map(x => x[0]));
    form.addTextItem().setTitle(Q_RANK(k, '메모'));
  }
  form.addParagraphTextItem().setTitle(Q_MEMO);
  const hasImages = formatWantedForm(form, deadline, pub.getUrl());

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();
  // 구글이 만든 "설문지 응답 시트N" 탭을 "설문응답 2026-11"로 이름 바꿔 뒤쪽에 둠
  ss.getSheets().forEach(s => {
    const url = s.getFormUrl();
    if (url && url.indexOf(form.getId()) >= 0) {
      const name = RESP_PREFIX + monthKey();
      const old = ss.getSheetByName(name);
      if (old && old.getSheetId() !== s.getSheetId()) old.setName(name + ' (이전 ' + old.getSheetId() + ')');
      s.setName(name);
    }
  });
  arrangeTabs();
  let shareMsg = '링크가 있는 누구나 볼 수 있게 공유했습니다.';
  try {
    DriveApp.getFileById(pub.getId()).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    shareMsg = '자동 공유가 막혀 있습니다. 현황 파일을 열어 [공유 → 링크가 있는 모든 사용자, 뷰어]로 바꿔 주세요.';
  }
  props.setProperties({ wantedFormId: form.getId(), wantedPublicId: pub.getId(), wantedLabel: label });
  props.deleteProperty('wantedCuts');
  props.deleteProperty('wantedApplied');

  // 설문이 제출될 때마다 현황 갱신 (구글 서버에서 돌아서 컴퓨터를 켜 둘 필요 없음)
  deleteTriggers('onWantedSubmit');
  ScriptApp.newTrigger('onWantedSubmit').forSpreadsheet(ss).onFormSubmit().create();
  setDeadline(form, deadline);
  refreshWantedStatus();

  const html = HtmlService.createHtmlOutput(
    (hasImages ? '' : '<p style="color:#cc0000"><b>설문 머리 그림이 빠졌습니다.</b> Apps Script에 images.gs 파일이 없습니다.</p>') +
    '<p><b>마감</b>: ' + fmtDeadline(deadline) + ' (이때 설문이 자동으로 닫힙니다)</p>' +
    '<p><b>설문 링크</b> (단톡방에 공유)<br><a href="' + form.getPublishedUrl() + '" target="_blank">' + form.getPublishedUrl() + '</a></p>' +
    '<p><b>설문 고치기</b> (문구 수정 등)<br><a href="' + form.getEditUrl() + '" target="_blank">편집 화면 열기</a><br>' +
    '<span style="color:#cc0000">질문 제목(1순위 시작 날짜 등)과 원티드 목록 이름은 바꾸지 마세요. 반영할 때 이 이름으로 읽습니다.</span></p>' +
    '<p><b>현황 링크</b> (보기 전용)<br><a href="' + pub.getUrl() + '" target="_blank">' + pub.getUrl() + '</a></p>' +
    '<p style="color:#666">' + shareMsg + '<br>마감을 바꾸려면 메뉴 [원티드 마감 날짜 바꾸기 / 다시 열기].</p>').setWidth(520).setHeight(380);
  ui.showModalDialog(html, '원티드 설문을 만들었습니다');
}

/** 사용 방법 글. 처음 보는 사람도 따라 할 수 있게 씀. */
function formHowTo(deadline, statusUrl) {
  return '■ 마감: ' + fmtDeadline(deadline) + ' 까지\n\n' +
    '원티드는 근무표를 짜기 전에, 꼭 필요한 날과 원하는 근무를 미리 신청하는 것입니다.\n\n' +
    '■ 신청 방법\n' +
    '1. 내 이름을 고릅니다.\n\n' +
    '2. 🟧 1순위의 시작 날짜와 끝 날짜를 고르고, 신청에서 원하는 것을 고릅니다.\n' +
    '     하루만 신청하면 끝 날짜는 비워 둡니다.\n' +
    '     쉬고 싶은 날 → 휴무\n' +
    '     휴가를 쓰는 날 → 정기휴가, 청원휴가 등\n' +
    '     서고 싶은 근무가 있는 날 → D(낮번), E(초번), N(밤번), 1(토·공휴일 낮번)\n\n' +
    '3. 🟦 2순위, 🟩 3순위도 같은 방법으로 고릅니다. 없으면 건너뜁니다.\n\n' +
    '4. 1순위 메모에는 세부사유를 꼭 적습니다. 2순위·3순위 메모는 필요할 때만 적습니다.\n\n' +
    '5. 목록으로 고르기 어려운 내용은 맨 아래 칸에 적습니다.\n\n' +
    '6. 맨 아래 [제출]을 누르면 끝입니다.\n\n' +
    '■ 알아 두세요\n' +
    '※ 현황표에서도 1순위는 주황, 2순위는 파랑, 3순위는 초록으로 보입니다.\n' +
    '※ 토·공휴일에 D를 골라도 근무표에는 1로 들어갑니다.\n' +
    '※ 휴가·교육·훈련은 순위와 상관없이 근무표에 먼저 넣습니다.\n' +
    '※ 신청이 겹치면 1순위를 먼저, 순위가 같으면 그동안 덜 받은 분을 먼저 들어줍니다.\n' +
    '※ 제출 후 현황표의 내 이름 줄에 ' + CONFLICT_MARK + ' 표시가 있으면 신청이 넘친 날입니다. 서로 조정해서 다시 내 주세요.\n' +
    '※ 다시 내면 마지막에 낸 것만 반영됩니다.\n' +
    '※ 메모와 맨 아래 칸에 적은 글은 이름과 함께 현황표에 공개됩니다. 다른 분이 보면 곤란한 사유는 담당자에게 직접 말씀해 주세요.\n\n' +
    '■ 다른 분들 신청 보기\n' + statusUrl;
}

/**
 * 설문의 안내 문구·순위 구역·원티드 목록·머리 그림을 맞춤. 응답은 건드리지 않음.
 * 새 설문을 만들 때와, 이미 만든 설문을 고칠 때 함께 씀. 반환: 설문에 머리 그림이 있으면 true.
 */
function formatWantedForm(form, deadline, statusUrl) {
  const find = title => form.getItems().find(i => i.getTitle() === title);
  const section = (title, help, beforeTitle) => {
    let it = find(title);
    if (!it) {
      it = form.addSectionHeaderItem().setTitle(title);
      form.moveItem(it.getIndex(), find(beforeTitle).getIndex());
      it = find(title);
    }
    it.asSectionHeaderItem().setHelpText(help);
  };
  const listHelp = (title, help) => { const it = find(title); if (it) it.asListItem().setHelpText(help); };
  const textHelp = (title, help) => { const it = find(title); if (it) it.asTextItem().setHelpText(help); };
  const rename = (from, to) => { const it = find(from); if (it) it.setTitle(to); };
  // 이미 만든 설문의 예전 이름을 새 이름으로 (날짜 - 신청 - 메모)
  for (let k = 1; k <= WANT_RANKS; k++) {
    rename(Q_RANK(k, '날짜'), Q_RANK(k, '시작 날짜'));
    rename(Q_RANK(k, '원티드'), Q_RANK(k, '신청'));
    rename(Q_RANK(k, '세부내용'), Q_RANK(k, '메모'));
    rename(RANK_SECTION_OLD[k], RANK_SECTION[k]);
  }

  listHelp(Q_NAME, '목록에서 내 이름을 찾아 누르세요.');
  section('사용 방법', formHowTo(deadline, statusUrl), Q_NAME);
  for (let k = 1; k <= WANT_RANKS; k++) {
    section(RANK_SECTION[k], RANK_HELP[k], Q_RANK(k, '시작 날짜'));
    // 이미 만든 설문에는 끝 날짜 질문이 없으므로 시작 날짜 바로 뒤에 넣음 (응답은 그대로)
    const start = find(Q_RANK(k, '시작 날짜'));
    if (!find(Q_RANK(k, '끝 날짜'))) {
      const end = form.addListItem().setTitle(Q_RANK(k, '끝 날짜'))
        .setChoiceValues(start.asListItem().getChoices().map(c => c.getValue()));
      form.moveItem(end.getIndex(), start.getIndex() + 1);
    }
    listHelp(Q_RANK(k, '시작 날짜'), '');
    listHelp(Q_RANK(k, '끝 날짜'), '하루만 신청하면 비워 두세요.');
    const want = find(Q_RANK(k, '신청'));
    if (want) want.asListItem().setChoiceValues(WANT_ITEMS.map(x => x[0])).setHelpText('');
    textHelp(Q_RANK(k, '메모'), k === 1 ? '세부사유를 꼭 적으세요. (예: 방사선 비상진료 교육)' : '');
  }
  const memo = find(Q_MEMO);
  if (memo) memo.asParagraphTextItem().setHelpText('목록으로 고르기 어려운 내용을 적어 주세요. 없으면 비워 두세요.\n' +
    '예) 수요일마다 낮번 또는 쉬는 날 / 22일 밤번만 빼 주세요\n' +
    '※ 적은 내용은 현황표와 근무표 비고란에 보입니다.');

  // 머리 그림이 없으면 맨 위에 넣음
  let hasImages = form.getItems(FormApp.ItemType.IMAGE).length > 0;
  if (!hasImages && typeof HEADER_IMAGES !== 'undefined' && HEADER_IMAGES.length) {
    HEADER_IMAGES.forEach((b64, k) => {
      const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'header' + (k + 1) + '.jpg');
      const img = form.addImageItem().setImage(blob).setAlignment(FormApp.Alignment.CENTER).setWidth(560);
      form.moveItem(img.getIndex(), k);
    });
    hasImages = true;
  }
  form.setConfirmationMessage(
    '제출되었습니다. 감사합니다.\n\n' +
    '다른 분들 신청과 겹치는지 아래 현황표에서 꼭 확인해 주세요.\n' + statusUrl + '\n\n' +
    '내 이름 줄에 ' + CONFLICT_MARK + ' 표시가 있으면 신청이 넘쳐 조정이 필요한 날입니다. 같은 날 신청한 분과 조정해서 다시 내 주세요.\n' +
    '고칠 것이 있으면 이 화면의 [응답 수정]을 누르거나, 설문을 처음부터 다시 내면 됩니다.');
  return hasImages;
}

/** 메뉴: 지금 열려 있는 설문의 문구·목록·그림만 고침. 응답과 마감은 그대로. */
function updateWantedFormText() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getDocumentProperties();
  const formId = props.getProperty('wantedFormId');
  if (!formId) { ui.alert('먼저 [① 원티드 설문 만들기]를 실행하세요.'); return; }
  const a = ui.alert('설문 문구 새로 바꾸기', '지금 설문의 안내 문구, 원티드 목록, 머리 그림을 새 내용으로 바꿉니다.\n' +
    '이미 받은 응답과 마감 날짜는 그대로 둡니다. 진행할까요?', ui.ButtonSet.OK_CANCEL);
  if (a !== ui.Button.OK) return;
  const form = FormApp.openById(formId);
  const dl = Number(props.getProperty('wantedDeadline'));
  const pubId = props.getProperty('wantedPublicId');
  const statusUrl = pubId ? SpreadsheetApp.openById(pubId).getUrl() : '';
  const deadline = dl ? new Date(dl) : new Date();
  const hasImages = formatWantedForm(form, deadline, statusUrl);
  refreshWantedStatus();   // 설문 첫 화면 설명도 새 문구로 바꿈
  ui.alert('설문 문구를 바꿨습니다. 응답은 그대로입니다.' +
    (hasImages ? '' : '\n\n머리 그림은 빠졌습니다. Apps Script에 images 파일을 넣고 다시 눌러 주세요.'));
}

function onWantedSubmit() {
  refreshWantedStatus();
}

// ---------- 원티드: 마감 ----------
/** 설문 첫 화면 설명. conflicts가 있으면 지금 신청이 넘치는 날을 맨 위에 띄움. */
function formDescription(label, deadline, conflicts, statusUrl) {
  const warn = conflicts && conflicts.length
    ? CONFLICT_MARK + ' 지금 신청이 넘쳐 조정이 필요한 날: ' + conflicts.join(' / ') + '\n' +
      '이 날 신청하신 분은 현황표에서 내 이름 줄의 ' + CONFLICT_MARK + ' 표시를 확인하고, 서로 조정해서 다시 내 주세요.' +
      (statusUrl ? '\n현황표: ' + statusUrl : '') + '\n\n'
    : '';
  return warn + label + ' 근무표를 짜기 전에, 꼭 필요한 날과 원하는 근무(쉬는 날, 휴가, 교육 등)를 미리 받습니다.\n' +
    '■ 마감: ' + fmtDeadline(deadline) + ' 까지\n' +
    '아래 [사용 방법]을 먼저 읽어 주세요. 1분이면 끝납니다.';
}

function deleteTriggers(handler) {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

/** 마감 날짜를 묻는 창. 취소하면 null. */
function askDeadline(ui, title, msg) {
  const set = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  const y = Number(set.getRange('B3').getValue()), m = Number(set.getRange('B4').getValue());
  const def = new Date();
  def.setDate(def.getDate() + 7);
  def.setHours(18, 0, 0, 0);
  const ex = (def.getMonth() + 1) + '/' + def.getDate() + ' 18:00';
  let warn = '';
  for (;;) {
    const res = ui.prompt(title, warn + msg + '\n\n날짜와 시각을 적어 주세요.\n예) ' + ex + '   또는   ' +
      (def.getMonth() + 1) + '월 ' + def.getDate() + '일 18시\n(시각을 안 적으면 그날 밤 23:59)\n\n비워 두고 [확인]을 누르면 ' +
      fmtDeadline(def) + '로 정합니다.', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return null;
    const text = res.getResponseText().trim();
    const dt = text ? parseDeadline(text, y, m) : def;
    if (!dt) { warn = '※ "' + text + '"를 날짜로 읽지 못했습니다. 예처럼 다시 적어 주세요.\n\n'; continue; }
    if (dt.getTime() <= Date.now()) { warn = '※ ' + fmtDeadline(dt) + '는 이미 지난 시각입니다.\n\n'; continue; }
    const ok = ui.alert(title, '마감을 ' + fmtDeadline(dt) + '로 정할까요?', ui.ButtonSet.YES_NO);
    if (ok === ui.Button.YES) return dt;
    warn = '';
  }
}

/** 마감 시각 저장, 설문 설명 고침, 그 시각에 자동으로 닫는 예약 만들기. */
function setDeadline(form, deadline) {
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('wantedDeadline', String(deadline.getTime()));
  form.setDescription(formDescription(props.getProperty('wantedLabel') || '', deadline));
  form.setAcceptingResponses(true);
  deleteTriggers('closeWantedForm');
  ScriptApp.newTrigger('closeWantedForm').timeBased().at(deadline).create();
}

/** 예약된 마감 시각에 구글 서버가 실행. 설문을 닫고 현황을 마지막으로 갱신. */
function closeWantedForm() {
  const formId = PropertiesService.getDocumentProperties().getProperty('wantedFormId');
  deleteTriggers('closeWantedForm');
  if (!formId) return;
  try {
    FormApp.openById(formId).setAcceptingResponses(false)
      .setCustomClosedFormMessage('원티드 신청이 마감되었습니다. 바꿀 것이 있으면 근무표 담당자에게 직접 말씀해 주세요.');
  } catch (e) { /* 설문을 지운 경우 */ }
  refreshWantedStatus();
}

function closeWantedNow() {
  const ui = SpreadsheetApp.getUi();
  if (!PropertiesService.getDocumentProperties().getProperty('wantedFormId')) { ui.alert('열려 있는 원티드 설문이 없습니다.'); return; }
  if (ui.alert('원티드 지금 마감', '지금 바로 설문을 닫을까요?', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  closeWantedForm();
  ui.alert('마감했습니다. 다시 열려면 [원티드 마감 날짜 바꾸기 / 다시 열기].');
}

function changeDeadline() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getDocumentProperties();
  const formId = props.getProperty('wantedFormId');
  if (!formId) { ui.alert('먼저 [① 원티드 설문 만들기]를 실행하세요.'); return; }
  const form = FormApp.openById(formId);
  const old = Number(props.getProperty('wantedDeadline'));
  const deadline = askDeadline(ui, '원티드 마감 날짜 바꾸기',
    '지금 마감: ' + (old ? fmtDeadline(new Date(old)) : '없음') + (form.isAcceptingResponses() ? '' : ' (닫혀 있음)') +
    '\n새 마감을 정하면 설문이 다시 열립니다.');
  if (!deadline) return;
  setDeadline(form, deadline);
  refreshWantedStatus();
  ui.alert('마감을 ' + fmtDeadline(deadline) + '로 바꿨고 설문을 열었습니다.\n단톡방에 바뀐 마감을 알려 주세요.');
}

/** 명단 줄(A열~날짜 칸)을 그룹 순서로 정렬. 줄의 근무·글자색·비고도 함께 옮김. */
function sortRoster(sh) {
  const L = LAYOUT;
  const last = findLastStaffRow(sh);
  if (last < L.firstStaffRow) return false;
  const n = last - L.firstStaffRow + 1;
  const rng = sh.getRange(L.firstStaffRow, 1, n, L.firstDayCol + L.maxDays - 1);
  const vals = rng.getValues();
  const order = rosterOrder(vals, GROUP_ORDER[sh.getName()]);
  if (order.every((v, i) => v === i)) return false;
  const colors = rng.getFontColors();
  rng.setValues(order.map(i => vals[i]));
  rng.setFontColors(order.map(i => colors[i]));
  const nc = noteColumn(sh, false);
  if (nc) {
    const notes = sh.getRange(L.firstStaffRow, nc, n, 1);
    const nv = notes.getValues();
    notes.setValues(order.map(i => nv[i]));
  }
  clearMarks(sh, last);
  return true;
}

function sortActive() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (['RN', 'AN'].indexOf(sh.getName()) < 0) {
    SpreadsheetApp.getUi().alert('RN 또는 AN 탭에서 실행하세요.');
    return;
  }
  SpreadsheetApp.getActive().toast(sortRoster(sh) ? '그룹 순서로 정렬했습니다.' : '이미 정렬되어 있습니다.', '명단 정렬', 4);
}

/**
 * 보관 탭("2026-11 근무표")을 고치면 [근무표 변경 기록]에 자동으로 남기고 칸 색을 맞춤.
 * 보관한 뒤에도 그달 근무가 진행 중이라 바뀔 수 있기 때문. 사유는 기록 탭에 직접 적음.
 */
function onEdit(e) {
  const sh = e.range.getSheet();
  const name = sh.getName();
  // RN·AN 명단(A~C열)을 고치면 그룹 순서로 자동 정렬
  if ((name === 'RN' || name === 'AN') && e.range.getColumn() <= LAYOUT.nameCol &&
      e.range.getRow() >= LAYOUT.firstStaffRow) {
    sortRoster(sh);
    return;
  }
  if (!/^\d{4}-\d{2} 근무표$/.test(name)) return;
  const L = LAYOUT;
  const r0 = e.range.getRow(), c0 = e.range.getColumn();
  if (c0 < L.firstDayCol || c0 > L.firstDayCol + L.maxDays - 1 || r0 < L.firstStaffRow) return;
  const ss = sh.getParent();
  const log = changeSheet(ss);
  const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  // AN 근무표 제목 줄보다 아래면 AN
  const titles = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues();
  const anTop = titles.findIndex(t => t[0].indexOf('AN 근무표') >= 0) + 1;
  const type = anTop > 0 && r0 > anTop ? 'AN' : 'RN';
  const key = "'" + name.slice(0, 7);
  if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1) {
    const person = sh.getRange(r0, L.nameCol).getDisplayValue();
    if (!person) return;
    const v = e.value === undefined ? '' : String(e.value);
    log.appendRow([stamp, key, '보관 후', type, person, c0 - L.firstDayCol + 1, e.oldValue || '', v, '']);
    e.range.setBackground(CODE_COLORS[v] || null).setFontColor(v === 'N' ? N_FONT : '#000000');
  } else {
    log.appendRow([stamp, key, '보관 후', type, '', '', '', '', '여러 칸 수정: ' + e.range.getA1Notation() + ' (자세한 내용은 버전 기록 참고)']);
  }
}

/**
 * 이름별로 마지막에 낸 응답만 (마감 뒤에 들어온 응답은 뺌).
 * 반환: { 이름: { time, codes: [날짜별 코드], ranks: [날짜별 순위], notes: [날짜별 세부내용], entries, conds, memo } }
 *   entries = [{ from, to, code, rank, note }] (새 설문의 신청 1건씩, 날짜는 0부터)
 *   같은 날에 신청이 둘이면 순위가 높은 것(같으면 먼저 적은 것)이 남음.
 */
function readWantedResponses() {
  const props = PropertiesService.getDocumentProperties();
  const formId = props.getProperty('wantedFormId');
  if (!formId) return null;
  const deadline = Number(props.getProperty('wantedDeadline')) || Infinity;
  const latest = {};
  FormApp.openById(formId).getResponses().forEach(r => {
    let name = '', memo = '';
    const codes = [], ranks = [], notes = [];
    const grid = (v, k) => (v || []).forEach((x, d) => {
      if (x && WANT_CODE[x] && !codes[d]) { codes[d] = WANT_CODE[x]; ranks[d] = k; }
    });
    const cond = {};   // 순위 → { days, kind, codes }
    const raw = {};    // 순위 → { rank, 날짜, 원티드, 세부내용 }
    const items = r.getItemResponses();
    // 순위가 높은 날짜표부터 읽어야 같은 날을 두 번 눌렀을 때 높은 순위가 남음 (예전 설문)
    for (let k = 1; k <= RANK_GRIDS; k++) items.forEach(ir => { if (ir.getItem().getTitle() === Q_GRID(k)) grid(ir.getResponse(), k); });
    items.forEach(ir => {
      const t = ir.getItem().getTitle(), v = ir.getResponse();
      const em = t.match(Q_RANK_RE);
      if (em) { (raw[em[1]] = raw[em[1]] || { rank: +em[1] })[Q_FIELD[em[2]]] = v; return; }
      const old = Q_GRID_OLD.indexOf(t);
      if (t === Q_NAME) name = v;
      else if (old >= 0) grid(v, Math.max(1, old));
      else if (t === Q_MEMO || Q_MEMO_OLD.indexOf(t) >= 0) memo = v;
      for (let k = 1; k <= COND_COUNT; k++) {
        const c = cond[k] = cond[k] || { rank: k, days: [], kind: '', codes: [] };
        if (t === Q_COND_DAYS(k)) c.days = (v || []).map(s => parseInt(s, 10) - 1).filter(d => d >= 0);
        if (t === Q_COND_KIND(k)) c.kind = COND_KINDS[v] || '';
        if (t === Q_COND_CODES(k)) c.codes = (v || []).filter(x => COND_CODES.indexOf(x) >= 0);
      }
    });
    // 지금 설문: 순위마다 신청 1건 (시작 날짜 - 끝 날짜 - 신청 - 메모)
    const entries = [], incomplete = [];
    Object.keys(raw).map(k => raw[k]).sort((a, b) => a.rank - b.rank).forEach(e => {
      const code = wantCodeOf(e['신청'] || '');
      const from = parseInt(e['시작'], 10) - 1;
      const end = parseInt(e['끝'], 10) - 1;
      const label = e.rank + '순위';
      const note = String(e['메모'] || '').trim();
      if (!code && isNaN(from) && isNaN(end)) {   // 비워 둔 순위 (메모만 적었으면 알려 줌)
        if (note) incomplete.push(label + ' 날짜·신청 없이 메모만 적음: ' + note);
        return;
      }
      if (!code || isNaN(from) || from < 0) { incomplete.push(label + ' ' + (code ? '시작 날짜가' : '신청이') + ' 빠짐'); return; }
      if (end < from) incomplete.push(label + ' 끝 날짜가 시작 날짜보다 빠름 (시작 날짜 하루만 넣음)');
      const to = isNaN(end) || end < from || WANT_ONE_DAY.indexOf(code) >= 0 ? from : end;
      entries.push({ from, to, code, rank: e.rank, note });
    });
    entries.forEach(e => {
      for (let d = e.from; d <= e.to; d++) {
        if (codes[d] && ranks[d] <= e.rank) continue;
        codes[d] = e.code; ranks[d] = e.rank; notes[d] = e.note;
      }
    });
    const conds = Object.keys(cond).map(k => cond[k]).filter(c => c.days.length && c.kind && c.codes.length);
    const time = r.getTimestamp().getTime();
    if (time > deadline + 60000) return;   // 마감 뒤 응답 (1분 여유)
    for (let d = 0; d < codes.length; d++) { codes[d] = codes[d] || ''; ranks[d] = ranks[d] || 0; notes[d] = notes[d] || ''; }
    if (name && (!latest[name] || latest[name].time < time))
      latest[name] = { time, codes, ranks, notes, entries, incomplete, conds, memo: String(memo || '').trim() };
  });
  return latest;
}

/** 설문 조건·3순위를 [원티드해석]에 옮김. G열이 "설문"인 줄만 새로 쓰고, 직접 적은 줄은 그대로 둠. */
function syncWishes(ss, wants) {
  const sh = ss.getSheetByName(WISH_SHEET);
  if (!sh) return;
  const last = sh.getLastRow();
  const keep = last > 1 ? sh.getRange(2, 1, last - 1, 7).getValues()
    .filter(r => String(r[6]).trim() !== '설문' && r.slice(0, 6).some(v => String(v).trim() !== '')) : [];
  const fromForm = [].concat.apply([], Object.keys(wants).map(n =>
    condRows(n, wants[n].conds || []).concat(rank3Rows(n, wants[n]))));
  const rows = keep.concat(fromForm);
  if (last > 1) sh.getRange(2, 1, last - 1, 7).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 7).setValues(rows);
}

// ---------- 원티드: 현황 ----------
function refreshWantedStatus() {
  const ss = SpreadsheetApp.getActive();
  const wants = readWantedResponses();
  if (!wants) {
    ss.toast('먼저 [① 원티드 설문 만들기]를 실행하세요.', '원티드', 6);
    return;
  }
  syncWishes(ss, wants);
  const blocks = readBoth();
  const tz = ss.getSpreadsheetTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, 'M/d HH:mm');
  const props = PropertiesService.getDocumentProperties();
  const dl = Number(props.getProperty('wantedDeadline'));
  const dlText = dl ? fmtDeadline(new Date(dl)) + (Date.now() > dl ? ' (마감됨)' : '') : '';
  const main = ss.getSheetByName(STATUS_SHEET) || ss.insertSheet(STATUS_SHEET);
  const t = buildStatus(blocks, wants, true, stamp, dlText);
  writeStatus(main, t);
  main.setTabColor(t.conflicts.length ? '#cc0000' : TAB_COLOR.work);   // 조정할 날이 있으면 탭을 빨갛게
  const pubId = props.getProperty('wantedPublicId');
  if (pubId) writeStatus(SpreadsheetApp.openById(pubId).getSheets()[0], buildStatus(blocks, wants, true, stamp, dlText));

  // 설문 첫 화면 설명에도 지금 넘치는 날을 띄워 신청자가 바로 알 수 있게 함
  const formId = props.getProperty('wantedFormId');
  if (formId && dl) {
    try {
      FormApp.openById(formId).setDescription(formDescription(props.getProperty('wantedLabel') || '', new Date(dl), t.conflicts,
        pubId ? SpreadsheetApp.openById(pubId).getUrl() : ''));
    } catch (e) { /* 설문을 지운 경우 */ }
  }
  try { ss.toast(t.conflicts.length ? CONFLICT_MARK + ' 신청이 넘쳐 조정이 필요한 날: ' + t.conflicts.join(' / ') + '. [원티드현황]을 확인하세요.'
    : '원티드 현황을 새로 그렸습니다. 넘치는 날은 없습니다.', '원티드', 8); } catch (e) { /* 설문 제출로 실행될 때는 화면이 없음 */ }
}

/** 현황 표 (값, 배경색, 글자색). withMemo=false면 메모·세부내용 대신 ●만 표시. conflicts = ["RN 3·12일", ..] */
function buildStatus(blocks, wants, withMemo, stamp, deadlineText) {
  const days = blocks[0].input.days;
  const W = 4 + days.length;
  const values = [], bgs = [], fonts = [];
  const row = (v, bg, fc) => {
    bg = bg || [];
    fc = fc || [];
    while (v.length < W) v.push('');
    while (bg.length < W) bg.push(null);
    while (fc.length < W) fc.push('#000000');
    values.push(v);
    bgs.push(bg);
    fonts.push(fc);
  };
  const head = '#d9e1f2', hol = '#f4cccc', red = '#ea9999', yellow = '#ffe599', alert = '#cc0000';
  const reps = blocks.map(b => ({ type: b.type, rep: wantedReport(b.input, wants) }));
  const conflicts = reps.map(x => {
    const ds = x.rep.days.map((d, k) => (d.over.length ? k + 1 : 0)).filter(Boolean);
    return ds.length ? x.type + ' ' + ds.join('·') + '일' : '';
  }).filter(Boolean);
  const people = [].concat.apply([], reps.map(x => x.rep.people.filter(p => p.conflict.some(Boolean)).map(p => p.p.name)));

  row([FORM_ORG + ' 원티드 신청 현황 (갱신 ' + stamp + (deadlineText ? ' · 마감 ' + deadlineText : '') + ')']);
  if (conflicts.length)
    row([CONFLICT_MARK + ' 신청이 넘쳐 조정이 필요한 날: ' + conflicts.join(' / ') + '  ·  조정이 필요한 분 ' + people.length + '명' +
      (withMemo ? ' (' + people.join(', ') + ')' : '') +
      '  →  ' + CONFLICT_MARK + ' 표시가 있는 분은 서로 조정해서 설문을 다시 내 주세요. 마감까지 조정이 안 되면 1순위 → 그동안 덜 받은 사람 → 먼저 낸 사람 순으로 정합니다.'],
      new Array(W).fill(red), new Array(W).fill(alert));
  else row(['✔ 지금은 신청이 넘치는 날이 없습니다.'], new Array(W).fill('#d9ead3'));
  row([RANK_LABEL[1], RANK_LABEL[2], RANK_LABEL[3], CONFLICT_MARK + ' 빨간 글씨 칸 = 신청이 넘쳐 조정이 필요한 신청 · 빨간 날짜(합계 줄) = 넘치는 날 · 노란 칸 = 확인할 점이 있음'],
    [RANK_BG[1], RANK_BG[2], RANK_BG[3]]);
  const dayRow = ['이름', '날짜 수', '확인할 점', withMemo ? '메모·세부내용' : '메모 유무'].concat(days.map(x => x.day));
  const wdRow = ['', '', '', ''].concat(days.map(x => DAY_NAMES[x.weekday]));
  const headBg = dayRow.map((_, c) => (c >= 4 && days[c - 4].holiday ? hol : head));
  row(dayRow, headBg);
  row(wdRow, headBg);

  const known = {};
  reps.forEach(({ type, rep }) => {
    row([type], new Array(W).fill('#efefef'));
    rep.people.forEach(x => {
      known[x.p.name] = true;
      const cells = x.codes.map((c, d) => (c ? (x.conflict[d] ? CONFLICT_MARK : '') + wantLabelOf(c) : x.marks[d]));
      const memoText = [x.memo].concat(x.notes).filter(Boolean).join(' / ');
      const v = [x.p.name, x.codes.filter(Boolean).length || '', x.warn.join(' / '),
        withMemo ? memoText : (memoText ? '●' : '')].concat(cells);
      // 날짜 칸 배경 = 순위 색 (1순위 주황, 2순위 파랑, 3순위 초록), 조정이 필요한 칸은 빨간 굵은 글씨
      const bg = v.map((val, c) => (c >= 4 && val ? RANK_BG[x.ranks[c - 4]] || RANK_BG[0] : null));
      const fc = v.map((_, c) => (c >= 4 && x.conflict[c - 4] ? alert : '#000000'));
      if (x.warn.length) bg[2] = yellow;
      if (x.conflict.some(Boolean)) { bg[0] = red; fc[2] = alert; }
      row(v, bg, fc);
    });
    const sum = ['오프 신청 / 가능', '', '', ''].concat(rep.days.map(d => d.offs + '/' + d.cap));
    const sumBg = sum.map((_, c) => (c >= 4 && rep.days[c - 4].over.length ? red : '#f3f3f3'));
    row(sum, sumBg);
    const overs = rep.days.map((d, k) => (d.over.length ? (k + 1) + '일 ' + d.over.join(', ') : '')).filter(Boolean);
    if (overs.length) row([CONFLICT_MARK + ' 넘치는 날', '', overs.join(' / ')], [red, null, red], [alert, null, alert]);
  });
  const unknown = Object.keys(wants).filter(n => !known[n]);
  if (unknown.length) row(['명단에 없는 이름', '', unknown.join(', ')], [null, null, yellow]);
  return { values, bgs, fonts, W, conflicts };
}

function writeStatus(sh, t) {
  sh.clear();
  sh.getRange(1, 1, t.values.length, t.W).setValues(t.values).setBackgrounds(t.bgs).setFontColors(t.fonts)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(1, 1, t.values.length, 4).setHorizontalAlignment('left');
  sh.getRange(6, 5, Math.max(1, t.values.length - 5), t.W - 4).setFontSize(9);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1).setFontWeight('bold').setFontSize(11);
  sh.getRange(4, 1, 2, t.W).setFontWeight('bold');
  sh.getRange(3, 1, 1, 3).setFontWeight('bold');
  sh.setColumnWidth(1, 150);
  sh.setColumnWidth(2, 50);
  sh.setColumnWidth(3, 200);
  sh.setColumnWidth(4, 200);
  sh.setColumnWidths(5, t.W - 4, 46);
  sh.setFrozenRows(5);
  sh.setFrozenColumns(2);
}

// ---------- 원티드: 근무표에 반영 ----------
function applyWantedDates() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const wants = readWantedResponses();
  if (!wants) { ui.alert('먼저 [① 원티드 설문 만들기]를 실행하세요.'); return; }
  const L = LAYOUT;
  const props = PropertiesService.getDocumentProperties();
  const key = monthKey();
  // 다시 누른 경우: 지난번에 넣은 칸·비고(그 뒤로 안 바뀐 것)를 먼저 되돌리고 처음부터 다시 판단
  const prevRaw = props.getProperty('wantedApplied');
  const prevApplied = prevRaw ? JSON.parse(prevRaw) : null;
  if (prevApplied && prevApplied.key === key) {
    ['RN', 'AN'].forEach(t => {
      const sh = ss.getSheetByName(t);
      prevApplied.cells.filter(c => c.type === t).forEach(c => {
        const cell = sh.getRange(c.row, L.firstDayCol + c.d);
        if (String(cell.getValue()).trim() === c.code && String(cell.getFontColor()).toLowerCase() !== AUTO_COLOR)
          cell.clearContent().setFontColor('#000000').setFontWeight('normal');
      });
      const nc = noteColumn(sh, false);
      if (nc) (prevApplied.notes || []).filter(n => n.type === t).forEach(n => {
        const cell = sh.getRange(n.row, nc);
        if (String(cell.getValue()) === n.after) cell.setValue(n.before);
      });
    });
    SpreadsheetApp.flush();
  }
  const history = rejectCounts(ss);
  let put = 0;
  const skipped = [], applied = [], allCuts = [], noteLog = [];
  readBoth().forEach(b => {
    const sh = ss.getSheetByName(b.type);
    const last = findLastStaffRow(sh);
    const rng = sh.getRange(L.firstStaffRow, L.firstDayCol, last - L.firstStaffRow + 1, b.input.days.length);
    const values = rng.getValues();
    const colors = rng.getFontColors();
    const weights = rng.getFontWeights();
    // 자동 편성 칸(파란 글씨)은 빈 칸으로 보고 겹침을 판단
    const input = Object.assign({}, b.input, { staff: b.input.staff.map(p => Object.assign({}, p, {
      codes: p.codes.map((c, d) => (String(colors[p.row - L.firstStaffRow][d]).toLowerCase() === AUTO_COLOR ? '' : c)),
    })) });
    const cuts = resolveConflicts(input, wants, history);
    cuts.forEach(c => allCuts.push(Object.assign({ type: b.type }, c)));
    const noteFor = {};   // 줄 → 비고 글
    b.input.staff.forEach(p => {
      const w = wants[p.name];
      if (!w) return;
      const r = p.row - L.firstStaffRow;
      w.codes.forEach((c, d) => {
        if (!c || d >= b.input.days.length) return;
        const rank = (w.ranks && w.ranks[d]) || 0;
        if (!isPinned(c, rank)) return;   // 근무·휴무 3순위는 [원티드해석]의 희망으로만
        if (cuts.some(x => x.name === p.name && x.d === d)) return;
        const code = codeForDay(c, b.input.days[d].holiday);
        const isAuto = String(colors[r][d]).toLowerCase() === AUTO_COLOR;
        const cur = String(values[r][d]).trim();
        if (cur && !isAuto) {
          if (cur !== code) skipped.push(p.name + ' ' + (d + 1) + '일 ' + wantLabelOf(c) + ' (이미 ' + cur + ')');
          return;
        }
        values[r][d] = code;
        colors[r][d] = RANK_FONT[rank] || RANK_FONT[0];   // 1순위 빨강, 2순위 진한 파랑, 3순위 초록
        weights[r][d] = 'bold';
        applied.push({ type: b.type, row: p.row, d, code });
        put++;
      });
      // 순위별 세부내용 + 설문 맨 아래 자유 글 → 비고
      const text = (w.entries || []).filter(e => e.note).map(entryText)
        .concat(String(w.memo || '').replace(/\s*\n\s*/g, ' / ').trim()).filter(Boolean).join(' / ');
      if (text) noteFor[p.row] = text;
    });
    rng.setValues(values);
    rng.setFontColors(colors);
    rng.setFontWeights(weights);
    // 세부내용 → 비고 열 (직접 적어 둔 글이 있으면 그 뒤에 붙임)
    const rows = Object.keys(noteFor);
    if (rows.length) {
      const nc = noteColumn(sh, true);
      rows.forEach(row => {
        const cell = sh.getRange(Number(row), nc);
        const before = String(cell.getValue()).trim();
        const after = before ? before + ' / ' + noteFor[row] : noteFor[row];
        cell.setValue(after);
        noteLog.push({ type: b.type, row: Number(row), before, after });
      });
    }
  });
  props.setProperty('wantedApplied', JSON.stringify({ key, cells: applied, notes: noteLog }));
  props.setProperty('wantedCuts', JSON.stringify({ key, cuts: allCuts }));

  // 뺀 신청은 [원티드해석]에 "희망"으로 넣어 자동 편성이 한 번 더 시도하게 함 (출처 "조정")
  const wish = ss.getSheetByName(WISH_SHEET);
  if (wish) {
    const lastW = wish.getLastRow();
    const keep = lastW > 1 ? wish.getRange(2, 1, lastW - 1, 7).getValues()
      .filter(r => String(r[6]).trim() !== '조정' && r.slice(0, 6).some(v => String(v).trim() !== '')) : [];
    const add = allCuts.filter(c => isAdjustable(c.code)).map(c => [c.name, c.d + 1, '희망', shiftLab(c.code) || c.code, c.rank || '',
      '날짜 신청 조정: ' + c.reason, '조정']);
    const rows = keep.concat(add);
    if (lastW > 1) wish.getRange(2, 1, lastW - 1, 7).clearContent();
    if (rows.length) wish.getRange(2, 1, rows.length, 7).setValues(rows);
  }

  ui.alert('원티드 반영', put + '칸을 근무표에 고정했습니다. (글자색: 1순위 빨강, 2순위 파랑, 3순위 초록)' +
    (noteLog.length ? '\n세부내용 ' + noteLog.length + '명을 근무표 맨 오른쪽 [비고] 열에 적었습니다.' : '') +
    (allCuts.length ? '\n\n같은 날 신청이 겹쳐서 고정하지 않은 신청 ' + allCuts.length + '건:\n' +
      allCuts.map(c => '· ' + c.name + ' ' + (c.d + 1) + '일 ' + wantLabelOf(c.code) + ' (' + (c.rank || '-') + '순위, 못 받은 횟수 ' + c.hist + '번)').join('\n') +
      '\n→ 자동 편성이 "희망"으로 한 번 더 시도합니다. 결과는 [검사결과]에 나옵니다.' : '') +
    (skipped.length ? '\n\n이미 다른 값이 있어 건너뛴 칸:\n' + skipped.join('\n') : '') +
    '\n\n근무·휴무 3순위는 [원티드해석]에 희망(순위 3)으로 자동으로 들어가 있습니다.' +
    '\n순위별 세부내용과 맨 아래 자유 글은 [비고] 열에 적었습니다. 자유 글에 적힌 날짜는 근무표 칸에 직접 넣어 주세요.', ui.ButtonSet.OK);
}

// ---------- 마감·보관 ----------
function monthKey() {
  const set = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  const m = Number(set.getRange('B4').getValue());
  return set.getRange('B3').getDisplayValue() + '-' + (m < 10 ? '0' : '') + m;
}

function closeMonth() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const key = monthKey();
  const archName = key + ARCHIVE_SUFFIX;
  if (ss.getSheetByName(archName)) {
    ui.alert('"' + archName + '" 탭이 이미 있습니다. 이미 마감한 달입니다.\n다시 마감하려면 그 탭을 지운 뒤 실행하세요.');
    return;
  }
  const a = ui.alert('이번 달 마감·보관',
    key + ' 근무표를 보관하고 다음 달로 넘깁니다.\n\n' +
    '· RN·AN을 [' + archName + '] 탭에 값과 색만 남겨 보관 (비고 포함)\n' +
    '· 이번 달 원티드를 [' + LOG_SHEET + ']에 추가\n' +
    '· RN·AN 날짜 칸·비고, [원티드해석], [원티드현황]을 비우고 설정의 월을 다음 달로\n' +
    '· 이번 달 마지막 5일은 다음 달 "전월 말" 칸으로 옮김\n\n' +
    '근무표가 확정된 게 맞나요?', ui.ButtonSet.OK_CANCEL);
  if (a !== ui.Button.OK) return;

  const snapRN = loadSnapshot('RN');
  if (!snapRN || snapRN.key !== key) {
    const c = ui.alert('확정 안 됨', '아직 [⑤ 근무표 확정]을 하지 않았습니다. 확정 없이 보관할까요?', ui.ButtonSet.OK_CANCEL);
    if (c !== ui.Button.OK) return;
  }
  // 확정 후 기록하지 않은 수정이 있으면 먼저 남김
  recordChanges('보관 전 자동 기록 (사유 미기재)');

  const L = LAYOUT;
  const blocks = readBoth();
  const wants = readWantedResponses() || {};

  // 1) 보관 탭: 수식·조건부서식 없이 값과 색만
  const arch = ss.insertSheet(archName, ss.getSheets().length);
  let top = 1;
  blocks.forEach(b => {
    const sh = ss.getSheetByName(b.type);
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    const src = sh.getRange(1, 1, lastRow, lastCol);
    const dst = arch.getRange(top, 1, lastRow, lastCol);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    arch.getRange(top + 1, 1).setValue('보관본입니다. 수정하지 마세요.');
    const n = findLastStaffRow(sh) - L.firstStaffRow + 1;
    const grid = arch.getRange(top + L.firstStaffRow - 1, L.prevCol, n, L.prevDays + L.maxDays);
    const vals = grid.getDisplayValues();
    const fonts = sh.getRange(L.firstStaffRow, L.prevCol, n, L.prevDays + L.maxDays).getFontColors();
    grid.setBackgrounds(vals.map(r => r.map((v, c) => CODE_COLORS[v] || (c < L.prevDays ? '#efefef' : null))));
    grid.setFontColors(plainFonts(vals, fonts));
    const kinds = sh.getRange(L.kindRow, L.firstDayCol, 1, L.maxDays).getDisplayValues()[0];
    const head = kinds.map(k => (k === '휴일' ? '#f4cccc' : '#d9e1f2'));
    arch.getRange(top + L.dateRow - 1, L.firstDayCol, 3, L.maxDays).setBackgrounds([head, head, head]);
    if (top === 1) for (let c = 1; c <= lastCol; c++) arch.setColumnWidth(c, sh.getColumnWidth(c));
    top += lastRow + 3;
  });
  arch.clearConditionalFormatRules();
  arch.getDataRange().clearDataValidations();
  arch.setFrozenColumns(3);
  arch.protect().setDescription('보관본: 수정하지 마세요').setWarningOnly(true);

  // 2) 원티드 기록
  const log = ss.getSheetByName(LOG_SHEET) || createLogSheet(ss);
  log.getRange(1, 10, 1, 2).setValues([['순위', '거절 사유']]).setFontWeight('bold').setBackground('#d9e1f2');
  const textKey = "'" + key;   // "2026-11"이 날짜로 바뀌지 않게
  const rows = [].concat.apply([], blocks.map(b => buildLogRows(textKey, b.type, b.input, wants, loadCuts(b.type))));
  if (rows.length) log.getRange(log.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  refreshRejectSummary();

  // 2-1) 근무 부담 기록 (요약 탭은 이 기록을 수식으로 합산)
  const load = ss.getSheetByName(LOAD_SHEET);
  if (load) {
    const lr = [].concat.apply([], blocks.map(b => buildLoadRows(textKey, b.type, b.input)));
    if (lr.length) load.getRange(load.getLastRow() + 1, 1, lr.length, lr[0].length).setValues(lr);
  }

  // 2-2) 휴대폰에서 바로 받는 xlsx 링크
  arch.getRange(2, 20).setFormula('=HYPERLINK("https://docs.google.com/spreadsheets/d/' + ss.getId() +
    '/export?format=xlsx&gid=' + arch.getSheetId() + '","▶ 이 근무표 xlsx 내려받기")');

  // 3) 다음 달 준비 (이번 달에 전출·전역한 사람은 명단에서 뺌)
  const gone = [];
  blocks.forEach(b => {
    const sh = ss.getSheetByName(b.type);
    const last = findLastStaffRow(sh);
    const n = last - L.firstStaffRow + 1, nd = b.input.days.length;
    const dayRng = sh.getRange(L.firstStaffRow, L.firstDayCol, n, L.maxDays);
    const vals = dayRng.getValues();
    sh.getRange(L.firstStaffRow, L.prevCol, n, L.prevDays).setValues(vals.map(r => r.slice(nd - L.prevDays, nd)));
    dayRng.clearContent();
    dayRng.setFontColor('#000000').setFontWeight('normal');
    const nc = noteColumn(sh, false);
    if (nc) sh.getRange(L.firstStaffRow, nc, n, 1).clearContent();
    clearMarks(sh, last);
    b.input.staff.forEach(p => {
      if (p.codes.indexOf('출') >= 0 || p.codes.indexOf('역') >= 0) {
        sh.getRange(p.row, 1, 1, L.prevCol + L.prevDays - 1).clearContent();
        gone.push(p.name);
      }
    });
    sh.getRange(1, 20).clearContent();
    PropertiesService.getDocumentProperties().deleteProperty('snap_' + b.type);
  });
  const wish = ss.getSheetByName(WISH_SHEET);
  if (wish && wish.getLastRow() > 1) wish.getRange(2, 1, wish.getLastRow() - 1, wish.getLastColumn()).clearContent();
  [STATUS_SHEET, RESULT_SHEET].forEach(n => { const s = ss.getSheetByName(n); if (s) s.clear(); });

  const props = PropertiesService.getDocumentProperties();
  const formId = props.getProperty('wantedFormId');
  if (formId) {
    try { FormApp.openById(formId).setAcceptingResponses(false); } catch (e) { /* 설문을 지운 경우 */ }
  }
  ['wantedFormId', 'wantedPublicId', 'wantedDeadline', 'wantedLabel', 'wantedCuts', 'wantedApplied'].forEach(k => props.deleteProperty(k));
  deleteTriggers('onWantedSubmit');
  deleteTriggers('closeWantedForm');

  const set = ss.getSheetByName(SETTINGS_SHEET);
  let y = Number(set.getRange('B3').getValue()), m = Number(set.getRange('B4').getValue()) + 1;
  if (m > 12) { m = 1; y++; }
  set.getRange('B3').setValue(y);
  set.getRange('B4').setValue(m);
  set.getRange('B5').setValue(0);
  arrangeTabs();

  ui.alert('마감 완료',
    '[' + archName + '] 탭에 보관했고, 원티드 ' + rows.length + '줄을 [' + LOG_SHEET + ']에 추가했습니다.\n' +
    '이제 ' + y + '년 ' + m + '월입니다.\n' +
    (gone.length ? '전출·전역으로 명단에서 뺀 사람: ' + gone.join(', ') + '\n' : '') +
    '\n다음 할 일: [📌 사용법]의 "명단 바꾸기"대로 전입자 추가·그룹 변경을 하고, 설정의 추가 휴무·공휴일을 확인한 뒤 [① 원티드 설문 만들기].',
    ui.ButtonSet.OK);
}

// ---------- 확정·수정 기록 ----------
// 확정한 근무표를 문서 속성에 저장해 두고, 이후 수정은 그 저장본과 비교해 [근무표 변경 기록]에 쌓음.

function currentCodes(input) {
  const m = {};
  input.staff.forEach(p => { m[p.name] = p.codes; });
  return m;
}

function loadSnapshot(type) {
  const raw = PropertiesService.getDocumentProperties().getProperty('snap_' + type);
  return raw ? JSON.parse(raw) : null;   // { key, version, at, codes: {이름: [..]} }
}

function saveSnapshot(type, snap) {
  PropertiesService.getDocumentProperties().setProperty('snap_' + type, JSON.stringify(snap));
}

function changeSheet(ss) {
  let s = ss.getSheetByName(CHANGE_SHEET);
  if (!s) {
    s = ss.insertSheet(CHANGE_SHEET);
    s.getRange(1, 1, 1, 9).setValues([['기록 시각', '월', '버전', '구분', '이름', '날짜', '이전', '이후', '사유']])
      .setFontWeight('bold').setBackground('#d9e1f2');
    s.setFrozenRows(1);
    s.protect().setDescription('근무표 변경 기록: 수정하지 마세요').setWarningOnly(true);
  }
  return s;
}

/** RN·AN 제목 줄에 지금 버전 표시 */
function markVersion(ss, type, snap) {
  const tz = ss.getSpreadsheetTimeZone();
  ss.getSheetByName(type).getRange(1, 20)
    .setValue('확정 v' + snap.version + ' · ' + Utilities.formatDate(new Date(snap.at), tz, 'M/d HH:mm'))
    .setFontWeight('bold').setFontColor('#cc0000');
}

function confirmRoster() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const key = monthKey();
  const old = loadSnapshot('RN');
  if (old && old.key === key) {
    ui.alert('이미 확정한 근무표입니다 (v' + old.version + ').\n고친 내용이 있으면 [⑥ 수정 사항 기록]을 눌러 주세요.');
    return;
  }
  const a = ui.alert('근무표 확정', key + ' 근무표를 지금 상태로 확정(v1)합니다.\n' +
    '이후에 고치면 [⑥ 수정 사항 기록]으로 무엇이 바뀌었는지 남길 수 있습니다.', ui.ButtonSet.OK_CANCEL);
  if (a !== ui.Button.OK) return;
  const log = changeSheet(ss);
  const now = new Date();
  const tz = ss.getSpreadsheetTimeZone();
  readBoth().forEach(b => {
    const snap = { key, version: 1, at: now.getTime(), codes: currentCodes(b.input) };
    saveSnapshot(b.type, snap);
    markVersion(ss, b.type, snap);
    log.appendRow([Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'), "'" + key, 'v1', b.type, '', '', '', '', '확정 (최초 공지본)']);
  });
  ui.alert('확정했습니다 (v1). 근무표 오른쪽 위에 버전이 표시됩니다.');
}

/** 확정본과 비교해 바뀐 칸을 기록. reason이 없으면 사유를 물어봄. 반환: 기록한 칸 수 */
function recordChanges(reason) {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  const key = monthKey();
  const blocks = readBoth();
  const diffs = blocks.map(b => {
    const snap = loadSnapshot(b.type);
    return { b, snap, rows: snap && snap.key === key ? diffRoster(snap.codes, currentCodes(b.input)) : null };
  });
  if (diffs.some(x => !x.rows)) {
    if (typeof reason !== 'string') ui.alert('아직 확정하지 않았습니다. 먼저 [⑤ 근무표 확정]을 눌러 주세요.');
    return 0;
  }
  const total = diffs.reduce((s, x) => s + x.rows.length, 0);
  if (!total) {
    if (typeof reason !== 'string') ui.alert('확정본과 달라진 칸이 없습니다.');
    return 0;
  }
  if (typeof reason !== 'string') {
    const preview = [].concat.apply([], diffs.map(x => x.rows.map(r =>
      x.b.type + ' ' + r[0] + ' ' + r[1] + '일: ' + (r[2] || '빈칸') + ' → ' + (r[3] || '빈칸')))).slice(0, 15).join('\n');
    const res = ui.prompt('수정 사항 기록',
      total + '칸이 바뀌었습니다.\n' + preview + (total > 15 ? '\n…' : '') + '\n\n바꾼 이유를 적어 주세요 (예: 김슬기 진료로 1:1 교환).',
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return 0;
    reason = res.getResponseText();
  }
  const log = changeSheet(ss);
  const now = new Date();
  const stamp = Utilities.formatDate(now, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  diffs.forEach(x => {
    if (!x.rows.length) return;
    const version = x.snap.version + 1;
    const rows = x.rows.map(r => [stamp, "'" + key, 'v' + version, x.b.type, r[0], r[1], r[2], r[3], reason]);
    log.getRange(log.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
    const snap = { key, version, at: now.getTime(), codes: currentCodes(x.b.input) };
    saveSnapshot(x.b.type, snap);
    markVersion(ss, x.b.type, snap);
  });
  ss.toast(total + '칸을 [' + CHANGE_SHEET + ']에 기록했습니다.', '수정 사항 기록', 6);
  return total;
}

function createLogSheet(ss) {
  const s = ss.insertSheet(LOG_SHEET);
  s.getRange(1, 1, 1, 11).setValues([['월', '구분', '이름', '날짜', '종류', '신청', '실제 근무', '반영', '메모·원문', '순위', '거절 사유']])
    .setFontWeight('bold').setBackground('#d9e1f2');
  s.setFrozenRows(1);
  s.protect().setDescription('원티드 기록: 수정하지 마세요').setWarningOnly(true);
  return s;
}

/** 탭 순서와 색 정리: 사용법 → 작업 탭(파랑) → 원티드 기록(초록) → 보관 근무표(회색, 최신 먼저) → 설문 응답(회색) */
function arrangeTabs() {
  const ss = SpreadsheetApp.getActive();
  const current = ss.getActiveSheet();
  const work = ['RN', 'AN', STATUS_SHEET, WISH_SHEET, SETTINGS_SHEET, RESULT_SHEET];
  const sheets = ss.getSheets();
  const byNameDesc = (a, b) => (a.getName() < b.getName() ? 1 : -1);
  const archives = sheets.filter(s => /^\d{4}-\d{2} 근무표$/.test(s.getName())).sort(byNameDesc);
  const responses = sheets.filter(s => archives.indexOf(s) < 0 && (s.getName().indexOf(RESP_PREFIX) === 0 || s.getFormUrl())).sort(byNameDesc);
  let pos = 1;
  const place = (s, color) => {
    if (!s) return;
    ss.setActiveSheet(s);
    ss.moveActiveSheet(pos++);
    s.setTabColor(color);
  };
  place(ss.getSheetByName(GUIDE_SHEET), TAB_COLOR.guide);
  place(ss.getSheetByName(RULES_SHEET), TAB_COLOR.guide);
  work.forEach(n => place(ss.getSheetByName(n), TAB_COLOR.work));
  [CHANGE_SHEET, LOAD_SUMMARY_SHEET, LOAD_SHEET, REJECT_SHEET, LOG_SHEET].forEach(n => place(ss.getSheetByName(n), TAB_COLOR.log));
  archives.concat(responses).forEach(s => place(s, TAB_COLOR.archive));
  ss.setActiveSheet(current);
}
