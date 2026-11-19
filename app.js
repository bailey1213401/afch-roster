/* 응급실 근무표 홈페이지
 * 편성·검사 로직은 core.js (구글 시트의 Code.gs와 같은 파일)를 그대로 씁니다.
 * 저장: Supabase (로그인한 사람만) 또는 시험 모드(이 PC 브라우저에만).
 */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TYPES = ['RN', 'AN'];
  const CODE_LIST = ['D', 'C', '1', '1비', 'E', 'E비', 'eE', 'LE', 'N', '휴', '정', '정A', '정P', '청', '공', '포', '교', '훈', 'TS', '파', '입', '역', '출'];
  const META_FONT = { a: '#1155cc', 1: '#cc0000', 2: '#0b5394', 3: '#38761d' };
  const RN_GROUP_LIST = ['시니어', '중간', '막내', '실습'];
  const AN_GROUP_LIST = ['주무관', '의무병'];

  // ---------------------------------------------------------------- 저장소
  function makeStore() {
    if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase) {
      const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') setTimeout(() => pwDialog(true), 0); });
      return {
        local: false,
        sb,
        async setPassword(pw) { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; },
        async resetMail(email) {
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
          if (error) throw error;
        },
        async session() { const { data } = await sb.auth.getSession(); return data.session; },
        async login(email, pw) { const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) throw error; },
        async logout() { await sb.auth.signOut(); },
        async load(key) {
          const { data, error } = await sb.from('roster_kv').select('value,updated_at').eq('key', key).maybeSingle();
          if (error) throw error;
          return data ? { value: data.value, at: data.updated_at } : null;
        },
        async save(key, value, at, by) {
          const now = new Date().toISOString();
          if (at) {
            const { data, error } = await sb.from('roster_kv').update({ value, updated_at: now, updated_by: by })
              .eq('key', key).eq('updated_at', at).select('updated_at');
            if (error) throw error;
            if (!data || !data.length) { const e = new Error('conflict'); e.conflict = true; throw e; }
            return data[0].updated_at;
          }
          const { data, error } = await sb.from('roster_kv').insert({ key, value, updated_at: now, updated_by: by }).select('updated_at');
          if (error) { if (error.code === '23505') { const e = new Error('conflict'); e.conflict = true; throw e; } throw error; }
          return data[0].updated_at;
        },
        async log(by, key, note) { await sb.from('roster_log').insert({ by, key, note }); },
        async logs(n) {
          const { data, error } = await sb.from('roster_log').select('at,by,key,note').order('id', { ascending: false }).limit(n);
          if (error) throw error; return data;
        },
        async snaps() {
          const { data, error } = await sb.from('roster_kv').select('key,updated_at,updated_by,label:value->>label')
            .like('key', 'snap:%').order('updated_at', { ascending: false }).limit(200);
          if (error) throw error;
          return data.map(r => ({ key: r.key, at: r.updated_at, by: r.updated_by, label: r.label }));
        },
        async inbox(month) {
          const { data, error } = await sb.from('roster_wish_inbox').select('*').eq('month', month).order('id', { ascending: true });
          if (error) throw error; return data;
        },
        async inboxDone(id, by) { const { error } = await sb.from('roster_wish_inbox').update({ done: true, done_by: by }).eq('id', id); if (error) throw error; },
        async inboxDelete(id) { const { error } = await sb.from('roster_wish_inbox').delete().eq('id', id); if (error) throw error; },
      };
    }
    const P = 'afch-roster:';
    const get = k => { try { return JSON.parse(localStorage.getItem(P + k)); } catch (e) { return null; } };
    const put = (k, v) => { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) { alert('브라우저에 저장하지 못했습니다: ' + e.message); } };
    return {
      local: true,
      async setPassword() { throw new Error('시험 모드에는 비밀번호가 없습니다'); },
      async resetMail() { throw new Error('시험 모드에는 비밀번호가 없습니다'); },
      async session() { return { user: { email: '시험 모드' } }; },
      async login() {}, async logout() {},
      async load(key) { return get(key); },
      async save(key, value) { const at = new Date().toISOString(); put(key, { value, at }); return at; },
      async log(by, key, note) { const l = get('__log') || []; l.unshift({ at: new Date().toISOString(), by, key, note }); put('__log', l.slice(0, 500)); },
      async logs(n) { return (get('__log') || []).slice(0, n); },
      async snaps() {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(P + 'snap:') === 0) { const v = get(k.slice(P.length)); if (v) out.push({ key: k.slice(P.length), at: v.at, by: v.value.by, label: v.value.label }); }
        }
        return out.sort((a, b) => (a.at < b.at ? 1 : -1));
      },
      async inbox(month) { return (get('inbox') || []).filter(x => x.month === month); },
      async inboxDone(id, by) { const l = get('inbox') || []; l.forEach(x => { if (x.id === id) { x.done = true; x.done_by = by; } }); put('inbox', l); },
      async inboxDelete(id) { put('inbox', (get('inbox') || []).filter(x => x.id !== id)); },
    };
  }
  const store = makeStore();

  // ---------------------------------------------------------------- 상태
  const S = { user: '', tab: 'RN', config: null, rosters: {}, wishes: [], at: {}, check: {}, dirty: {}, saving: false };

  function defaultConfig() {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return {
      year: d.getFullYear(), month: d.getMonth() + 1, extraOff: 0, holidays: [],
      need: { rnDay: [5, 4], rnEve: [6, 5], rnEveMin: [6, 5], rnNight: [3, 3], rnNightMin: [3, 3], anDay: [2, 2], anEve: [3, 3], anNight: [1, 1] },
      pairs: [], duty: [], exceptions: [],
    };
  }
  const monthKey = () => S.config.year + '-' + String(S.config.month).padStart(2, '0');

  function monthDays() {
    const y = S.config.year, m0 = S.config.month - 1;
    const n = new Date(y, m0 + 1, 0).getDate();
    const hol = {};
    (S.config.holidays || []).forEach(h => { hol[String(h.date).trim()] = h.name || '공휴일'; });
    const days = [];
    for (let d = 1; d <= n; d++) {
      const dt = new Date(y, m0, d), w = dt.getDay();
      const iso = y + '-' + String(m0 + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      days.push({ day: d, weekday: w, holiday: w === 0 || w === 6 || !!hol[iso], holName: hol[iso] || '' });
    }
    return days;
  }
  const offTargetOf = days => days.filter(x => x.holiday).length + (Number(S.config.extraOff) || 0);

  function parseExceptions(type) {
    return (S.config.exceptions || []).filter(r => r.type === type && r.name && r.allowed).map(r => {
      const toks = String(r.when || '').split(/[,·\s]+/).filter(Boolean);
      const wd = toks.map(x => WEEKDAY_KO.indexOf(x.replace('요일', ''))).filter(x => x >= 0);
      const kind = toks.indexOf('평일') >= 0 ? '평일' : toks.indexOf('휴일') >= 0 ? '휴일' : '';
      return { type, name: r.name, from: r.from || '', to: r.to || '', when: r.when || '',
        weekdays: wd.length ? wd : [0, 1, 2, 3, 4, 5, 6], kind,
        allowed: String(r.allowed).replace(/\s/g, '').replace(/오프/g, '휴'), memo: r.memo || '' };
    });
  }

  /** core.js 함수가 받는 입력 모양으로 만듦 */
  function buildInput(type) {
    const days = monthDays();
    const ro = S.rosters[type];
    const staff = ro.staff.map((p, k) => ({
      row: LAYOUT.firstStaffRow + k, group: p.group, role: p.role, name: p.name,
      prev: (p.prev || []).slice(0, 5).concat(['', '', '', '', '']).slice(0, 5),
      codes: p.codes.slice(0, days.length).concat(Array(days.length).fill('')).slice(0, days.length),
    }));
    const prefs = [];
    (S.wishes || []).forEach(w => {
      const name = w.name && findStaffName(staff, String(w.name).trim());
      const d = parseInt(w.day, 10) - 1;
      const code = String(w.code || '').trim() === '오프' ? '휴' : String(w.code || '').trim();
      if (!name || isNaN(d) || d < 0 || d >= days.length || (w.kind !== '희망' && w.kind !== '금지') || !code) return;
      prefs.push({ name, d, kind: w.kind, code, rank: parseInt(w.rank, 10) || 0, src: '홈페이지', origin: '' });
    });
    const excepts = expandExceptions(parseExceptions(type), S.config.year, S.config.month - 1, days);
    return {
      type, days, staff, need: S.config.need, offTarget: offTargetOf(days), prefs,
      pairs: (S.config.pairs || []).filter(r => r.type === type && r.a && r.b).map(r => [r.a, r.b]),
      duty: (S.config.duty || []).filter(r => r.type === type && r.name).map(r => {
        const base = Number(r.base) || 0; return { type, name: r.name, base, max: Math.max(base, Number(r.max) || base), memo: r.memo || '' };
      }),
      excepts,
    };
  }

  // ---------------------------------------------------------------- 불러오기·저장
  const keyOf = { config: 'config', RN: 'roster:RN', AN: 'roster:AN', wishes: 'wishes' };

  async function loadAll() {
    busy('불러오는 중…');
    try {
      const [c, rn, an, w] = await Promise.all(['config', 'roster:RN', 'roster:AN', 'wishes'].map(k => store.load(k)));
      S.config = c ? c.value : defaultConfig(); S.at.config = c ? c.at : null;
      S.rosters.RN = rn ? rn.value : { month: '', staff: [] }; S.at.RN = rn ? rn.at : null;
      S.rosters.AN = an ? an.value : { month: '', staff: [] }; S.at.AN = an ? an.at : null;
      S.wishes = w ? (w.value.list || []) : []; S.at.wishes = w ? w.at : null;
      TYPES.forEach(t => normalizeRoster(S.rosters[t]));
      S.check = {}; S.dirty = {};
    } finally { idle(); }
    render();
  }

  function normalizeRoster(ro) {
    ro.staff = ro.staff || [];
    ro.staff.forEach(p => {
      p.prev = (p.prev || []).concat(['', '', '', '', '']).slice(0, 5);
      p.codes = (p.codes || []).concat(Array(31).fill('')).slice(0, 31);
      p.meta = (p.meta || []).concat(Array(31).fill('')).slice(0, 31);
    });
  }

  let saveTimer = null;
  function markDirty(part) { S.dirty[part] = true; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); }

  async function flush() {
    if (S.saving) { saveTimer = setTimeout(flush, 500); return; }
    const parts = Object.keys(S.dirty).filter(k => S.dirty[k]);
    if (!parts.length) return;
    S.saving = true;
    try {
      for (const part of parts) {
        S.dirty[part] = false;
        const val = part === 'wishes' ? { list: S.wishes } : part === 'config' ? S.config : S.rosters[part];
        try {
          S.at[part] = await store.save(keyOf[part], val, S.at[part], S.user);
        } catch (e) {
          if (e.conflict) {
            alert('다른 사람이 먼저 고친 내용이 있습니다. 최신 내용을 다시 불러옵니다.\n(방금 고친 칸은 다시 입력해 주세요)');
            await loadAll(); return;
          }
          S.dirty[part] = true;
          toast('저장 실패: ' + e.message);
        }
      }
    } finally { S.saving = false; }
  }

  function log(key, note) { store.log(S.user, key, note).catch(() => {}); }
  window.addEventListener('beforeunload', e => { if (Object.values(S.dirty).some(Boolean)) { flush(); e.preventDefault(); e.returnValue = ''; } });

  // ---------------------------------------------------------------- 화면 공통
  function busy(text, sub) { $('#overlayText').textContent = text; $('#overlaySub').textContent = sub || ''; $('#overlay').classList.remove('hidden'); }
  function idle() { $('#overlay').classList.add('hidden'); }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  const TABS = [
    ['RN', 'RN 근무표'], ['AN', 'AN 근무표'], ['check', '검사결과'], ['wish', '원티드'],
    ['rules', '규칙·예외'], ['logic', '편성 로직'], ['settings', '설정'], ['ver', '버전 기록'], ['log', '변경 기록'], ['help', '사용 설명서'],
  ];

  function render() {
    $('#monthLabel').textContent = S.config.year + '년 ' + S.config.month + '월';
    $('#tabs').innerHTML = TABS.map(([k, l]) => '<button data-tab="' + k + '" class="' + (S.tab === k ? 'on' : '') + '">' + l + '</button>').join('');
    const v = $('#view');
    if (S.tab === 'RN' || S.tab === 'AN') v.innerHTML = rosterView(S.tab);
    else if (S.tab === 'check') v.innerHTML = checkView();
    else if (S.tab === 'wish') v.innerHTML = wishView();
    else if (S.tab === 'rules') v.innerHTML = rulesView();
    else if (S.tab === 'logic') v.innerHTML = logicView();
    else if (S.tab === 'settings') v.innerHTML = settingsView();
    else if (S.tab === 'log') { v.innerHTML = '<div class="card">불러오는 중…</div>'; logView(); }
    else if (S.tab === 'help') v.innerHTML = helpView();
    else if (S.tab === 'ver') { v.innerHTML = '<div class="card">불러오는 중…</div>'; verView(); }
    if (tour.on) placeTour();
  }

  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; S.tab = b.dataset.tab; closePicker(); render(); });

  // ---------------------------------------------------------------- 사용 설명서
  function helpView() {
    const sec = (t, body) => '<div class="card help"><h2>' + t + '</h2>' + body + '</div>';
    return '<div class="bar"><button class="primary" data-act="tour">▶ 따라하기 (화면을 눌러 가며 배우기)</button>' +
      '<span class="note">처음이면 따라하기를 먼저 해 보세요. 언제든 위쪽 [따라하기] 버튼으로 다시 볼 수 있습니다.</span></div>' +
      sec('한 달 근무표 만드는 순서',
        '<ol>' +
        '<li><b>설정</b> 탭: 연도·월, 공휴일, 필요 인원, 추가 휴무를 확인합니다.</li>' +
        '<li><b>RN/AN 근무표</b> 탭 → [인원 편집]: 전입·전출, 그룹(시니어·중간·막내·실습), 직책(선임·차선임)을 맞춥니다.</li>' +
        '<li><b>꼭 들어줘야 하는 것</b>(휴가·교육·확정된 원티드)은 근무표 칸을 눌러 <b>직접 넣습니다</b>. 원티드면 [원티드 순위]도 고릅니다. 이 칸은 자동 편성이 절대 바꾸지 않습니다.</li>' +
        '<li><b>원티드</b> 탭 → [○○년 ○월 원티드 받기]: 나온 링크(또는 단톡방 문구)를 단톡방에 올립니다. 모인 원티드는 [표에 넣기]로 원티드 표에 넣습니다. 순위가 높을수록 더 잘 지켜 줍니다.</li>' +
        '<li><b>규칙·예외</b> 탭: 같이 근무하면 안 되는 짝, 일직 횟수, 대학원·임부 같은 개인 예외를 적습니다.</li>' +
        '<li>근무표 탭에서 시간(1분 권장)을 고르고 <b>[RN 자동 편성]</b> / <b>[AN 자동 편성]</b>을 누릅니다. 끝날 때까지 창을 닫지 마세요.</li>' +
        '<li><b>[규칙 검사]</b>로 빨간 테두리 칸을 확인하고, 칸을 눌러 손으로 고칩니다. 원티드를 바꿨으면 다시 자동 편성을 돌려도 됩니다 (손으로 넣은 칸은 그대로).</li>' +
        '<li><b>[xlsx 내려받기]</b> → RN·AN·검사결과·편성 로직 4개 탭이 든 파일이 받아집니다. 메일에 첨부하세요.</li>' +
        '</ol>') +
      sec('칸 고치기',
        '<ul><li>칸을 누르면 코드 단추가 뜹니다. 누르면 바로 저장됩니다.</li>' +
        '<li>원티드로 확정된 칸은 <b>원티드 순위</b>(1·2·3)를 먼저 고르고 코드를 누르세요. 글자 색이 바뀝니다.</li>' +
        '<li>[지우기]는 빈 칸으로 만듭니다. 빈 칸은 다음 자동 편성 때 채워집니다.</li>' +
        '<li>맨 왼쪽 회색 5칸은 <b>지난달 마지막 5일</b>입니다. 연속 근무·밤번 뒤 휴무 검사에 쓰입니다.</li></ul>') +
      sec('글자색·배경색 뜻',
        '<div class="legend" style="font-size:13px">' +
        '<span><b style="color:#1155cc">D</b>파란 글씨 = 자동 편성 (다시 돌리면 바뀜)</span>' +
        '<span><b>D</b>검정 = 직접 넣은 칸 (안 바뀜)</span>' +
        '<span><b style="color:#cc0000">휴</b>빨강 = 원티드 1순위</span><span><b style="color:#0b5394">휴</b>남색 = 2순위</span><span><b style="color:#38761d">휴</b>초록 = 3순위</span>' +
        '<span><b style="color:#ff0000;font-weight:700">N</b>밤번</span>' +
        '<span><b style="background:#ffff00">1</b>콜대기·청</span><span><b style="background:#c9daf8">정</b>휴가</span><span><b style="background:#b6d7a8">교</b>교육·입/출/역</span><span><b style="background:#999999">파</b>파견</span>' +
        '</div>') +
      sec('원티드 탭 vs 근무표 칸에 직접 넣기',
        '<ul><li><b>근무표 칸에 직접</b> = 무조건 지킴. 확정된 휴가·휴무·근무.</li>' +
        '<li><b>원티드 탭</b> = 가능하면 지킴. 다른 규칙(필요 인원, 밤번 간격 등)과 부딪히면 못 들어줄 수 있습니다. 1순위 &gt; 금지 &gt; 2순위 &gt; 3순위 순으로 지킵니다.</li>' +
        '<li>원티드 탭 코드는 D·E·N·휴, 여러 개면 쉼표(예: 휴,N). "금지"는 그날 그 근무를 빼 달라는 뜻입니다.</li>' +
        '<li>원티드를 고친 뒤에는 자동 편성을 다시 돌려야 반영됩니다.</li>' +
        '<li><b>신청 링크</b>는 로그인 없이 열립니다 (구글 폼 대신). 낸 사람은 남의 원티드를 볼 수 없습니다. 같은 사람이 여러 번 내면 "여러 번 냄"으로 표시되니 마지막 것만 넣고 나머지는 삭제하세요.</li>' +
        '<li>다음 달 원티드는 미리 받아 둘 수 있고, [다음 달 근무표 시작] 뒤에 표에 넣을 수 있습니다.</li></ul>') +
      sec('자동 편성이 지키는 것',
        '<p class="note" style="margin-top:0">자세한 순서와 점수는 <b>편성 로직</b> 탭에 있습니다. 요약하면:</p>' +
        '<ul><li>최우선: 근무 시간대별 필요 인원, 매일 밤번 시니어 1명, 휴일 그룹 구성</li>' +
        '<li>반드시: D→E→N 순서, 밤번 뒤 2일 휴무, 밤번 사이 ' + NIGHT_GAP + '일 이상, 4일 이상 연속 근무 뒤 휴무 2일, 휴무 개수, 휴일 1비·E비</li>' +
        '<li>되도록: 원티드, 밤번·휴일 근무 고르게</li></ul>' +
        '<p class="note">오래 돌릴수록(2분, 3분 20초) 결과가 좋아집니다. 위반이 남으면 한 번 더 돌리거나 손으로 고치세요.</p>') +
      sec('여럿이 같이 쓸 때',
        '<ul><li>고친 내용은 바로 저장되어 다른 사람 화면에도 반영됩니다. 다른 사람이 고친 걸 보려면 위쪽 <b>[새로고침]</b>을 누르세요.</li>' +
        '<li>두 사람이 동시에 같은 표를 고치면 먼저 저장된 쪽이 남고, 늦은 쪽에는 "다시 불러옵니다" 안내가 뜹니다. 방금 고친 칸만 다시 넣으면 됩니다.</li>' +
        '<li>누가(아이디) 언제 어느 칸을 무엇에서 무엇으로 바꿨는지는 <b>변경 기록</b> 탭에 남습니다.</li></ul>') +
      sec('버전 기록 (실수했을 때 되돌리기)',
        '<ul><li>창을 열고 처음 고치려고 하면 <b>"지금 상태를 버전으로 저장할까요?"</b> 창이 뜹니다. [버전 저장하고 고치기]를 누르면 고치기 전 상태가 저장됩니다.</li>' +
        '<li>자동 편성·자동 편성 지우기·백업 덮어쓰기·다음 달 시작 직전에는 묻지 않고 <b>자동으로</b> 저장됩니다.</li>' +
        '<li>중요한 수기 조정을 끝냈으면 <b>버전 기록</b> 탭에서 메모를 적고 [지금 상태를 버전으로 저장]을 눌러 두세요.</li>' +
        '<li>실수했으면 <b>버전 기록</b> 탭에서 원하는 시각의 [되돌리기]. 설정·RN·AN·원티드가 모두 그때로 돌아갑니다. 되돌리기 직전 상태도 자동 저장되니 되돌린 것을 다시 되돌릴 수 있습니다.</li>' +
        '<li>버전은 근무표와 같은 저장소(Supabase)에 저장되고, 로그인한 사람만 볼 수 있습니다.</li></ul>') +
      sec('다음 달로 넘어갈 때',
        '<ul><li><b>설정 → [다음 달 근무표 시작]</b>: 지금 달은 보관되고, 같은 인원으로 빈 근무표가 만들어집니다. 이번 달 마지막 5일은 "전월 말"로 옮겨집니다.</li>' +
        '<li>원티드 표는 비워집니다. 전출·전역(출·역)한 사람은 자동으로 빠지고, 전입자는 [인원 편집]으로 넣으세요.</li>' +
        '<li>만약을 위해 가끔 <b>설정 → [백업 파일 내려받기]</b>를 해 두세요. 백업 파일에는 이름이 들어 있으니 공용 PC에 두지 마세요.</li></ul>') +
      sec('잘 안 될 때',
        '<ul><li><b>"계속할까요?" 창 없이 아무 일도 안 일어남</b>: 확인 창을 막는 브라우저입니다. 크롬이나 엣지로 여세요.</li>' +
        '<li><b>자동 편성 중 멈춘 것 같음</b>: 고른 시간이 다 될 때까지 기다리세요. 창을 닫거나 새로고침하면 처음부터 다시 해야 합니다.</li>' +
        '<li><b>다른 사람이 고친 게 안 보임</b>: [새로고침]을 누르세요.</li>' +
        '<li><b>로그인이 안 됨</b>: 아이디(이메일)와 비밀번호를 확인하세요. 계정은 관리자가 Supabase에서 만듭니다.</li>' +
        '<li><b>비밀번호 바꾸기</b>: 로그인 뒤 위쪽 [비밀번호 변경]. 처음 받은 임시 비밀번호는 꼭 바꿔 주세요.</li>' +
        '<li><b>비밀번호를 잊음</b>: 로그인 화면에 이메일을 넣고 [비밀번호를 잊었어요] → 메일의 링크를 누르면 새 비밀번호를 정하는 창이 뜹니다. 메일이 안 오면 관리자에게 초기화를 부탁하세요.</li></ul>');
  }

  // ---------------------------------------------------------------- 따라하기
  const TOUR = [
    { tab: 'RN', sel: '#tabs', title: '위쪽 탭', text: '근무표, 원티드, 검사결과, 설정 등이 탭으로 나뉘어 있습니다. 누르면 화면이 바뀝니다.' },
    { tab: 'RN', sel: 'table.grid td.cell[data-d]', title: '칸 고치기', text: '근무표 칸을 누르면 코드 단추가 뜹니다. 지금 아무 칸이나 눌러 보세요 (닫기를 누르면 그대로).<br>확정된 원티드는 [원티드 순위]를 고르고 코드를 누르면 색 글씨로 들어가고, 자동 편성이 바꾸지 않습니다.' },
    { tab: 'RN', sel: '.legend', title: '글자색 뜻', text: '파란 글씨 = 자동 편성, 검정 = 직접 넣음, 빨강·남색·초록 = 원티드 1·2·3순위.<br>자동 편성을 다시 돌리면 <b>파란 글씨만</b> 바뀝니다.' },
    { tab: 'RN', sel: '[data-act="staff"]', title: '인원 편집', text: '전입·전출, 그룹(시니어·중간·막내), 선임·차선임을 여기서 고칩니다.' },
    { tab: 'wish', sel: '#view .card', title: '원티드 받기', text: '받을 달을 고르면 신청 링크가 나옵니다. [단톡방 문구 복사]를 눌러 단톡방에 붙여 넣으세요.<br>낸 원티드는 아래 "받은 원티드"에 모이고, [표에 넣기]를 누르면 원티드 표로 들어갑니다.' },
    { tab: 'wish', sel: '#wishTable', title: '원티드 표', text: '자동 편성이 실제로 쓰는 목록입니다. 칸을 바로 고치면 저장됩니다.<br>[줄 추가]로 직접 넣을 수도 있습니다.' },
    { tab: 'rules', sel: '#view', title: '규칙·예외', text: '같이 근무하면 안 되는 짝, 일직 횟수, 대학원·임부 같은 개인 예외를 적습니다. 다음 자동 편성부터 적용됩니다.' },
    { tab: 'RN', sel: '#genSec', title: '편성 시간 고르기', text: '오래 돌릴수록 결과가 좋습니다. 보통 1분, 위반이 남으면 2분 이상.' },
    { tab: 'RN', sel: '[data-act="generate"]', title: '자동 편성', text: '누르면 파란 글씨 칸을 지우고 새로 짭니다. 직접 넣은 칸과 원티드는 그대로입니다.<br>지금 눌러 봐도 됩니다. 끝날 때까지 창을 닫지 마세요.' },
    { tab: 'RN', sel: '[data-act="check"]', title: '규칙 검사', text: '문제가 있는 칸에 빨간 테두리가 생깁니다. 마우스를 올리면 이유가 보입니다.' },
    { tab: 'check', sel: '#view', title: '검사결과', text: 'RN·AN 문제를 한눈에 봅니다. 줄을 누르면 해당 근무표로 갑니다.' },
    { tab: 'RN', sel: '[data-act="xlsx"]', title: 'xlsx 내려받기', text: 'RN·AN·검사결과·편성 로직 4개 탭이 든 파일이 받아집니다. 메일에 첨부하세요.' },
    { tab: 'settings', sel: '#view .card:nth-of-type(4)', title: '다음 달 시작', text: '한 달이 끝나면 여기서 다음 달 근무표를 시작합니다. 지금 달은 보관됩니다.' },
    { tab: 'ver', sel: '#view', title: '버전 기록', text: '실수했을 때 되돌리는 곳입니다. 자동 편성 직전 등에는 자동으로 저장되고, 직접 메모를 달아 저장할 수도 있습니다.<br>[되돌리기]를 누르면 그때 상태로 돌아갑니다.' },
    { tab: 'log', sel: '#view', title: '변경 기록', text: '누가(아이디) 언제 어느 칸을 바꿨는지 한 줄씩 남습니다.' },
    { tab: 'RN', sel: '#btnReload', title: '새로고침', text: '다른 사람이 고친 내용을 불러옵니다. 여럿이 같이 쓸 때 눌러 주세요.' },
    { tab: 'help', sel: '#tabs button[data-tab="help"]', title: '끝', text: '자세한 설명은 [사용 설명서] 탭에 있습니다. 위쪽 [따라하기] 버튼으로 언제든 다시 볼 수 있습니다.' },
  ];
  const tour = { on: false, i: 0, spot: null, box: null };
  function startTour() {
    closePicker();
    tour.on = true; tour.i = 0;
    if (!tour.spot) {
      tour.spot = document.createElement('div'); tour.spot.className = 'tour-spot'; document.body.appendChild(tour.spot);
      tour.box = document.createElement('div'); tour.box.className = 'tour-box'; document.body.appendChild(tour.box);
      tour.box.addEventListener('click', e => {
        const b = e.target.closest('[data-tour]'); if (!b) return;
        const a = b.dataset.tour;
        if (a === 'end') endTour();
        else { tour.i += a === 'next' ? 1 : -1; if (tour.i >= TOUR.length) endTour(); else showTour(); }
      });
      window.addEventListener('resize', () => { if (tour.on) placeTour(); });
      window.addEventListener('scroll', () => { if (tour.on) placeTour(); }, true);
    }
    showTour();
  }
  function endTour() {
    tour.on = false;
    if (tour.spot) { tour.spot.style.display = 'none'; tour.box.style.display = 'none'; }
    try { localStorage.setItem('afch-roster:tourDone', '1'); } catch (e) { /* 저장 안 돼도 됨 */ }
  }
  function showTour() {
    const st = TOUR[tour.i];
    if (S.tab !== st.tab) { S.tab = st.tab; closePicker(); render(); }
    const t = document.querySelector(st.sel) || $('#view');
    t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    tour.box.innerHTML = '<div class="tour-step">' + (tour.i + 1) + ' / ' + TOUR.length + '</div><div class="tour-title">' + st.title + '</div><div>' + st.text + '</div>' +
      '<div class="bar" style="margin:12px 0 0"><button data-tour="end">그만</button><span class="sp"></span>' +
      (tour.i ? '<button data-tour="prev">이전</button>' : '') +
      '<button class="primary" data-tour="next">' + (tour.i === TOUR.length - 1 ? '끝내기' : '다음') + '</button></div>';
    tour.spot.style.display = 'block'; tour.box.style.display = 'block';
    placeTour();
  }
  function placeTour() {
    if (!tour.on) return;
    const st = TOUR[tour.i];
    const t = document.querySelector(st.sel) || $('#view');
    const r = t.getBoundingClientRect(), pad = 4;
    const vh = window.innerHeight, vw = window.innerWidth;
    const top = Math.max(0, r.top - pad), left = Math.max(0, r.left - pad);
    const h = Math.min(vh - top, r.height + pad * 2), w = Math.min(vw - left, r.width + pad * 2);
    Object.assign(tour.spot.style, { top: top + 'px', left: left + 'px', width: w + 'px', height: h + 'px' });
    const bw = Math.min(340, vw - 16);
    tour.box.style.width = bw + 'px';
    const bh = tour.box.offsetHeight;
    let bt = top + h + 10, bl = Math.min(vw - bw - 8, Math.max(8, left));
    if (h > vh * 0.5) { bt = Math.min(vh - bh - 8, Math.max(8, top) + 60); bl = vw - bw - 24; }   // 큰 영역은 오른쪽 위에
    else {
      if (bt + bh > vh - 8) bt = top - bh - 10;
      if (bt < 8) bt = Math.max(8, vh - bh - 8);
    }
    tour.box.style.top = bt + 'px'; tour.box.style.left = bl + 'px';
  }

  // ---------------------------------------------------------------- 근무표
  function cellStyle(code, meta) {
    const bg = CODE_COLORS[code] || '';
    let color = META_FONT[meta] || '#000000', weight = '';
    if (code === 'N') { color = N_FONT; weight = 'font-weight:700;'; }
    return (bg ? 'background:' + bg + ';' : '') + 'color:' + color + ';' + weight;
  }

  function checkIndex(type) {
    const idx = { cell: {}, name: {}, day: {} };
    (S.check[type] || []).forEach(f => {
      const k = f.row - LAYOUT.firstStaffRow;
      const put = (o, key) => { (o[key] = o[key] || []).push(f); };
      if (f.row === LAYOUT.weekdayRow) put(idx.day, f.col - LAYOUT.firstDayCol);
      else if (f.col === LAYOUT.nameCol) put(idx.name, k);
      else if (f.col >= LAYOUT.prevCol) put(idx.cell, k + ':' + (f.col - LAYOUT.firstDayCol));
    });
    return idx;
  }
  const lvClass = list => (list.some(f => f.level === '위반') ? 'bad' : 'warn');
  const tip = list => esc(list.map(f => '[' + f.level + '] ' + f.rule + ': ' + f.msg).join('\n'));

  function rosterView(type) {
    const ro = S.rosters[type];
    const days = monthDays();
    const n = days.length;
    const ci = checkIndex(type);
    const found = S.check[type];
    const hardN = found ? found.filter(f => f.level === '위반').length : 0;
    const warnN = found ? found.length - hardN : 0;
    let h = '<div class="bar">' +
      '<button data-act="check" data-type="' + type + '">규칙 검사</button>' +
      '<button data-act="clearAuto" data-type="' + type + '">자동 편성 지우기</button>' +
      '<select id="genSec" title="오래 돌릴수록 결과가 좋아집니다"><option value="30">30초</option><option value="60" selected>1분</option><option value="120">2분</option><option value="200">3분 20초</option></select>' +
      '<button class="primary" data-act="generate" data-type="' + type + '">' + type + ' 자동 편성</button>' +
      '<button data-act="staff" data-type="' + type + '">인원 편집</button>' +
      '<button data-act="xlsx">xlsx 내려받기</button>' +
      '<span class="sp"></span>' +
      (found ? '<span><span class="lv-위반">위반 ' + hardN + '</span> · <span class="lv-주의">주의 ' + warnN + '</span></span>' : '<span class="note">규칙 검사를 누르면 문제 칸에 빨간 테두리가 생깁니다</span>') +
      '</div>';
    h += '<div class="legend" style="margin-bottom:8px">' +
      '<span><b style="color:#1155cc">D</b>파란 글씨 = 자동 편성</span><span><b>D</b>검정 = 직접 입력</span>' +
      '<span><b style="color:#cc0000">휴</b>원티드 1순위</span><span><b style="color:#0b5394">휴</b>2순위</span><span><b style="color:#38761d">휴</b>3순위</span>' +
      '<span>칸을 누르면 코드를 고를 수 있습니다</span></div>';
    if (!ro.staff.length) return h + '<div class="card">아직 인원이 없습니다. [인원 편집]으로 사람을 넣거나 [설정]에서 데이터를 가져오세요.</div>';

    h += '<div class="mobile-hint">표를 손가락으로 좌우·위아래로 밀어 보세요 → (이름 칸은 고정)</div>';
    h += '<div class="gridwrap"><table class="grid"><thead>';
    // 1행 날짜
    h += '<tr><th class="stick" style="min-width:52px">그룹</th><th class="stick2" style="left:52px;min-width:150px">이름</th>';
    for (let i = 0; i < 5; i++) h += '<th class="note">' + (i - 5) + '</th>';
    days.forEach((x, d) => { const c = ci.day[d]; h += '<th class="' + (x.holiday ? 'hol ' : '') + (c ? 'bad' : '') + '"' + (c ? ' title="' + tip(c) + '"' : '') + '>' + x.day + '</th>'; });
    h += '<th>휴무</th><th>N</th><th>휴일</th></tr>';
    // 2행 요일
    h += '<tr><th class="stick"></th><th class="stick2" style="left:52px">전월 말 →</th>';
    for (let i = 0; i < 5; i++) h += '<th></th>';
    days.forEach(x => { h += '<th class="' + (x.holiday ? 'hol' : '') + '"' + (x.holName ? ' title="' + esc(x.holName) + '"' : '') + '>' + WEEKDAY_KO[x.weekday] + '</th>'; });
    h += '<th></th><th></th><th></th></tr>';
    // 3행 평일·휴일
    h += '<tr><th class="stick"></th><th class="stick2" style="left:52px"></th>';
    for (let i = 0; i < 5; i++) h += '<th></th>';
    days.forEach(x => { h += '<th class="' + (x.holiday ? 'hol' : '') + '" style="font-size:11px">' + (x.holiday ? '휴일' : '평일') + '</th>'; });
    h += '<th></th><th></th><th></th></tr></thead><tbody>';

    let lastGroup = null;
    ro.staff.forEach((p, k) => {
      const nameIss = ci.name[k];
      h += '<tr class="' + (lastGroup !== null && p.group !== lastGroup ? 'grp' : '') + '">';
      lastGroup = p.group;
      h += '<td class="stick">' + esc(p.group) + '</td>';
      h += '<td class="stick2 ' + (nameIss ? lvClass(nameIss) : '') + '" style="left:52px"' + (nameIss ? ' title="' + tip(nameIss) + '"' : '') + '>' +
        esc(p.name) + (p.role ? ' <span class="cnt">' + esc(p.role) + '</span>' : '') + '</td>';
      for (let i = 0; i < 5; i++) {
        const c = p.prev[i] || '', iss = ci.cell[k + ':' + (i - 5)];
        h += '<td class="cell prev ' + (iss ? lvClass(iss) : '') + '" data-k="' + k + '" data-p="' + i + '"' + (iss ? ' title="' + tip(iss) + '"' : '') + ' style="' + (c === 'N' ? 'color:' + N_FONT + ';font-weight:700' : '') + '">' + esc(c) + '</td>';
      }
      let off = 0, nN = 0, hw = 0;
      for (let d = 0; d < n; d++) {
        const c = p.codes[d] || '', m = p.meta[d] || '', x = days[d], iss = ci.cell[k + ':' + d];
        if (isOffDay(c, x.holiday)) off++;
        if (c === 'N') nN++;
        if (x.holiday && isHolidayWork(c)) hw++;
        h += '<td class="cell ' + (x.holiday ? 'hol ' : '') + (iss ? lvClass(iss) : '') + '" data-k="' + k + '" data-d="' + d + '"' +
          (iss ? ' title="' + tip(iss) + '"' : '') + ' style="' + cellStyle(c, m) + '">' + esc(c) + '</td>';
      }
      h += '<td class="cnt">' + off + '</td><td class="cnt">' + nN + '</td><td class="cnt">' + hw + '</td></tr>';
    });
    // 일별 집계
    const sumRow = (label, fn, needFn) => {
      let r = '<tr class="sum"><td class="stick"></td><td class="stick2" style="left:52px">' + label + '</td><td colspan="5"></td>';
      for (let d = 0; d < n; d++) {
        const cnt = ro.staff.filter(p => p.group !== '실습' && fn(p.codes[d] || '')).length;
        const need = needFn(days[d]);
        r += '<td class="' + (days[d].holiday ? 'hol ' : '') + (need && cnt < need ? 'short' : '') + '">' + cnt + '</td>';
      }
      return r + '<td colspan="3"></td></tr>';
    };
    const nd = S.config.need, H = x => (x.holiday ? 1 : 0);
    if (type === 'RN') {
      h += sumRow('낮번 (D·C·1·1비)', isDayShift, x => nd.rnDay[H(x)]);
      h += sumRow('초번 (E 계열)', isEveShift, x => nd.rnEveMin[H(x)]);
      h += sumRow('밤번 (N)', c => c === 'N', x => Math.min(nd.rnNight[H(x)], (nd.rnNightMin || nd.rnNight)[H(x)]));
    } else {
      h += sumRow('낮번', isDayShift, x => nd.anDay[H(x)]);
      h += sumRow('초번', isEveShift, x => nd.anEve[H(x)]);
      h += sumRow('밤번', c => c === 'N', x => nd.anNight[H(x)]);
    }
    h += '</tbody></table></div>';
    return h;
  }

  // 칸 고르기
  let pickerEl = null;
  function closePicker() { if (pickerEl) { pickerEl.remove(); pickerEl = null; } }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });

  $('#view').addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (act) { onAction(act.dataset.act, act); return; }
    const td = e.target.closest('td.cell');
    if (td && (S.tab === 'RN' || S.tab === 'AN')) { if (editAsked) openPicker(td); else beforeEdit().then(() => { if (document.body.contains(td)) openPicker(td); }); return; }
  });

  function openPicker(td) {
    closePicker();
    const type = S.tab, k = Number(td.dataset.k);
    const isPrev = td.dataset.p !== undefined;
    const d = isPrev ? Number(td.dataset.p) : Number(td.dataset.d);
    const p = S.rosters[type].staff[k];
    const cur = isPrev ? p.prev[d] : p.codes[d];
    const curMeta = isPrev ? '' : p.meta[d];
    const el = document.createElement('div');
    el.className = 'picker';
    el.innerHTML = '<div class="title">' + esc(p.name) + ' · ' + (isPrev ? '전월 ' + (d - 5) + '일' : (d + 1) + '일') + ' (지금: ' + esc(cur || '빈 칸') + ')</div>' +
      '<div class="codes">' + CODE_LIST.map(c => '<button data-code="' + esc(c) + '" style="' + cellStyle(c, '') + '">' + esc(c) + '</button>').join('') + '</div>' +
      (isPrev ? '' : '<div class="row"><span class="note">원티드 순위</span>' +
        ['', '1', '2', '3'].map(r => '<label><input type="radio" name="rk" value="' + r + '"' + ((curMeta === r || (r === '' && (curMeta === '' || curMeta === 'a'))) ? ' checked' : '') + '> ' + (r ? r + '순위' : '없음') + '</label>').join(' ') + '</div>') +
      '<div class="row"><button data-code="">지우기 (빈 칸)</button><span class="sp"></span><button data-close="1">닫기</button></div>';
    document.body.appendChild(el);
    const r = td.getBoundingClientRect();
    const left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 8, r.left - 120));
    const top = r.bottom + 6 + 280 > window.innerHeight ? Math.max(4, r.top - 290) : r.bottom + 6;
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.addEventListener('click', ev => {
      if (ev.target.closest('[data-close]')) { closePicker(); return; }
      const b = ev.target.closest('button[data-code]');
      if (!b) return;
      const code = b.dataset.code;
      const rk = el.querySelector('input[name=rk]:checked');
      const meta = code && rk ? rk.value : '';
      setCell(type, k, d, isPrev, code, meta);
      closePicker();
    });
    pickerEl = el;
  }
  document.addEventListener('mousedown', e => { if (pickerEl && !pickerEl.contains(e.target) && !e.target.closest('td.cell')) closePicker(); });

  function setCell(type, k, d, isPrev, code, meta) {
    const p = S.rosters[type].staff[k];
    const old = isPrev ? p.prev[d] : p.codes[d];
    if (isPrev) p.prev[d] = code; else { p.codes[d] = code; p.meta[d] = code ? meta : ''; }
    log(type, p.name + ' ' + (isPrev ? '전월 ' + (d - 5) : (d + 1)) + '일 ' + (old || '빈칸') + ' → ' + (code || '빈칸') + (meta ? ' (' + meta + '순위)' : ''));
    markDirty(type);
    if (S.check[type]) S.check[type] = checkRoster(buildInput(type));
    render();
  }

  // ---------------------------------------------------------------- 버튼
  const EDIT_ACTS = ['staff', 'addWish', 'delWish', 'addRule', 'delRule', 'addHoliday', 'delHoliday', 'inboxAdd', 'inboxAll'];
  async function onAction(act, el) {
    const type = el.dataset.type;
    if (EDIT_ACTS.indexOf(act) >= 0 && !editAsked) await beforeEdit();
    if (act === 'check') { runCheck(type); render(); toast(type + ' 검사: 위반 ' + S.check[type].filter(f => f.level === '위반').length + '건'); }
    else if (act === 'snapNow') {
      const label = ($('#snapLabel') && $('#snapLabel').value.trim()) || '직접 저장';
      busy('버전 저장 중…'); try { if (await snapshot(label)) toast('버전을 저장했습니다.'); } finally { idle(); }
      render();
    }
    else if (act === 'snapRestore') restoreSnap(el.dataset.key);
    else if (act === 'clearAuto') {
      if (!confirm(type + ' 근무표에서 자동 편성(파란 글씨) 칸만 지웁니다. 직접 넣은 칸과 원티드는 그대로입니다.')) return;
      busy('버전 저장 중…'); try { await snapshot(type + ' 자동 편성 지우기 직전'); } finally { idle(); }
      const n = clearAuto(type); log(type, '자동 편성 지우기 (' + n + '칸)'); markDirty(type); S.check[type] = null; render();
    }
    else if (act === 'generate') generate(type, Number($('#genSec').value) || 60);
    else if (act === 'staff') staffEditor(type);
    else if (act === 'xlsx') exportXlsx();
    else if (act === 'checkAll') { TYPES.forEach(runCheck); render(); }
    else if (act === 'goto') { S.tab = el.dataset.type; render(); }
    else if (act === 'addWish') { S.wishes.push({ name: '', day: '', kind: '희망', code: '휴', rank: 3, note: '' }); markDirty('wishes'); render(); }
    else if (act === 'delWish') { const i = Number(el.dataset.i); const w = S.wishes.splice(i, 1)[0]; log('wishes', '원티드 삭제: ' + w.name + ' ' + w.day + '일 ' + w.kind + ' ' + w.code); markDirty('wishes'); render(); }
    else if (act === 'addRule') { addRuleRow(el.dataset.list); }
    else if (act === 'delRule') { S.config[el.dataset.list].splice(Number(el.dataset.i), 1); markDirty('config'); render(); }
    else if (act === 'addHoliday') { S.config.holidays.push({ date: '', name: '' }); markDirty('config'); render(); }
    else if (act === 'delHoliday') { S.config.holidays.splice(Number(el.dataset.i), 1); markDirty('config'); render(); }
    else if (act === 'tour') startTour();
    else if (act === 'inboxMonth') { S.inboxMonth = el.dataset.m; render(); }
    else if (act === 'inboxReload') loadInbox();
    else if (act === 'copyLink') copyText(wishLink(S.inboxMonth), '링크를 복사했습니다.');
    else if (act === 'copyMsg') copyText('[응급실] ' + mkLabel(S.inboxMonth) + ' 원티드 신청 받습니다.\n아래 링크에서 이름·날짜·순위를 골라 보내 주세요.\n' + wishLink(S.inboxMonth), '단톡방 문구를 복사했습니다.');
    else if (act === 'inboxAdd') inboxAdd([el.dataset.id]);
    else if (act === 'inboxAll') inboxAdd((S.inbox || []).filter(x => !x.done).map(x => x.id));
    else if (act === 'inboxDel') {
      const x = (S.inbox || []).find(r => String(r.id) === String(el.dataset.id)); if (!x) return;
      if (!confirm(x.name + '님이 낸 원티드를 받은 목록에서 지웁니다. (아래 표에 이미 넣은 줄은 그대로)')) return;
      try { await store.inboxDelete(x.id); log('wishes', '받은 원티드 삭제: ' + x.name); } catch (e) { toast('삭제 실패: ' + e.message); }
      loadInbox();
    }
    else if (act === 'newMonth') newMonth();
    else if (act === 'importJson') $('#importFile').click();
    else if (act === 'exportJson') exportJson();
  }

  function runCheck(type) { S.check[type] = checkRoster(buildInput(type)); return S.check[type]; }

  function clearAuto(type) {
    let n = 0;
    S.rosters[type].staff.forEach(p => p.meta.forEach((m, d) => { if (m === 'a') { p.codes[d] = ''; p.meta[d] = ''; n++; } }));
    return n;
  }

  async function generate(type, sec) {
    if (!confirm(type + ' 자동 편성을 합니다 (' + sec + '초).\n\n자동 편성(파란 글씨) 칸을 지우고 다시 짭니다.\n직접 넣은 칸(검정)과 원티드(색 글씨)는 그대로 둡니다.\n(지금 상태는 버전으로 자동 저장됩니다)')) return;
    busy('버전 저장 중…'); try { await snapshot(type + ' 자동 편성 직전'); } finally { idle(); }
    clearAuto(type);
    const input = buildInput(type);
    let w;
    try { w = new Worker('worker.js'); } catch (e) { alert('이 브라우저에서는 자동 편성을 돌릴 수 없습니다: ' + e.message); return; }
    const t0 = Date.now();
    busy(type + ' 자동 편성 중…', '약 ' + sec + '초 걸립니다. 창을 닫지 마세요.');
    const timer = setInterval(() => { $('#overlaySub').textContent = Math.round((Date.now() - t0) / 1000) + ' / ' + sec + '초 · 창을 닫지 마세요.'; }, 1000);
    w.onmessage = ev => {
      clearInterval(timer); w.terminate(); idle();
      const r = ev.data;
      if (!r.ok) { alert('자동 편성 실패: ' + r.error); render(); return; }
      const ro = S.rosters[type];
      let n = 0;
      ro.staff.forEach((p, k) => r.free[k].forEach((isFree, d) => { if (isFree) { p.codes[d] = r.codes[k][d]; p.meta[d] = 'a'; n++; } }));
      const found = runCheck(type);
      const hard = found.filter(f => f.level === '위반').length;
      log(type, '자동 편성 ' + sec + '초 (' + n + '칸, 위반 ' + hard + '건)');
      markDirty(type); render();
      toast(type + ' 자동 편성 끝: 위반 ' + hard + '건, 주의 ' + (found.length - hard) + '건');
    };
    w.onerror = ev => { clearInterval(timer); w.terminate(); idle(); alert('자동 편성 오류: ' + ev.message); render(); };
    w.postMessage({ input, seconds: sec });
  }

  // 인원 편집
  function staffEditor(type) {
    closePicker();
    const ro = S.rosters[type];
    const groups = type === 'RN' ? RN_GROUP_LIST : AN_GROUP_LIST;
    const roles = ['', '선임', '차선임'];
    const rows = ro.staff.map((p, k) => '<tr data-k="' + k + '"><td>' + (k + 1) + '</td>' +
      '<td><select data-f="group">' + groups.concat(groups.indexOf(p.group) < 0 && p.group ? [p.group] : []).map(g => '<option' + (g === p.group ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '</select></td>' +
      '<td><select data-f="role">' + roles.map(g => '<option value="' + g + '"' + (g === p.role ? ' selected' : '') + '>' + (g || '-') + '</option>').join('') + '</select></td>' +
      '<td><input data-f="name" value="' + esc(p.name) + '"></td>' +
      '<td style="white-space:nowrap"><button data-mv="-1">↑</button> <button data-mv="1">↓</button> <button class="danger" data-del="1">삭제</button></td></tr>').join('');
    $('#view').innerHTML = '<div class="card"><h2>' + type + ' 인원 편집</h2>' +
      '<p class="note">이름은 "계급 이름(기수)" 그대로 써도 됩니다. 원티드·예외 표는 이름 뒷부분(예: 안선영)으로도 찾습니다. 전입·전출은 사람을 지우지 말고 근무표 칸에 입·출·역을 넣으세요.</p>' +
      '<table class="list"><thead><tr><th>#</th><th>그룹</th><th>직책</th><th>이름</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="bar" style="margin-top:10px"><button id="stAdd">사람 추가</button><span class="sp"></span><button class="primary" id="stDone">완료</button></div></div>';
    const tb = $('#view tbody');
    tb.addEventListener('change', e => {
      const tr = e.target.closest('tr'); const f = e.target.dataset.f; if (!tr || !f) return;
      const p = ro.staff[Number(tr.dataset.k)]; const old = p[f]; p[f] = e.target.value.trim();
      log(type, '인원 ' + f + ': ' + old + ' → ' + p[f]); markDirty(type);
    });
    tb.addEventListener('click', e => {
      const tr = e.target.closest('tr'); if (!tr) return; const k = Number(tr.dataset.k);
      if (e.target.dataset.mv) {
        const j = k + Number(e.target.dataset.mv); if (j < 0 || j >= ro.staff.length) return;
        const t = ro.staff[k]; ro.staff[k] = ro.staff[j]; ro.staff[j] = t; markDirty(type); staffEditor(type);
      } else if (e.target.dataset.del) {
        if (!confirm(ro.staff[k].name + ' 줄을 지웁니다. 이 달 근무 칸도 함께 지워집니다.')) return;
        log(type, '인원 삭제: ' + ro.staff[k].name); ro.staff.splice(k, 1); markDirty(type); staffEditor(type);
      }
    });
    $('#stAdd').onclick = () => {
      ro.staff.push({ group: groups[0], role: '', name: '새 사람', prev: ['', '', '', '', ''], codes: Array(31).fill(''), meta: Array(31).fill('') });
      markDirty(type); staffEditor(type);
    };
    $('#stDone').onclick = () => { S.check[type] = null; render(); };
  }

  // ---------------------------------------------------------------- 검사결과
  function checkView() {
    TYPES.forEach(t => { if (!S.check[t]) runCheck(t); });
    let h = '<div class="bar"><button data-act="checkAll">다시 검사</button><span class="note">줄을 누르면 해당 근무표로 갑니다. 빨간 테두리 칸에 마우스를 올리면 내용이 보입니다.</span></div>';
    TYPES.forEach(t => {
      const f = S.check[t] || [];
      const hard = f.filter(x => x.level === '위반');
      const by = {}; f.filter(x => x.level === '주의').forEach(x => { by[x.rule] = (by[x.rule] || 0) + 1; });
      h += '<div class="card"><h2>' + t + ' · <span class="lv-위반">위반 ' + hard.length + '</span> · <span class="lv-주의">주의 ' + (f.length - hard.length) + '</span></h2>';
      if (Object.keys(by).length) h += '<p class="note">주의: ' + Object.keys(by).map(k => esc(k) + ' ' + by[k]).join(', ') + '</p>';
      h += '<table class="list"><thead><tr><th>수준</th><th>규칙</th><th>대상</th><th>날짜</th><th>내용</th></tr></thead><tbody>' +
        f.slice().sort((a, b) => (a.level === b.level ? 0 : a.level === '위반' ? -1 : 1)).map(x =>
          '<tr data-act="goto" data-type="' + t + '" style="cursor:pointer"><td class="lv-' + x.level + '">' + x.level + '</td><td>' + esc(x.rule) + '</td><td>' + esc(x.target) + '</td><td>' + esc(x.day) + '</td><td>' + esc(x.msg) + '</td></tr>').join('') +
        '</tbody></table></div>';
    });
    return h;
  }

  // ---------------------------------------------------------------- 원티드
  function allNames() {
    const out = [];
    TYPES.forEach(t => S.rosters[t].staff.forEach(p => { if (out.indexOf(p.name) < 0) out.push(p.name); }));
    return out;
  }
  // 원티드 받기 (신청 링크·받은 원티드)
  const mkOf = (y, m) => y + '-' + String(m).padStart(2, '0');
  const mkLabel = mk => mk.slice(2, 4) + '년 ' + Number(mk.slice(5)) + '월';
  function inboxMonths() {
    const y = S.config.year, m = S.config.month;
    return [mkOf(y, m), m === 12 ? mkOf(y + 1, 1) : mkOf(y, m + 1)];
  }
  function wishLink(mk) { return new URL('wish.html?m=' + mk, location.href).href; }
  function staffAll() { return TYPES.reduce((a, t) => a.concat(S.rosters[t].staff), []); }
  function inboxCard() {
    const ms = inboxMonths();
    if (ms.indexOf(S.inboxMonth) < 0) S.inboxMonth = ms[0];
    const link = wishLink(S.inboxMonth);
    return '<div class="card"><h2>원티드 받기</h2>' +
      '<div class="bar">' + ms.map((mk, i) => '<button data-act="inboxMonth" data-m="' + mk + '" class="' + (S.inboxMonth === mk ? 'primary' : '') + '">' +
        mkLabel(mk) + ' 원티드 받기' + (i ? ' (다음 달)' : ' (이번 근무표)') + '</button>').join('') + '</div>' +
      '<div class="linkbox"><input id="wishLink" readonly value="' + esc(link) + '">' +
      '<button data-act="copyLink">링크 복사</button><button data-act="copyMsg">단톡방 문구 복사</button><a href="' + esc(link) + '" target="_blank" rel="noopener"><button>열어 보기</button></a></div>' +
      '<p class="note">이 링크를 단톡방에 올리면 로그인 없이 원티드를 낼 수 있습니다. 낸 사람은 남의 원티드를 볼 수 없고, 여기서만 보입니다.</p>' +
      '<div id="inbox"><p class="note">불러오는 중…</p></div></div>';
  }
  async function loadInbox() {
    const box = $('#inbox'); if (!box) return;
    const mk = S.inboxMonth;
    let list;
    try { list = await store.inbox(mk); } catch (e) {
      box.innerHTML = '<p class="err">받은 원티드를 불러오지 못했습니다: ' + esc(e.message) + '<br>(Supabase에 wish_inbox.sql을 아직 안 돌렸다면 먼저 돌려 주세요)</p>'; return;
    }
    if (S.tab !== 'wish' || S.inboxMonth !== mk) return;
    S.inbox = list;
    const isCur = mk === inboxMonths()[0];
    const staff = staffAll();
    const left = list.filter(x => !x.done).length;
    const names = {}; list.forEach(x => { names[x.name] = (names[x.name] || 0) + 1; });
    let h = '<div class="bar" style="margin-top:6px"><b>받은 원티드 ' + list.length + '건</b><span class="note">(아직 안 넣은 것 ' + left + '건)</span><span class="sp"></span>' +
      '<button data-act="inboxReload">새로 받은 것 보기</button>' +
      (isCur && left ? '<button class="primary" data-act="inboxAll">안 넣은 것 모두 아래 표에 넣기</button>' : '') + '</div>';
    if (!isCur && list.length) h += '<p class="note">' + mkLabel(mk) + ' 원티드는 설정 → [다음 달 근무표 시작]을 한 뒤 아래 표에 넣을 수 있습니다.</p>';
    if (!list.length) h += '<p class="note">아직 받은 원티드가 없습니다.</p>';
    else h += '<table class="list"><thead><tr><th style="width:110px">받은 시각</th><th style="width:170px">이름</th><th>원티드</th><th style="width:150px"></th></tr></thead><tbody>' +
      list.map(x => {
        const full = findStaffName(staff, String(x.name).trim());
        const items = (x.items || []).map(it => '<div>' + esc(it.day) + '일 ' + esc(it.kind) + ' <b>' + esc(it.code === '휴' ? '휴무' : it.code) + '</b> · ' + esc(it.rank) + '순위' + (it.note ? ' <span class="note">(' + esc(it.note) + ')</span>' : '') + '</div>').join('');
        return '<tr style="' + (x.done ? 'opacity:.5' : '') + '"><td>' + esc(new Date(x.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</td>' +
          '<td>' + esc(x.name) + (full && full !== x.name ? '<div class="note">→ ' + esc(full) + '</div>' : '') +
          (!full ? '<div class="lv-주의">명단에서 못 찾음</div>' : '') + (names[x.name] > 1 ? '<div class="lv-주의">여러 번 냄</div>' : '') + '</td>' +
          '<td>' + items + (x.memo ? '<div class="note">메모: ' + esc(x.memo) + '</div>' : '') + '</td>' +
          '<td style="white-space:nowrap">' + (x.done ? '<span class="note">넣음 ✓ </span>' : isCur ? '<button data-act="inboxAdd" data-id="' + x.id + '">표에 넣기</button> ' : '') +
          '<button class="danger" data-act="inboxDel" data-id="' + x.id + '">삭제</button></td></tr>';
      }).join('') + '</tbody></table>';
    box.innerHTML = h;
  }
  async function inboxAdd(ids) {
    const staff = staffAll();
    let n = 0;
    for (const id of ids) {
      const x = (S.inbox || []).find(r => String(r.id) === String(id));
      if (!x || x.done) continue;
      const name = findStaffName(staff, String(x.name).trim()) || x.name;
      (x.items || []).forEach(it => {
        S.wishes.push({ name, day: Number(it.day), kind: it.kind === '금지' ? '금지' : '희망', code: String(it.code || ''), rank: Number(it.rank) || 3, note: it.note || x.memo || '' });
        n++;
      });
      try { await store.inboxDone(x.id, S.user); x.done = true; } catch (e) { toast('넣음 표시 실패: ' + e.message); }
      log('wishes', '받은 원티드 넣기: ' + name + ' ' + (x.items || []).length + '건');
    }
    markDirty('wishes'); render();
    toast('원티드 ' + n + '건을 표에 넣었습니다. 자동 편성을 다시 돌리면 반영됩니다.');
  }
  function copyText(text, done) {
    const fallback = () => { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } t.remove(); toast(ok ? done : '복사가 안 됩니다. 링크 칸을 길게 눌러 직접 복사하세요.'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast(done), fallback); else fallback();
  }

  function wishView() {
    const names = allNames();
    const n = monthDays().length;
    setTimeout(loadInbox, 0);
    let h = inboxCard() + '<div class="card"><h2>원티드 표 (자동 편성이 지키려고 하는 희망·금지)</h2>' +
      '<p class="note">꼭 들어줘야 하는 휴가·휴무·근무(1·2순위로 확정된 것)는 근무표 칸에 직접 넣고 [원티드 순위]를 고르세요 — 그 칸은 자동 편성이 바꾸지 않습니다.<br>' +
      '여기 표는 "되면 좋은 것"입니다. 희망 = 그날 이 근무였으면, 금지 = 그날 이 근무는 빼 달라. 코드는 D·E·N·휴, 여러 개면 쉼표(예: 휴,N). 순위가 높을수록 더 지킵니다.</p>' +
      '<table class="list" id="wishTable"><thead><tr><th style="width:190px">이름</th><th style="width:70px">날짜(일)</th><th style="width:90px">희망/금지</th><th style="width:90px">코드</th><th style="width:80px">순위</th><th>메모</th><th style="width:60px"></th></tr></thead><tbody>';
    S.wishes.forEach((w, i) => {
      h += '<tr data-i="' + i + '"><td><select data-f="name"><option value=""></option>' +
        names.concat(w.name && names.indexOf(w.name) < 0 ? [w.name] : []).map(nm => '<option' + (nm === w.name ? ' selected' : '') + '>' + esc(nm) + '</option>').join('') + '</select></td>' +
        '<td><input data-f="day" type="number" min="1" max="' + n + '" value="' + esc(w.day) + '"></td>' +
        '<td><select data-f="kind"><option' + (w.kind === '희망' ? ' selected' : '') + '>희망</option><option' + (w.kind === '금지' ? ' selected' : '') + '>금지</option></select></td>' +
        '<td><input data-f="code" value="' + esc(w.code) + '"></td>' +
        '<td><select data-f="rank">' + [1, 2, 3].map(r => '<option value="' + r + '"' + (Number(w.rank) === r ? ' selected' : '') + '>' + r + '순위</option>').join('') + '</select></td>' +
        '<td><input data-f="note" value="' + esc(w.note) + '"></td>' +
        '<td><button class="danger" data-act="delWish" data-i="' + i + '">삭제</button></td></tr>';
    });
    h += '</tbody></table><div class="bar" style="margin-top:10px"><button data-act="addWish">줄 추가</button></div></div>';
    return h;
  }
  $('#view').addEventListener('change', e => {
    const f = e.target.dataset.f; if (!f) return;
    if (S.tab === 'wish') {
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const w = S.wishes[Number(tr.dataset.i)];
      w[f] = f === 'rank' || f === 'day' ? Number(e.target.value) : e.target.value.trim();
      log('wishes', '원티드 수정: ' + w.name + ' ' + w.day + '일 ' + w.kind + ' ' + w.code + ' ' + w.rank + '순위');
      markDirty('wishes');
    } else if (S.tab === 'rules') {
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const row = S.config[tr.dataset.list][Number(tr.dataset.i)];
      row[f] = e.target.value.trim(); markDirty('config');
    } else if (S.tab === 'settings') {
      onSettingChange(e.target);
    }
  });

  // ---------------------------------------------------------------- 규칙·예외
  const RULE_TABLES = {
    pairs: { title: '같은 시간대 근무 금지', cols: [['type', '구분', 60], ['a', '이름 1'], ['b', '이름 2'], ['memo', '메모']], blank: { type: 'AN', a: '', b: '', memo: '' } },
    duty: { title: '일직 횟수 (휴일 낮번 1·1비)', cols: [['type', '구분', 60], ['name', '이름'], ['base', '원칙', 70], ['max', '최대', 70], ['memo', '메모']], blank: { type: 'RN', name: '', base: 1, max: 1, memo: '' } },
    exceptions: { title: '개인별 예외 근무 (대학원·임부 등)', cols: [['type', '구분', 60], ['name', '이름', 100], ['from', '시작', 110], ['to', '끝', 110], ['when', '요일', 90], ['allowed', '가능 근무', 100], ['memo', '메모']], blank: { type: 'RN', name: '', from: '', to: '', when: '', allowed: '', memo: '' } },
  };
  function addRuleRow(list) { S.config[list] = S.config[list] || []; S.config[list].push(Object.assign({}, RULE_TABLES[list].blank)); markDirty('config'); render(); }
  function rulesView() {
    let h = '<div class="card"><p class="note" style="margin:0">고친 내용은 바로 저장되고, 다음 규칙 검사·자동 편성부터 적용됩니다. ' +
      '예외 표: 시작·끝은 2026-12-20 또는 12/20 (비우면 제한 없음), 요일은 수,목 또는 평일·휴일 (비우면 매일), 가능 근무는 D·E·N·휴를 쉼표로.</p></div>';
    Object.keys(RULE_TABLES).forEach(list => {
      const T = RULE_TABLES[list];
      h += '<div class="card"><h2>' + T.title + '</h2><table class="list"><thead><tr>' +
        T.cols.map(c => '<th' + (c[2] ? ' style="width:' + c[2] + 'px"' : '') + '>' + c[1] + '</th>').join('') + '<th style="width:60px"></th></tr></thead><tbody>';
      (S.config[list] || []).forEach((r, i) => {
        h += '<tr data-list="' + list + '" data-i="' + i + '">' + T.cols.map(c => c[0] === 'type'
          ? '<td><select data-f="type"><option' + (r.type === 'RN' ? ' selected' : '') + '>RN</option><option' + (r.type === 'AN' ? ' selected' : '') + '>AN</option></select></td>'
          : '<td><input data-f="' + c[0] + '" value="' + esc(r[c[0]]) + '"></td>').join('') +
          '<td><button class="danger" data-act="delRule" data-list="' + list + '" data-i="' + i + '">삭제</button></td></tr>';
      });
      h += '</tbody></table><div class="bar" style="margin-top:8px"><button data-act="addRule" data-list="' + list + '">줄 추가</button></div></div>';
    });
    return h;
  }

  // ---------------------------------------------------------------- 편성 로직
  function priorityRows(need) {
    const p = (a, b) => a + '·' + b;
    return [
      ['⓪ 최우선', '필요 인원', 'RN 평일 낮번 ' + need.rnDay[0] + '·초번 ' + need.rnEve[0] + '·밤번 ' + need.rnNight[0] + ', 휴일 낮번 ' + need.rnDay[1] + '·초번 ' + need.rnEve[1] + '·밤번 ' + need.rnNight[1] + ' / AN 낮번 ' + p(need.anDay[0], need.anDay[1]) + '·초번 ' + p(need.anEve[0], need.anEve[1]) + '·밤번 ' + p(need.anNight[0], need.anNight[1]), '금지', STAFF_HARD + ' (1명당)'],
      ['⓪ 최우선', '밤번 시니어·휴일 그룹 구성', '매일 밤번 시니어 1명 이상. 휴일 낮번·초번·밤번마다 시니어·중간·막내 각 1명 이상', '금지', String(STAFF_HARD)],
      ['① 반드시', '휴일 1비·E비', '휴일마다 1비·E비 1명', '금지', String(HARD)],
      ['① 반드시', '평일 낮번 구성', '선임·차선임 1명 이상, 시니어 또는 중간 1명 이상, C 1명', '금지', String(HARD)],
      ['① 반드시', '근무 순서', 'D → E → N 순방향만, E-휴-D 금지', '금지', String(HARD)],
      ['① 반드시', '밤번 뒤 휴무·밤번 간격', '밤번 뒤 2일 휴무, 3N 뒤 3일 휴무, 밤번 연속 RN 3·AN 2까지, 밤번 묶음 사이 ' + NIGHT_GAP + '일 이상', '금지', String(HARD)],
      ['① 반드시', '연속 한도', '연속 근무 최대 5일, ' + BLOCK_MIN + '일 이상 근무 뒤 휴무 ' + AFTER_BLOCK_OFF + '일, 휴 연속 최대 ' + MAX_OFF_RUN + '일', '금지', String(HARD)],
      ['① 반드시', '휴무 개수', '한 달 휴무 = 휴일 수 + 추가 휴무 (주말·공휴일 정기휴가 포함)', '금지', HARD + ' (1개당)'],
      ['① 반드시', '개인별 예외', '[규칙·예외] 표의 기간·요일에는 적힌 근무만 (점수로 맞바꾸지 않음)', '금지', '절대'],
      ['① 반드시', '리퀘스트 전날 밤번', '원티드 휴무·휴가 전날 N', '금지', String(HARD)],
      ['① 반드시', 'AN 고정 규칙', '월·수 밤번 주무관만, 같은 시간대 금지 짝, 낮번·초번 주무관 1명 이상', '금지', String(HARD)],
      ['① 반드시', '밤번 균등', '밤번 개수 2개 이상 차이 금지 (선임·차선임·실습·전입/전출/파견·임부·한 달 휴가 제외)', '금지', String(HARD)],
      ['② 되도록', '원티드 1순위', '꼭 필요한 희망', '지양', String(WISH_WEIGHT.희망1)],
      ['② 되도록', '연속 근무 최소·사이 휴무', '근무는 되도록 ' + BLOCK_MIN + '일 연속, 근무 사이 휴무 되도록 ' + AFTER_BLOCK_OFF + '일', '지양', String(BLOCK_WEIGHT)],
      ['② 되도록', '원티드 금지', '"이 근무는 빼 달라"', '지양', String(WISH_WEIGHT.금지)],
      ['② 되도록', '의무병끼리 근무 (AN)', '낮번·초번에 의무병 2명 이상', '지양', String(SOLDIER_PAIR_WEIGHT)],
      ['② 되도록', '일직 횟수', '[규칙·예외] 일직 표대로', '금지/지양', '100 / ' + DUTY_SOFT],
      ['③ 가능하면', '원티드 2순위', '되면 좋은 희망', '지양', String(WISH_WEIGHT.희망2)],
      ['③ 가능하면', '리퀘스트 전날 초번', '원티드 휴무·휴가 전날 E', '지양', String(REQ_E_WEIGHT)],
      ['③ 가능하면', 'RN 3N', '밤번 3일 연속', '지양', String(NIGHT3_SOFT)],
      ['③ 가능하면', '원티드 3순위', '들어주면 고마운 희망', '지양', String(WISH_WEIGHT.희망3)],
      ['③ 가능하면', '휴일 근무 균등', '같은 그룹 안에서 휴일 근무 횟수 고르게 (' + HOLI_GAP + '번 이상 차이면 알림)', '지양', HOLI_WEIGHT + ' × 차이²'],
      ['④ 편성 뒤', '콜대기 이름 붙이기', 'C·1·1비·E비를 사람마다 고르게', '안내', '-'],
    ];
  }
  function logicView() {
    const days = monthDays(), need = S.config.need;
    let h = '<div class="card"><h2>자동 편성 우선순위</h2><p class="note">위쪽일수록 먼저 지킵니다. 점수가 클수록 어기기 어렵습니다. 이 화면은 지금 코드에서 바로 만들어집니다.</p>' +
      '<table class="list"><thead><tr><th>단계</th><th>항목</th><th>내용</th><th>수준</th><th>점수</th></tr></thead><tbody>' +
      priorityRows(need).map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td class="lv-' + esc(r[3].split('/')[0]) + '">' + esc(r[3]) + '</td><td>' + esc(r[4]) + '</td></tr>').join('') +
      '</tbody></table></div>';
    h += '<div class="card"><h2>규칙 목록 (검사 기준)</h2><table class="list"><thead><tr><th>구분</th><th>규칙</th><th>수준</th><th>내용</th></tr></thead><tbody>' +
      buildRuleRows(need, offTargetOf(days)).map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td class="lv-' + esc(String(r[2]).split('/')[0]) + '">' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>').join('') +
      '</tbody></table></div>';
    return h;
  }

  // ---------------------------------------------------------------- 설정
  const NEED_ROWS = [['rnDay', 'RN 낮번'], ['rnEve', 'RN 초번'], ['rnEveMin', 'RN 초번 최소 허용'], ['rnNight', 'RN 밤번'], ['rnNightMin', 'RN 밤번 최소 허용'], ['anDay', 'AN 낮번 최소'], ['anEve', 'AN 초번'], ['anNight', 'AN 밤번']];
  function settingsView() {
    const c = S.config, days = monthDays();
    let h = '<div class="card"><h2>이번 달</h2><div class="bar">' +
      '<label>연도 <input data-s="year" type="number" value="' + c.year + '" style="width:90px"></label>' +
      '<label>월 <input data-s="month" type="number" min="1" max="12" value="' + c.month + '" style="width:70px"></label>' +
      '<label>추가 휴무 <input data-s="extraOff" type="number" value="' + (c.extraOff || 0) + '" style="width:70px"></label>' +
      '<span class="note">휴무 기준 = 휴일 ' + days.filter(x => x.holiday).length + '일 + 추가 ' + (c.extraOff || 0) + ' = <b>' + offTargetOf(days) + '개</b></span></div>' +
      '<p class="note">연도·월을 바로 바꾸면 날짜만 바뀝니다. 다음 달 근무표를 새로 시작할 때는 아래 [다음 달 시작]을 쓰세요.</p></div>';
    h += '<div class="card"><h2>필요 인원</h2><table class="list" style="max-width:420px"><thead><tr><th>근무</th><th>평일</th><th>휴일</th></tr></thead><tbody>' +
      NEED_ROWS.map(([k, l]) => '<tr><td>' + l + '</td>' + [0, 1].map(i => '<td><input data-need="' + k + '" data-h="' + i + '" type="number" value="' + ((c.need[k] || c.need.rnNight)[i]) + '"></td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
    h += '<div class="card"><h2>공휴일 (토·일은 자동)</h2><table class="list" style="max-width:520px"><thead><tr><th>날짜 (2026-12-25)</th><th>이름</th><th></th></tr></thead><tbody>' +
      (c.holidays || []).map((x, i) => '<tr><td><input data-hol="date" data-i="' + i + '" value="' + esc(x.date) + '"></td><td><input data-hol="name" data-i="' + i + '" value="' + esc(x.name) + '"></td><td><button class="danger" data-act="delHoliday" data-i="' + i + '">삭제</button></td></tr>').join('') +
      '</tbody></table><div class="bar" style="margin-top:8px"><button data-act="addHoliday">공휴일 추가</button></div></div>';
    h += '<div class="card"><h2>다음 달 시작</h2><p class="note">지금 근무표를 보관하고, 같은 인원으로 다음 달 빈 근무표를 만듭니다. 이번 달 마지막 5일은 다음 달 "전월 말"로 옮겨지고, 원티드 표는 비워집니다 (보관됨).</p>' +
      '<button data-act="newMonth">' + (c.month === 12 ? c.year + 1 + '년 1' : c.year + '년 ' + (c.month + 1)) + '월 근무표 시작</button></div>';
    h += '<div class="card"><h2>데이터 백업·가져오기</h2><p class="note">백업 파일에는 이름과 근무가 들어 있습니다. 공용 PC나 인터넷에 올리지 마세요.</p><div class="bar">' +
      '<button data-act="exportJson">백업 파일 내려받기</button><button data-act="importJson">백업 파일로 덮어쓰기</button>' +
      '<input type="file" id="importFile" accept=".json,application/json" class="hidden"></div></div>';
    setTimeout(() => { const f = $('#importFile'); if (f) f.onchange = importJson; }, 0);
    return h;
  }
  function onSettingChange(t) {
    const c = S.config;
    if (t.dataset.s) { c[t.dataset.s] = Number(t.value) || 0; log('config', '설정 ' + t.dataset.s + ' = ' + t.value); }
    else if (t.dataset.need) { const k = t.dataset.need; c.need[k] = (c.need[k] || c.need.rnNight).slice(); c.need[k][Number(t.dataset.h)] = Number(t.value) || 0; log('config', '필요 인원 ' + k + ' = ' + c.need[k].join('/')); }
    else if (t.dataset.hol) { c.holidays[Number(t.dataset.i)][t.dataset.hol] = t.value.trim(); }
    else return;
    markDirty('config'); S.check = {}; render();
  }

  async function newMonth() {
    const c = S.config;
    const ny = c.month === 12 ? c.year + 1 : c.year, nm = c.month === 12 ? 1 : c.month + 1;
    if (!confirm(c.year + '년 ' + c.month + '월 근무표를 보관하고 ' + ny + '년 ' + nm + '월 근무표를 새로 만듭니다. 계속할까요?')) return;
    await flush();
    await snapshot(c.year + '년 ' + c.month + '월 → 다음 달 시작 직전');
    const n = monthDays().length;
    const mk = monthKey();
    busy('다음 달 준비 중…');
    try {
      for (const t of TYPES) await store.save('archive:' + mk + ':' + t, S.rosters[t], null, S.user).catch(() => {});
      await store.save('archive:' + mk + ':wishes', { list: S.wishes }, null, S.user).catch(() => {});
      TYPES.forEach(t => {
        const ro = S.rosters[t];
        ro.month = ny + '-' + String(nm).padStart(2, '0');
        ro.staff = ro.staff.filter(p => !p.codes.slice(0, n).some(x => x === '출' || x === '역'));   // 전출·전역한 사람은 뺌
        ro.staff.forEach(p => {
          p.prev = p.codes.slice(n - 5, n).map(x => (x === '입' ? '' : x));
          p.codes = Array(31).fill(''); p.meta = Array(31).fill('');
        });
      });
      S.wishes = []; c.year = ny; c.month = nm; c.extraOff = 0;
      ['config', 'RN', 'AN', 'wishes'].forEach(k => { S.dirty[k] = true; });
    } finally { idle(); }
    await flush();
    log('config', ny + '년 ' + nm + '월 근무표 시작 (' + mk + ' 보관)');
    S.check = {}; S.tab = 'RN'; render();
    toast(ny + '년 ' + nm + '월 근무표를 만들었습니다. 전입자는 [인원 편집]으로 추가하세요.');
  }

  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => { const d = new Date(), p = x => String(x).padStart(2, '0'); return String(d.getFullYear()).slice(-2) + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()); };

  function exportJson() {
    const data = { format: 'afch-roster-1', config: S.config, rosters: S.rosters, wishes: S.wishes };
    download('근무표 백업 ' + monthKey() + ' ' + stamp() + '.json', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  }
  function importJson(e) {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => {
      let data;
      try { data = JSON.parse(String(rd.result).replace(/^﻿/, '')); } catch (err) { alert('파일을 읽지 못했습니다: ' + err.message); return; }
      if (data.format !== 'afch-roster-1' || !data.config || !data.rosters) { alert('근무표 백업 파일이 아닙니다.'); return; }
      if (!confirm('지금 저장된 설정·RN·AN·원티드를 이 파일 내용으로 바꿉니다. 계속할까요?\n(지금 상태는 버전으로 자동 저장됩니다)')) return;
      if (S.config && S.rosters.RN) await snapshot('백업 덮어쓰기 직전');
      S.config = data.config; S.rosters = { RN: data.rosters.RN || { staff: [] }, AN: data.rosters.AN || { staff: [] } };
      TYPES.forEach(t => normalizeRoster(S.rosters[t]));
      S.wishes = (data.wishes && data.wishes.list) || data.wishes || [];
      ['config', 'RN', 'AN', 'wishes'].forEach(k => { S.dirty[k] = true; });
      await flush(); log('config', '백업 파일 가져오기: ' + file.name);
      S.check = {}; render(); toast('가져왔습니다.');
    };
    rd.readAsText(file, 'utf-8');
  }

  // ---------------------------------------------------------------- 변경 기록
  async function logView() {
    try {
      const l = await store.logs(300);
      if (S.tab !== 'log') return;
      $('#view').innerHTML = '<div class="card"><h2>변경 기록 (최근 300건)</h2><table class="list"><thead><tr><th style="width:150px">시각</th><th style="width:160px">누가</th><th style="width:80px">어디</th><th>내용</th></tr></thead><tbody>' +
        l.map(x => '<tr><td>' + esc(new Date(x.at).toLocaleString('ko-KR')) + '</td><td>' + esc(x.by) + '</td><td>' + esc(x.key) + '</td><td>' + esc(x.note) + '</td></tr>').join('') +
        '</tbody></table></div>';
    } catch (e) { $('#view').innerHTML = '<div class="card err">기록을 불러오지 못했습니다: ' + esc(e.message) + '</div>'; }
  }

  // ---------------------------------------------------------------- xlsx
  function exportXlsx() {
    if (!window.XLSX) { alert('xlsx 도구를 불러오지 못했습니다.'); return; }
    TYPES.forEach(runCheck);
    const wb = XLSX.utils.book_new();
    const days = monthDays();
    const border = { top: { style: 'thin', color: { rgb: 'CCCCCC' } }, bottom: { style: 'thin', color: { rgb: 'CCCCCC' } }, left: { style: 'thin', color: { rgb: 'CCCCCC' } }, right: { style: 'thin', color: { rgb: 'CCCCCC' } } };
    const rgb = h => String(h).replace('#', '').toUpperCase();
    const C = (v, s) => ({ v: v == null ? '' : v, t: typeof v === 'number' ? 'n' : 's', s: Object.assign({ alignment: { horizontal: 'center', vertical: 'center' }, border, font: { name: '맑은 고딕', sz: 10 } }, s || {}) });
    const head = { fill: { fgColor: { rgb: 'D9E1F2' } }, font: { name: '맑은 고딕', sz: 10, bold: true } };
    const holHead = { fill: { fgColor: { rgb: 'F4CCCC' } }, font: { name: '맑은 고딕', sz: 10, bold: true, color: { rgb: 'B00020' } } };

    TYPES.forEach(type => {
      const ro = S.rosters[type];
      const rows = [];
      rows.push([C(S.config.year + '년 ' + S.config.month + '월 응급실 ' + type + ' 근무표', { font: { name: '맑은 고딕', sz: 13, bold: true }, alignment: { horizontal: 'left' }, border: {} })]);
      rows.push([C('그룹', head), C('직책', head), C('계급/성명', head), C('전월 말', head), C('', head), C('', head), C('', head), C('', head)]
        .concat(days.map(x => C(x.day, x.holiday ? holHead : head))).concat([C('휴무', head), C('N', head)]));
      rows.push([C('', head), C('', head), C('', head)].concat([-5, -4, -3, -2, -1].map(x => C(x, head)))
        .concat(days.map(x => C(WEEKDAY_KO[x.weekday], x.holiday ? holHead : head))).concat([C('', head), C('', head)]));
      ro.staff.forEach(p => {
        const r = [C(p.group), C(p.role), C(p.name, { alignment: { horizontal: 'left' } })];
        p.prev.forEach(x => r.push(C(x, { fill: { fgColor: { rgb: 'EFEFEF' } }, font: { name: '맑은 고딕', sz: 10, color: { rgb: x === 'N' ? rgb(N_FONT) : '555555' } } })));
        let off = 0, nN = 0;
        days.forEach((x, d) => {
          const c = p.codes[d] || '', m = p.meta[d] || '';
          if (isOffDay(c, x.holiday)) off++; if (c === 'N') nN++;
          const bg = CODE_COLORS[c] || (x.holiday ? '#FCEFEF' : null);
          const fc = c === 'N' ? N_FONT : (m && m !== 'a' ? META_FONT[m] : '#000000');
          r.push(C(c, Object.assign({ font: { name: '맑은 고딕', sz: 10, bold: c === 'N', color: { rgb: rgb(fc) } } }, bg ? { fill: { fgColor: { rgb: rgb(bg) } } } : {})));
        });
        r.push(C(off), C(nN));
        rows.push(r);
      });
      const cnt = (fn) => days.map((x, d) => C(ro.staff.filter(p => p.group !== '실습' && fn(p.codes[d] || '')).length));
      rows.push([C(''), C(''), C('낮번', head), C(''), C(''), C(''), C(''), C('')].concat(cnt(isDayShift)));
      rows.push([C(''), C(''), C('초번', head), C(''), C(''), C(''), C(''), C('')].concat(cnt(isEveShift)));
      rows.push([C(''), C(''), C('밤번', head), C(''), C(''), C(''), C(''), C('')].concat(cnt(c => c === 'N')));
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 7 }, { wch: 6 }, { wch: 18 }].concat(Array(5).fill({ wch: 4 })).concat(days.map(() => ({ wch: 4 }))).concat([{ wch: 5 }, { wch: 4 }]);
      ws['!merges'] = [{ s: { r: 1, c: 3 }, e: { r: 1, c: 7 } }];
      ws['!freeze'] = { xSplit: 3, ySplit: 3 };
      XLSX.utils.book_append_sheet(wb, ws, type);
    });

    const L = (v, s) => ({ v: v == null ? '' : String(v), t: 's', s: Object.assign({ alignment: { vertical: 'top', wrapText: true }, border, font: { name: '맑은 고딕', sz: 10 } }, s || {}) });
    const red = { font: { name: '맑은 고딕', sz: 10, bold: true, color: { rgb: 'CC0000' } } }, amber = { font: { name: '맑은 고딕', sz: 10, bold: true, color: { rgb: 'B45F06' } } };
    const cr = [[L('규칙 검사 결과 (' + new Date().toLocaleString('ko-KR') + ')', { font: { name: '맑은 고딕', sz: 12, bold: true }, border: {} })], [L('구분', head), L('수준', head), L('규칙', head), L('대상', head), L('날짜', head), L('내용', head)]];
    TYPES.forEach(t => (S.check[t] || []).forEach(f => cr.push([L(t), L(f.level, f.level === '위반' ? red : amber), L(f.rule), L(f.target), L(f.day), L(f.msg)])));
    const wsC = XLSX.utils.aoa_to_sheet(cr); wsC['!cols'] = [{ wch: 5 }, { wch: 6 }, { wch: 18 }, { wch: 18 }, { wch: 8 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, wsC, '검사결과');

    const lr = [[L('편성 로직 (자동 편성 우선순위, 위쪽일수록 먼저)', { font: { name: '맑은 고딕', sz: 12, bold: true }, border: {} })], [L('단계', head), L('항목', head), L('내용', head), L('수준', head), L('점수', head)]];
    priorityRows(S.config.need).forEach(r => lr.push(r.map(L)));
    lr.push([L('')]); lr.push([L('규칙 목록', { font: { name: '맑은 고딕', sz: 12, bold: true }, border: {} })]);
    lr.push([L('구분', head), L('규칙', head), L('수준', head), L('내용', head)]);
    buildRuleRows(S.config.need, offTargetOf(days)).forEach(r => lr.push(r.map(L)));
    const wsL = XLSX.utils.aoa_to_sheet(lr); wsL['!cols'] = [{ wch: 11 }, { wch: 24 }, { wch: 80 }, { wch: 9 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsL, '편성 로직');

    const name = '[AFCH 응급실] 간호 근무표 ' + String(S.config.year).slice(-2) + '년 ' + S.config.month + '월 (' + stamp() + ').xlsx';
    XLSX.writeFile(wb, name);
    log('config', 'xlsx 내려받기: ' + name);
  }

  // ---------------------------------------------------------------- 버전 (되돌리기용 저장본)
  /** 팝업 질문. buttons[0]이 기본(분홍) 버튼. 누른 버튼 번호를 돌려줌 (닫으면 -1) */
  function ask(title, html, buttons) {
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.className = 'overlay'; el.style.zIndex = 65;
      el.innerHTML = '<div class="box" style="text-align:left;width:min(420px,92vw)"><h2 style="margin:0 0 8px;font-size:16px">' + esc(title) + '</h2>' +
        '<div style="font-size:14px">' + html + '</div><div class="bar" style="margin:14px 0 0;justify-content:flex-end">' +
        buttons.map((b, i) => '<button data-i="' + i + '" class="' + (i === 0 ? 'primary' : '') + '">' + esc(b) + '</button>').join('') + '</div></div>';
      document.body.appendChild(el);
      el.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; el.remove(); resolve(Number(b.dataset.i)); });
      el.querySelector('button.primary').focus();
    });
  }
  async function snapshot(label) {
    await flush();
    const at = new Date().toISOString();
    const key = 'snap:' + at + ':' + Math.random().toString(36).slice(2, 6);
    const value = { label, by: S.user, month: monthKey(), config: S.config, rosters: S.rosters, wishes: S.wishes };
    try { await store.save(key, value, null, S.user); log('version', '버전 저장: ' + label); return true; }
    catch (e) { toast('버전 저장 실패: ' + e.message); return false; }
  }
  // 이 창에서 처음 고치기 시작할 때 한 번 묻기
  let editAsked = false, asking = null;
  function beforeEdit() {
    if (editAsked) return Promise.resolve();
    if (asking) return asking;
    asking = ask('근무표를 고치기 시작합니다', '고치기 전 지금 상태를 <b>버전</b>으로 저장해 둘까요?<br><span class="note">실수했을 때 [버전 기록] 탭에서 이 상태로 되돌릴 수 있습니다. 이 창을 닫기 전까지는 다시 묻지 않습니다.</span>',
      ['버전 저장하고 고치기', '그냥 고치기'])
      .then(async i => { editAsked = true; asking = null; if (i === 0) { busy('버전 저장 중…'); try { if (await snapshot('고치기 전 (' + (S.user || '') + ')')) toast('지금 상태를 버전으로 저장했습니다.'); } finally { idle(); } } });
    return asking;
  }
  $('#view').addEventListener('focusin', e => {
    if (editAsked || !e.target.matches('input, select, textarea')) return;
    if (e.target.id === 'genSec' || e.target.id === 'wishLink' || e.target.id === 'importFile') return;
    beforeEdit();
  });

  async function verView() {
    try {
      const list = await store.snaps();
      if (S.tab !== 'ver') return;
      $('#view').innerHTML = '<div class="card"><h2>버전 기록 (되돌리기)</h2>' +
        '<p class="note">버전 = 그 순간의 설정·RN·AN·원티드 전체를 통째로 저장한 것입니다. 저장 위치는 근무표와 같은 Supabase 저장소이고, 로그인한 사람만 볼 수 있습니다.<br>' +
        '자동 편성·자동 편성 지우기·백업 덮어쓰기·다음 달 시작·되돌리기 직전에는 <b>자동으로</b> 버전이 저장됩니다. 칸 하나하나의 변경은 [변경 기록] 탭에 남습니다.</p>' +
        '<div class="bar"><input id="snapLabel" placeholder="메모 (예: 수기 조정 끝)" style="flex:1 1 240px"><button class="primary" data-act="snapNow">지금 상태를 버전으로 저장</button></div></div>' +
        '<div class="card"><table class="list"><thead><tr><th style="width:170px">저장 시각</th><th style="width:200px">누가</th><th>메모</th><th style="width:110px"></th></tr></thead><tbody>' +
        (list.length ? list.map(x => '<tr><td>' + esc(new Date(x.at).toLocaleString('ko-KR')) + '</td><td>' + esc(x.by) + '</td><td>' + esc(x.label) + '</td>' +
          '<td><button data-act="snapRestore" data-key="' + esc(x.key) + '">되돌리기</button></td></tr>').join('') : '<tr><td colspan="4" class="note">아직 저장된 버전이 없습니다.</td></tr>') +
        '</tbody></table></div>';
    } catch (e) { $('#view').innerHTML = '<div class="card err">버전 목록을 불러오지 못했습니다: ' + esc(e.message) + '</div>'; }
  }
  async function restoreSnap(key) {
    const row = await store.load(key).catch(() => null);
    if (!row) { toast('버전을 불러오지 못했습니다.'); return; }
    const v = row.value;
    const when = new Date(row.at).toLocaleString('ko-KR');
    const i = await ask('이 버전으로 되돌릴까요?', '<b>' + esc(when) + '</b> · ' + esc(v.by || '') + '<br>' + esc(v.label || '') +
      '<br><br>설정·RN·AN·원티드가 모두 이 때로 돌아갑니다. 되돌리기 직전 상태도 버전으로 자동 저장되니, 다시 되돌릴 수 있습니다.', ['되돌리기', '취소']);
    if (i !== 0) return;
    busy('되돌리는 중…');
    try {
      await snapshot('되돌리기 직전 자동 저장');
      S.config = v.config; S.rosters = { RN: v.rosters.RN, AN: v.rosters.AN };
      TYPES.forEach(t => normalizeRoster(S.rosters[t]));
      S.wishes = v.wishes || [];
      ['config', 'RN', 'AN', 'wishes'].forEach(k => { S.dirty[k] = true; });
      await flush();
      log('version', '되돌리기: ' + when + ' 버전 (' + (v.label || '') + ')');
      S.check = {};
    } finally { idle(); }
    render(); toast(when + ' 버전으로 되돌렸습니다.');
  }

  // ---------------------------------------------------------------- 비밀번호
  function pwDialog(recovery) {
    const old = $('#pwDlg'); if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'pwDlg'; el.className = 'overlay';
    el.innerHTML = '<div class="box" style="text-align:left;width:min(360px,92vw)">' +
      '<h2 style="margin:0 0 6px;font-size:16px">' + (recovery ? '새 비밀번호 정하기' : '비밀번호 바꾸기') + '</h2>' +
      '<p class="note" style="margin:0 0 10px">' + (recovery ? '메일 링크로 들어왔습니다. 새 비밀번호를 정해 주세요.' : esc(S.user) + ' 계정의 비밀번호를 바꿉니다.') + '</p>' +
      '<input id="pw1" type="password" placeholder="새 비밀번호 (8자 이상)" autocomplete="new-password" style="width:100%;margin-bottom:8px">' +
      '<input id="pw2" type="password" placeholder="한 번 더" autocomplete="new-password" style="width:100%">' +
      '<div class="err" id="pwErr"></div>' +
      '<div class="bar" style="margin:12px 0 0"><span class="sp"></span><button id="pwCancel">취소</button><button class="primary" id="pwOk">바꾸기</button></div></div>';
    document.body.appendChild(el);
    const close = () => { el.remove(); if (recovery) history.replaceState(null, '', location.pathname); };
    $('#pwCancel').onclick = close;
    $('#pw1').focus();
    const ok = async () => {
      const a = $('#pw1').value, b = $('#pw2').value;
      $('#pwErr').textContent = '';
      if (a.length < 8) { $('#pwErr').textContent = '8자 이상으로 정해 주세요.'; return; }
      if (a !== b) { $('#pwErr').textContent = '두 칸이 다릅니다.'; return; }
      $('#pwOk').disabled = true;
      try {
        await store.setPassword(a);
        close(); toast('비밀번호를 바꿨습니다. 다음 로그인부터 새 비밀번호를 쓰세요.');
        log('config', '비밀번호 변경');
      } catch (e) {
        const m = String(e.message || e);
        $('#pwErr').textContent = /different from the old/i.test(m) ? '지금 비밀번호와 다른 것으로 정해 주세요.' : /weak|short|characters/i.test(m) ? '더 어려운 비밀번호로 정해 주세요.' : '바꾸지 못했습니다: ' + m;
      } finally { $('#pwOk').disabled = false; }
    };
    $('#pwOk').onclick = ok;
    $('#pw2').addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  }
  $('#btnPw').onclick = () => pwDialog(false);
  $('#btnForgot').onclick = async () => {
    const email = $('#email').value.trim();
    $('#loginErr').textContent = '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('#loginErr').textContent = '위 아이디(이메일) 칸에 본인 이메일을 넣고 다시 눌러 주세요.'; return; }
    try {
      await store.resetMail(email);
      $('#loginErr').innerHTML = '<span style="color:var(--ok)">' + esc(email) + ' 로 비밀번호 재설정 메일을 보냈습니다. 메일의 링크를 누르세요.<br>메일이 안 오면 관리자에게 초기화를 부탁하세요.</span>';
    } catch (e) {
      $('#loginErr').textContent = /rate|seconds/i.test(e.message) ? '잠시 뒤 다시 눌러 주세요. (메일은 몇 분에 한 번만 보낼 수 있습니다)' : '보내지 못했습니다. 관리자에게 비밀번호 초기화를 부탁하세요.';
    }
  };

  // ---------------------------------------------------------------- 시작
  async function start() {
    const hp = new URLSearchParams(location.hash.slice(1));
    if (hp.get('error')) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => { $('#loginErr').textContent = /expired|invalid/i.test(hp.get('error_description') || hp.get('error_code') || '') ? '메일 링크가 만료됐습니다. [비밀번호를 잊었어요]를 다시 눌러 새 메일을 받으세요.' : '메일 링크로 들어가지 못했습니다: ' + (hp.get('error_description') || hp.get('error')); }, 0);
    }
    $('#appTitle').textContent = CFG.TITLE || '응급실 간호 근무표';
    if (store.local) { $('#modeTag').classList.remove('hidden'); $('#btnPw').classList.add('hidden'); $('#btnForgot').classList.add('hidden'); }
    const ses = await store.session().catch(() => null);
    if (!ses) { $('#login').classList.remove('hidden'); return; }
    S.user = ses.user && ses.user.email || '';
    $('#who').textContent = S.user;
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    await loadAll();
    let seen = '1';
    try { seen = localStorage.getItem('afch-roster:tourDone'); } catch (e) { /* 무시 */ }
    if (!seen) startTour();
  }
  $('#btnTour').onclick = () => startTour();
  $('#btnLogin').onclick = async () => {
    $('#loginErr').textContent = '';
    try { await store.login($('#email').value.trim(), $('#pw').value); $('#pw').value = ''; await start(); }
    catch (e) { $('#loginErr').textContent = '로그인 실패: 아이디나 비밀번호를 확인하세요.'; }
  };
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnLogin').click(); });
  $('#btnLogout').onclick = async () => { await flush(); await store.logout(); location.reload(); };
  $('#btnReload').onclick = async () => { await flush(); await loadAll(); toast('최신 내용을 불러왔습니다.'); };
  start().catch(e => { document.body.innerHTML = '<div class="card err" style="margin:20px">시작하지 못했습니다: ' + esc(e.message) + '</div>'; });
})();
