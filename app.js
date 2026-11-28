'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
// Local date (not toISOString) so Dhaka mornings never show yesterday's date.
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const thisMonth = () => today().slice(0, 7);
const bn = n => String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
const taka = n => '৳' + bn(Number(n).toLocaleString('en-US'));
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function waLink(phone, text) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (!p) return null;
  if (p.startsWith('0')) p = '88' + p;
  else if (p.length === 10 && !p.startsWith('88')) p = '880' + p;
  return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
}

let db, S = [], A = [], P = [];
let tab = 'dash', editId = null, ledgerId = null, receiptId = null;
let attDate = today(), payMonth = thisMonth(), repMonth = thisMonth();
let stuSearch = '', stuFilter = 'all', stuFormOpen = false;
let payShowInactive = false, repOpen = false, dataOpen = false;

const toast = m => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2400); };
const safe = fn => async (...a) => { try { await fn(...a); } catch (err) { console.error(err); toast('সমস্যা হয়েছে: ' + ((err && err.message) || err)); } };

/* ---------- storage ---------- */
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tuition-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('students', { keyPath: 'id' });
      d.createObjectStore('attendance', { keyPath: 'key' });
      d.createObjectStore('payments', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const q = fn(t.objectStore(store));
    let out;
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const getAll = s => tx(s, 'readonly', o => o.getAll());
const put = (s, v) => tx(s, 'readwrite', o => o.put(v));
const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));

function multi(fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(['students', 'attendance', 'payments'], 'readwrite');
    fn(t.objectStore('students'), t.objectStore('attendance'), t.objectStore('payments'));
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error);
  });
}
function removeStudent(id) {
  return multi((s, a, p) => {
    s.delete(id);
    A.filter(x => x.studentId === id).forEach(x => a.delete(x.key));
    P.filter(x => x.studentId === id).forEach(x => p.delete(x.id));
  });
}
function importAll(d) {
  const okS = x => x && typeof x.id === 'string' && typeof x.name === 'string' && Number.isInteger(x.fee) && x.fee >= 0;
  const okA = x => x && typeof x.key === 'string' && typeof x.studentId === 'string' && typeof x.date === 'string' && (x.status === 'p' || x.status === 'a');
  const okP = x => x && typeof x.id === 'string' && typeof x.studentId === 'string' && /^\d{4}-\d{2}$/.test(x.month) && Number.isInteger(x.amount) && x.amount > 0 && typeof x.paidAt === 'string';
  if (!d || d.app !== 'tuition' || !Array.isArray(d.students) || !Array.isArray(d.attendance) || !Array.isArray(d.payments)) throw new Error('এটি সঠিক ব্যাকআপ ফাইল নয়');
  if (!d.students.every(okS) || !d.attendance.every(okA) || !d.payments.every(okP)) throw new Error('ব্যাকআপ ফাইলের ডেটা ত্রুটিপূর্ণ');
  const stu = d.students.map(x => ({
    id: x.id,
    name: x.name,
    joinDate: x.joinDate || (x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : today()),
    cls: String(x.cls || ''),
    subject: String(x.subject || ''),
    phone: String(x.phone || ''),
    gphone: String(x.gphone || ''),
    fee: x.fee,
    active: x.active !== false,
    createdAt: x.createdAt || Date.now()
  }));
  const ids = new Set(stu.map(x => x.id));
  return multi((s, a, p) => {
    s.clear(); a.clear(); p.clear();
    stu.forEach(x => s.put(x));
    d.attendance.filter(x => ids.has(x.studentId)).forEach(x => a.put({ key: x.key, studentId: x.studentId, date: x.date, status: x.status }));
    d.payments.filter(x => ids.has(x.studentId)).forEach(x => p.put({
      id: x.id,
      studentId: x.studentId,
      month: x.month,
      amount: x.amount,
      method: String(x.method || 'ক্যাশ'),
      paidAt: x.paidAt
    }));
  });
}

async function load() {
  [S, A, P] = await Promise.all([getAll('students'), getAll('attendance'), getAll('payments')]);
  S.sort((a, b) => a.name.localeCompare(b.name, 'bn'));
  render();
}

/* ---------- helpers ---------- */
const paidOf = (id, m) => P.filter(p => p.studentId === id && p.month === m).reduce((a, p) => a + p.amount, 0);
const sname = id => (S.find(s => s.id === id) || {}).name || '?';
const attOf = (id, d) => A.find(a => a.key === id + '|' + d);
const empty = t => '<p class="mu" style="margin:8px 0">' + t + '</p>';

function daysStudying(joinDate, createdAt) {
  const jd = joinDate || (createdAt ? new Date(createdAt).toISOString().slice(0, 10) : '');
  if (!jd) return 0;

  const [y, m, d] = jd.split('-').map(Number);
  const [ty, tm, td] = today().split('-').map(Number);

  const start = Date.UTC(y, m - 1, d);
  const current = Date.UTC(ty, tm - 1, td);

  if (isNaN(start) || start > current) return 0;

  return Math.floor((current - start) / 86400000) + 1;
}

/* ---------- views ---------- */
function vDash() {
  const m = thisMonth(), d = today(), act = S.filter(s => s.active);
  const exp = act.reduce((a, s) => a + s.fee, 0);
  const coll = P.filter(p => p.month === m).reduce((a, p) => a + p.amount, 0);
  const dues = act.map(s => ({ s, due: s.fee - paidOf(s.id, m) })).filter(x => x.due > 0);
  const dueT = dues.reduce((a, x) => a + x.due, 0);
  const pr = act.filter(s => (attOf(s.id, d) || {}).status === 'p').length;
  const ab = act.filter(s => (attOf(s.id, d) || {}).status === 'a').length;
  const un = act.length - pr - ab;

  return '<div class="hero-card">' +
      '<div class="hero-main">' +
        '<small>এ মাসে মোট বকেয়া</small>' +
        '<b class="' + (dueT > 0 ? 'no' : 'ok') + '">' + taka(dueT) + '</b>' +
      '</div>' +
      '<div>' + (dueT > 0 ? '<span class="pill no">' + bn(dues.length) + ' জনের বাকি</span>' : '<span class="pill ok">সব পরিশোধিত ✨</span>') + '</div>' +
    '</div>' +
    '<div class="stats">' +
      '<div class="stat"><small>সক্রিয় স্টুডেন্ট</small><b>' + bn(act.length) + ' জন</b></div>' +
      '<div class="stat"><small>এ মাসে প্রাপ্য</small><b>' + taka(exp) + '</b></div>' +
      '<div class="stat"><small>এ মাসে আদায়</small><b class="ok">' + taka(coll) + '</b></div>' +
    '</div>' +
    '<section class="blk">' +
      '<h2>আজকের হাজিরা (' + bn(act.length) + ' জন)</h2>' +
      '<div class="acts" style="gap:6px">' +
        '<span class="pill ok">উপস্থিত ' + bn(pr) + '</span>' +
        '<span class="pill no">অনুপস্থিত ' + bn(ab) + '</span>' +
        (un > 0 ? '<span class="pill neutral">বাকি ' + bn(un) + '</span>' : '') +
      '</div>' +
    '</section>' +
    '<section class="blk"><h2>বাকির তালিকা (' + bn(dues.length) + ')</h2>' + (dues.length ? dues.map(x => {
      const phone = x.s.gphone || x.s.phone;
      const wa = phone ? waLink(phone, 'আসসালামু আলাইকুম। ' + x.s.name + '-এর ' + bn(m) + ' মাসের টিউশন ফি ' + taka(x.due) + ' বাকি রয়েছে। অনুগ্রহ করে সুবিধাজনক সময়ে পরিশোধের অনুরোধ রইল।') : null;
      return '<div class="line"><span><b style="cursor:pointer" data-act="ledger" data-id="' + esc(x.s.id) + '">' + esc(x.s.name) + '</b><small>' + esc(x.s.cls || 'ক্লাস উল্লেখ নেই') + '</small></span>' +
        '<span class="acts"><b class="no" style="font-size:15px">' + taka(x.due) + '</b>' +
        (wa ? '<a class="btn sm wa" target="_blank" href="' + wa + '">তাগিদ</a>' : '') +
        '<button class="btn sm ghost" data-act="ledger" data-id="' + esc(x.s.id) + '">খাতা</button></span></div>';
    }).join('') : empty('এ মাসে কারও বাকি নেই।')) + '</section>';
}

function stuListHtml() {
  const q = stuSearch.trim().toLowerCase();
  let list = S;
  if (stuFilter === 'active') list = list.filter(s => s.active);
  else if (stuFilter === 'inactive') list = list.filter(s => !s.active);

  if (q) {
    list = list.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.cls || '').toLowerCase().includes(q) ||
      (s.subject || '').toLowerCase().includes(q) ||
      (s.phone || '').includes(q) ||
      (s.gphone || '').includes(q)
    );
  }

  if (!list.length) {
    return empty(q ? 'কোনো স্টুডেন্ট পাওয়া যায়নি।' : 'এই ক্যাটাগরিতে কোনো স্টুডেন্ট নেই।');
  }

  return list.map(s => {
    const days = daysStudying(s.joinDate, s.createdAt);
    const initial = (s.name || '?').trim().charAt(0);
    const wa = (s.gphone || s.phone) ? waLink(s.gphone || s.phone, 'আসসালামু আলাইকুম, ' + s.name + '-এর বিষয়ে যোগাযোগ করছি।') : null;

    return '<div class="stu-card">' +
      '<div style="display:flex;gap:12px;align-items:flex-start">' +
        '<div class="stu-avatar">' + esc(initial) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
            '<b style="cursor:pointer;font-size:16px" data-act="ledger" data-id="' + esc(s.id) + '">' + esc(s.name) + '</b>' +
            (s.active ? '<span class="pill ok" style="font-size:11px">পড়ছে</span>' : '<span class="pill neutral" style="font-size:11px">পড়া বন্ধ</span>') +
          '</div>' +
          '<div class="stu-meta">' +
            '<span>' + esc([s.cls, s.subject].filter(Boolean).join(', ') || 'সাধারণ') + '</span>' +
            '<span>•</span>' +
            '<span>ফি: <b>' + taka(s.fee) + '</b></span>' +
            (days > 0 ? '<span>•</span><span>' + (s.active ? 'পড়ানো হচ্ছে ' : 'পড়ানো হয়েছিল ') + bn(days) + ' দিন</span>' : '') +
          '</div>' +
          '<div class="stu-contacts">' +
            (s.phone ? '<a class="tel-link" href="tel:' + esc(s.phone) + '">📞 ছাত্র: ' + esc(s.phone) + '</a>' : '') +
            (s.gphone ? '<a class="tel-link" href="tel:' + esc(s.gphone) + '">📞 অভিভাবক: ' + esc(s.gphone) + '</a>' : '') +
            (wa ? '<a class="btn sm wa" target="_blank" href="' + wa + '">WhatsApp</a>' : '') +
          '</div>' +
          '<div class="stu-actions">' +
            '<button class="btn sm ghost" data-act="ledger" data-id="' + esc(s.id) + '">📋 খাতা</button>' +
            '<button class="btn sm ghost" data-act="edit" data-id="' + esc(s.id) + '">✏️ তথ্য বদলান</button>' +
            '<button class="btn sm danger" data-act="delstu" data-id="' + esc(s.id) + '">🗑️ মুছুন</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function vStu() {
  const isFormVisible = stuFormOpen || editId !== null;
  const e = S.find(s => s.id === editId) || { name: '', cls: '', subject: '', phone: '', gphone: '', fee: '', active: true, joinDate: today() };
  const actCount = S.filter(s => s.active).length;
  const inactCount = S.length - actCount;

  return '<section class="blk">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">' +
      '<div>' +
        '<h2 style="margin:0;font-size:18px">স্টুডেন্ট তালিকা (' + bn(S.length) + ' জন)</h2>' +
        '<small class="mu">সক্রিয়: ' + bn(actCount) + ' জন | পড়া বন্ধ: ' + bn(inactCount) + ' জন</small>' +
      '</div>' +
      '<button class="btn sm ' + (isFormVisible ? 'ghost' : 'primary') + '" data-act="toggle-stu-form">' +
        (isFormVisible ? '✕ ফর্ম লুকান' : '+ নতুন স্টুডেন্ট যোগ করুন') +
      '</button>' +
    '</div>' +
    '</section>' +
    (isFormVisible ?
      '<section class="blk" style="border-color:var(--ac);box-shadow:0 0 0 1px var(--ac)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<h2 style="margin:0;color:var(--ac)">' + (editId ? '✏️ স্টুডেন্টের তথ্য বদলান' : '➕ নতুন স্টুডেন্ট যোগ করুন') + '</h2>' +
          '<button class="btn sm ghost" data-act="cancel">বাতিল</button>' +
        '</div>' +
        '<form id="sf" autocomplete="off">' +
          '<label>নাম<input name="name" required maxlength="80" placeholder="যেমন: ফারহান আহমেদ" value="' + esc(e.name) + '"></label>' +
          '<label>পড়ানো শুরু করার তারিখ<input name="joinDate" type="date" max="' + today() + '" required value="' + esc(e.joinDate || today()) + '"></label>' +
          '<div class="two"><label>ক্লাস<input name="cls" maxlength="30" placeholder="যেমন: ৯ম শ্রেণি" value="' + esc(e.cls) + '"></label>' +
          '<label>বিষয়<input name="subject" maxlength="60" placeholder="যেমন: গণিত ও পদার্থ" value="' + esc(e.subject) + '"></label></div>' +
          '<div class="two"><label>স্টুডেন্টের ফোন<input name="phone" type="tel" placeholder="017XXXXXXXX" value="' + esc(e.phone) + '"></label>' +
          '<label>অভিভাবকের ফোন<input name="gphone" type="tel" placeholder="018XXXXXXXX" value="' + esc(e.gphone) + '"></label></div>' +
          '<label>মাসিক ফি (টাকা)<input name="fee" type="number" min="0" step="1" inputmode="numeric" placeholder="যেমন: ২০০০" required value="' + esc(e.fee) + '"></label>' +
          '<label class="chk" style="margin:14px 0"><input name="active" type="checkbox"' + (e.active ? ' checked' : '') + '> এখনো নিয়মিত পড়ছে</label>' +
          '<div class="acts"><button class="btn primary" type="submit">সেভ করুন</button>' +
          '<button class="btn ghost" type="button" data-act="cancel">বাতিল</button></div>' +
        '</form>' +
      '</section>'
    : '') +
    '<section class="blk">' +
      '<div class="filter-tabs">' +
        '<button class="filter-btn ' + (stuFilter === 'all' ? 'on' : '') + '" data-act="stu-filter" data-filter="all">সবাই (' + bn(S.length) + ')</button>' +
        '<button class="filter-btn ' + (stuFilter === 'active' ? 'on' : '') + '" data-act="stu-filter" data-filter="active">নিয়মিত (' + bn(actCount) + ')</button>' +
        '<button class="filter-btn ' + (stuFilter === 'inactive' ? 'on' : '') + '" data-act="stu-filter" data-filter="inactive">পড়া বন্ধ (' + bn(inactCount) + ')</button>' +
      '</div>' +
      '<label style="margin-bottom:14px"><input type="search" id="stusearch" placeholder="নাম, ক্লাস, বিষয় বা ফোন দিয়ে খুঁজুন..." value="' + esc(stuSearch) + '"></label>' +
      '<div id="stu-list">' + stuListHtml() + '</div>' +
    '</section>';
}

function vAtt() {
  const act = S.filter(s => s.active);
  const pr = act.filter(s => (attOf(s.id, attDate) || {}).status === 'p').length;
  const ab = act.filter(s => (attOf(s.id, attDate) || {}).status === 'a').length;
  const un = act.length - pr - ab;

  return '<section class="blk"><h2>হাজিরা</h2>' +
    '<label>তারিখ<input type="date" id="attd" max="' + today() + '" value="' + esc(attDate) + '"></label>' +
    (act.length ? '<div class="acts" style="margin-top:12px">' +
      '<button class="btn sm okb" data-act="att-all-p">সবাই উপস্থিত</button>' +
      '<button class="btn sm ghost danger" data-act="att-clear">হাজিরা মুছুন</button>' +
    '</div>' +
    '<div class="acts" style="margin-top:12px;gap:6px">' +
      '<span class="pill ok">উপস্থিত ' + bn(pr) + '</span>' +
      '<span class="pill no">অনুপস্থিত ' + bn(ab) + '</span>' +
      (un > 0 ? '<span class="pill neutral">বাকি ' + bn(un) + '</span>' : '') +
    '</div>' : '') +
    '</section>' +
    '<section class="blk">' + (act.length ? act.map(s => {
      const st = (attOf(s.id, attDate) || {}).status;
      const phone = s.gphone || s.phone;
      const waAbsent = (st === 'a' && phone) ? waLink(phone, 'আসসালামু আলাইকুম। আপনার সন্তান ' + s.name + ' আজ ' + bn(attDate) + ' তারিখে টিউশনে উপস্থিত ছিল না।') : null;

      return '<div class="line"><span><b style="cursor:pointer;font-size:15px" data-act="ledger" data-id="' + esc(s.id) + '">' + esc(s.name) + '</b><small>' + esc(s.cls || 'ক্লাস উল্লেখ নেই') + '</small></span>' +
        '<span class="acts">' +
        '<button class="btn sm ' + (st === 'p' ? 'okb' : 'ghost') + '" data-act="att" data-st="p" data-id="' + esc(s.id) + '">উপস্থিত</button>' +
        '<button class="btn sm ' + (st === 'a' ? 'nob' : 'ghost') + '" data-act="att" data-st="a" data-id="' + esc(s.id) + '">অনুপস্থিত</button>' +
        (waAbsent ? '<a class="btn sm wa" target="_blank" href="' + waAbsent + '">নোটিশ</a>' : '') +
        '</span></div>';
    }).join('') : empty('আগে স্টুডেন্ট যোগ করুন।')) + '</section>';
}

function vPay() {
  const targetList = payShowInactive
    ? S
    : S.filter(s => s.active || paidOf(s.id, payMonth) > 0 || (s.fee - paidOf(s.id, payMonth)) > 0);
  const list = P.filter(p => p.month === payMonth).sort((a, b) => b.paidAt.localeCompare(a.paidAt));

  return '<section class="blk"><h2>বেতন</h2>' +
    '<label>মাস নির্বাচন করুন<input type="month" id="paym" value="' + esc(payMonth) + '"></label>' +
    '<label class="chk" style="margin-top:10px;font-size:13.5px"><input type="checkbox" id="payinact"' + (payShowInactive ? ' checked' : '') + '> সাবেক / নিষ্ক্রিয় সব স্টুডেন্ট দেখান</label>' +
    '</section>' +
    '<section class="blk">' + (targetList.length ? targetList.map(s => {
      const pd = paidOf(s.id, payMonth), due = s.fee - pd;
      const phone = s.gphone || s.phone;
      const waDue = (due > 0 && phone) ? waLink(phone, 'আসসালামু আলাইকুম। ' + s.name + '-এর ' + bn(payMonth) + ' মাসের টিউশন ফি ' + taka(due) + ' বাকি রয়েছে। অনুগ্রহ করে পরিশোধ করবেন। ধন্যবাদ।') : null;

      return '<div class="row" data-id="' + esc(s.id) + '">' +
        '<div class="line" style="border-top:0;padding:0">' +
          '<div>' +
            '<b style="cursor:pointer;font-size:15px" data-act="ledger" data-id="' + esc(s.id) + '">' + esc(s.name) + '</b>' +
            (s.active ? '' : ' <span class="pill neutral" style="font-size:11px">নিষ্ক্রিয়</span>') +
            '<small>ফি ' + taka(s.fee) + ', দিয়েছে ' + taka(pd) + '</small>' +
          '</div>' +
          '<div class="acts">' +
            '<span class="pill ' + (due > 0 ? 'no' : 'ok') + '">' + (due > 0 ? 'বাকি ' + taka(due) : due < 0 ? 'বেশি ' + taka(-due) : 'পরিশোধিত') + '</span>' +
            (waDue ? '<a class="btn sm wa" target="_blank" href="' + waDue + '">তাগিদ</a>' : '') +
          '</div>' +
        '</div>' +
        '<div class="pay-bar">' +
          '<input type="number" min="1" step="1" inputmode="numeric" placeholder="টাকা" value="' + (due > 0 ? due : '') + '">' +
          '<select class="pay-method"><option value="ক্যাশ">ক্যাশ</option><option value="বিকাশ">বিকাশ</option><option value="নগদ">নগদ</option><option value="রকেট">রকেট</option><option value="ব্যাংক">ব্যাংক</option></select>' +
          '<input type="date" class="pay-date" max="' + today() + '" value="' + today() + '">' +
          '<button class="btn sm primary btn-pay" data-act="pay">জমা নিন</button>' +
        '</div>' +
      '</div>';
    }).join('') : empty('কোনো স্টুডেন্ট নেই।')) + '</section>' +
    '<section class="blk"><h2>এ মাসের জমার হিসাব</h2>' + (list.length ? list.map(p =>
      '<div class="line"><span>' + esc(sname(p.studentId)) + '<small>' + esc(bn(p.paidAt)) + ' (' + esc(p.method || 'ক্যাশ') + ')</small></span>' +
      '<span class="acts"><b style="font-size:15px">' + taka(p.amount) + '</b>' +
      '<button class="btn sm ghost" data-act="receipt" data-id="' + esc(p.id) + '">রসিদ</button>' +
      '<button class="btn sm danger" data-act="delpay" data-id="' + esc(p.id) + '">মুছুন</button></span></div>').join('') : empty('এ মাসে এখনো কোনো জমা নেই।')) + '</section>';
}

function report(m = repMonth) {
  const rel = S.filter(s => s.active || paidOf(s.id, m) > 0 || A.some(a => a.studentId === s.id && a.date.slice(0, 7) === m));
  const col = P.filter(p => p.month === m).reduce((x, p) => x + p.amount, 0);
  let out = 'টিউশন রিপোর্ট, ' + bn(m) + '\n\n', due = 0;
  if (!rel.length) return out + 'এই মাসের কোনো তথ্য নেই।';
  rel.forEach(s => {
    const pd = paidOf(s.id, m), d = Math.max(0, s.fee - pd); due += d;
    const cnt = st => A.filter(a => a.studentId === s.id && a.date.slice(0, 7) === m && a.status === st).length;
    out += s.name + (s.cls ? ' (' + s.cls + ')' : '') + (s.active ? '' : ' [পড়া বন্ধ]') + '\n  ফি ' + taka(s.fee) + ', জমা ' + taka(pd) + ', বাকি ' + taka(d) +
      '\n  উপস্থিত ' + bn(cnt('p')) + ' দিন, অনুপস্থিত ' + bn(cnt('a')) + ' দিন\n';
  });
  return out + '\nমোট আদায়: ' + taka(col) + '\nমোট বাকি: ' + taka(due);
}
const markBackup = () => { try { localStorage.setItem('lastBackup', today()); } catch (e) { /* ignore */ } };

function tablesHtml() {
  const cnt = (id, st) => A.filter(a => a.studentId === id && a.status === st).length;
  const stu = S.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.cls) + '</td><td>' + esc(x.subject) + '</td><td>' + esc(x.joinDate || '') + '</td><td>' + esc(x.phone || '') + '</td><td>' + esc(x.gphone || '') + '</td><td>' + taka(x.fee) + '</td><td>' + (x.active ? 'পড়ছে' : 'পড়ছে না') + '</td></tr>').join('');
  const att = S.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + bn(cnt(x.id, 'p')) + '</td><td>' + bn(cnt(x.id, 'a')) + '</td></tr>').join('');
  const pay = [...P].sort((a, b) => b.paidAt.localeCompare(a.paidAt)).map(x => '<tr><td>' + esc(bn(x.paidAt)) + '</td><td>' + esc(sname(x.studentId)) + '</td><td>' + esc(bn(x.month)) + '</td><td>' + esc(x.method || 'ক্যাশ') + '</td><td>' + taka(x.amount) + '</td></tr>').join('');
  return '<h2>স্টুডেন্ট</h2><table><tr><th>নাম</th><th>ক্লাস</th><th>বিষয়</th><th>শুরুর তারিখ</th><th>ফোন</th><th>অভিভাবকের ফোন</th><th>ফি</th><th>অবস্থা</th></tr>' + stu + '</table>' +
    '<h2>হাজিরা (মোট দিন)</h2><table><tr><th>নাম</th><th>উপস্থিত</th><th>অনুপস্থিত</th></tr>' + att + '</table>' +
    '<h2>বেতন জমা</h2><table><tr><th>তারিখ</th><th>নাম</th><th>মাস</th><th>মেথড</th><th>টাকা</th></tr>' + pay + '</table>';
}

function backupHtml() {
  const data = { app: 'tuition', version: 1, exported: new Date().toISOString(), students: S, attendance: A, payments: P };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
    '<title>টিউশন ব্যাকআপ ' + today() + '</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:auto;padding:16px}h1{font-size:20px}h2{font-size:17px;margin-top:24px}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #8886;padding:8px;text-align:left;font-size:14px}th{background:#8882}.n{border:1px solid #e3b52c;border-radius:8px;padding:12px;background:#e3b52c15}</style></head><body>' +
    '<h1>টিউশন ব্যাকআপ, ' + esc(bn(today())) + '</h1><p class="n">এই ফাইলে আপনার সব ডেটা আছে। অ্যাপের ব্যাকআপ ট্যাবে "ফাইল বেছে নিন" চেপে এই ফাইলটি দিলে ডেটা ফিরে আসবে। ফাইলটি বদলাবেন না।</p>' +
    tablesHtml() +
    '<script type="application/json" id="tuition-data">' + json + '</script></body></html>';
}
async function readBackup(file) {
  const txt = await file.text();
  if (/^\s*</.test(txt)) {
    const el = new DOMParser().parseFromString(txt, 'text/html').getElementById('tuition-data');
    if (!el) throw new Error('এই ফাইলে ব্যাকআপের ডেটা পাওয়া যায়নি');
    return JSON.parse(el.textContent);
  }
  return JSON.parse(txt);
}

function dataSection() {
  return '<section class="blk"><h2>সব তথ্য দেখুন</h2><p class="mu">স্টুডেন্ট, হাজিরা ও বেতনের সব হিসাব এক পেজে।</p>' +
    '<div class="acts"><button class="btn ghost" data-act="data">' + (dataOpen ? 'লুকান' : 'দেখুন') + '</button></div>' +
    (dataOpen ? '<style>.dt table{border-collapse:collapse;width:100%}.dt th,.dt td{border:1px solid var(--bd);padding:8px 10px;text-align:left;font-size:14px}.dt th{background:var(--bg)}.dt h2{font-size:16px;margin:16px 0 8px}</style><div class="dt" style="overflow-x:auto">' + tablesHtml() + '</div>' : '') + '</section>';
}

function vBak() {
  let last = 'এখনো নেওয়া হয়নি';
  try { const v = localStorage.getItem('lastBackup'); if (v) last = v; } catch (e) { /* storage blocked */ }
  return dataSection() + '<section class="blk"><h2>ব্যাকআপ নিন</h2><p class="mu">সব ডেটা শুধু এই ডিভাইসের ব্রাউজারে থাকে। বাটন চাপলে ফাইল ডাউনলোড বা শেয়ার হবে, সেখান থেকে Google Drive, WhatsApp বা Files-এ সেভ করে রাখুন।</p>' +
    '<p>শেষ ব্যাকআপ: ' + esc(bn(last)) + '</p><div class="acts"><button class="btn primary" data-act="exp">ব্যাকআপ সেভ করুন</button></div></section>' +
    '<section class="blk"><h2>ডেটা ফিরিয়ে আনুন</h2><p class="mu">আগে সেভ করা ব্যাকআপ ফাইলটি বেছে নিন।</p>' +
    '<label class="btn ghost" style="margin:0;display:inline-block">ফাইল বেছে নিন<input type="file" id="imp" hidden></label></section>' +
    '<section class="blk"><h2>মাসিক রিপোর্ট (' + bn(repMonth) + ')</h2><p class="mu">পড়ার মতো সহজ লেখা, WhatsApp-এ পাঠানো যায়।</p>' +
    '<label>রিপোর্টের মাস<input type="month" id="repm" value="' + esc(repMonth) + '"></label>' +
    '<div class="acts" style="margin-top:12px"><button class="btn ghost" data-act="rep">' + (repOpen ? 'লুকান' : 'রিপোর্ট দেখুন') + '</button>' +
    (repOpen ? '<button class="btn primary" data-act="rshare">শেয়ার করুন</button>' : '') + '</div>' +
    (repOpen ? '<pre class="rep">' + esc(report(repMonth)) + '</pre>' : '') + '</section>';
}

function vLedger(id) {
  const s = S.find(x => x.id === id);
  if (!s) return '';
  const atts = A.filter(a => a.studentId === id).sort((a, b) => b.date.localeCompare(a.date));
  const pays = P.filter(p => p.studentId === id).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const pCount = atts.filter(a => a.status === 'p').length;
  const aCount = atts.filter(a => a.status === 'a').length;
  const totalClasses = pCount + aCount;
  const attRate = totalClasses ? Math.round((pCount / totalClasses) * 100) : 0;
  const totalPaid = pays.reduce((sum, p) => sum + p.amount, 0);
  const days = daysStudying(s.joinDate, s.createdAt);

  const phone = s.gphone || s.phone;
  const wa = phone ? waLink(phone, 'আসসালামু আলাইকুম, ' + s.name + '-এর বিষয়ে যোগাযোগ করছি।') : null;

  return '<div class="modal-overlay" data-act="close-ledger">' +
    '<div class="modal" onclick="event.stopPropagation()">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border-bottom:1px solid var(--bd);padding-bottom:10px">' +
        '<h2 style="margin:0;font-size:18px">' + esc(s.name) + ' এর খাতা</h2>' +
        '<button class="btn sm ghost" data-act="close-ledger">✕ বন্ধ</button>' +
      '</div>' +
      '<div class="two" style="margin-bottom:12px">' +
        '<div><small class="mu">ক্লাস ও বিষয়</small><div><b>' + esc([s.cls, s.subject].filter(Boolean).join(', ') || 'সাধারণ') + '</b></div></div>' +
        '<div><small class="mu">মাসিক ফি</small><div><b>' + taka(s.fee) + '</b></div></div>' +
      '</div>' +
      '<div class="two" style="margin-bottom:12px">' +
        '<div><small class="mu">শুরুর তারিখ</small><div>' + esc(bn(s.joinDate || '')) + ' (' + bn(days) + ' দিন)</div></div>' +
        '<div><small class="mu">বর্তমান অবস্থা</small><div>' + (s.active ? '<span class="pill ok">পড়ছে</span>' : '<span class="pill neutral">পড়া বন্ধ</span>') + '</div></div>' +
      '</div>' +
      '<div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        (s.phone ? '<a class="tel-link" href="tel:' + esc(s.phone) + '">📞 ছাত্র: ' + esc(s.phone) + '</a>' : '') +
        (s.gphone ? '<a class="tel-link" href="tel:' + esc(s.gphone) + '">📞 অভিভাবক: ' + esc(s.gphone) + '</a>' : '') +
        (wa ? '<a class="btn sm wa" target="_blank" href="' + wa + '">WhatsApp</a>' : '') +
      '</div>' +
      '<div class="stats" style="margin-bottom:16px">' +
        '<div class="stat"><small>মোট হাজিরা</small><b>' + bn(pCount) + ' দিন</b><span style="font-size:12px;color:var(--mu)">অনুপস্থিত ' + bn(aCount) + ' (' + bn(attRate) + '%)</span></div>' +
        '<div class="stat"><small>মোট পরিশোধ</small><b class="ok">' + taka(totalPaid) + '</b><span style="font-size:12px;color:var(--mu)">' + bn(pays.length) + ' বার জমা</span></div>' +
      '</div>' +
      '<h2 style="font-size:15px;margin:16px 0 8px">পেমেন্টের ইতিহাস</h2>' +
      '<div style="max-height:160px;overflow-y:auto;border:1px solid var(--bd);border-radius:var(--radius);padding:4px 10px;margin-bottom:14px">' +
        (pays.length ? pays.map(p => '<div class="line" style="padding:8px 0"><span>' + esc(bn(p.paidAt)) + ' (' + esc(bn(p.month)) + ')<small>' + esc(p.method || 'ক্যাশ') + '</small></span>' +
          '<span class="acts"><b>' + taka(p.amount) + '</b><button class="btn sm ghost" data-act="receipt" data-id="' + esc(p.id) + '">রসিদ</button></span></div>').join('') : empty('এখনো কোনো পেমেন্ট রেকর্ড নেই।')) +
      '</div>' +
      '<h2 style="font-size:15px;margin:16px 0 8px">সাম্প্রতিক হাজিরা</h2>' +
      '<div style="max-height:140px;overflow-y:auto;border:1px solid var(--bd);border-radius:var(--radius);padding:4px 10px">' +
        (atts.length ? atts.slice(0, 15).map(a => '<div class="line" style="padding:6px 0"><span>' + esc(bn(a.date)) + '</span>' +
          '<span class="pill ' + (a.status === 'p' ? 'ok' : 'no') + '">' + (a.status === 'p' ? 'উপস্থিত' : 'অনুপস্থিত') + '</span></div>').join('') : empty('কোনো হাজিরার রেকর্ড নেই।')) +
      '</div>' +
    '</div></div>';
}

function vReceipt(id) {
  const p = P.find(x => x.id === id);
  if (!p) return '';
  const s = S.find(x => x.id === p.studentId);
  const sName = s ? s.name : 'স্টুডেন্ট';
  const phone = s ? (s.gphone || s.phone) : '';
  const text = 'মানি রসিদ\n------------------------\nশিক্ষার্থী: ' + sName +
    (s && s.cls ? '\nক্লাস: ' + s.cls : '') +
    '\nমাস: ' + bn(p.month) +
    '\nজমার তারিখ: ' + bn(p.paidAt) +
    '\nপেমেন্ট মেথড: ' + (p.method || 'ক্যাশ') +
    '\nগৃহীত টাকা: ' + taka(p.amount) +
    '\nঅবস্থা: পরিশোধিত ✅\n------------------------\nধন্যবাদ, টিউশন শিক্ষক।';

  const wa = phone ? waLink(phone, text) : null;

  return '<div class="modal-overlay" data-act="close-receipt">' +
    '<div class="modal" style="max-width:400px" onclick="event.stopPropagation()">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--bd);padding-bottom:10px">' +
        '<h2 style="margin:0;font-size:17px">মানি রসিদ</h2>' +
        '<button class="btn sm ghost" data-act="close-receipt">✕ বন্ধ</button>' +
      '</div>' +
      '<div style="background:var(--bg);border:1px dashed var(--bd);border-radius:var(--radius);padding:14px;font-family:monospace;font-size:14px;line-height:1.7;margin-bottom:14px">' +
        '<div><b>শিক্ষার্থী:</b> ' + esc(sName) + '</div>' +
        (s && s.cls ? '<div><b>ক্লাস:</b> ' + esc(s.cls) + '</div>' : '') +
        '<div><b>মাস:</b> ' + esc(bn(p.month)) + '</div>' +
        '<div><b>জমার তারিখ:</b> ' + esc(bn(p.paidAt)) + '</div>' +
        '<div><b>পেমেন্ট মেথড:</b> ' + esc(p.method || 'ক্যাশ') + '</div>' +
        '<div style="font-size:18px;margin-top:8px;border-top:1px solid var(--bd);padding-top:6px"><b class="ok">আদায়: ' + taka(p.amount) + '</b></div>' +
      '</div>' +
      '<div class="acts">' +
        (wa ? '<a class="btn sm wa" target="_blank" href="' + wa + '">WhatsApp</a>' : '') +
        '<button class="btn sm primary" data-act="copy-receipt" data-text="' + esc(text) + '">কপি রসিদ</button>' +
        '<button class="btn sm ghost" onclick="window.print()">প্রিন্ট</button>' +
      '</div>' +
    '</div></div>';
}

function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const hd = $('#hdr-date');
  if (hd) hd.textContent = bn(today());

  $('#view').innerHTML = { dash: vDash, stu: vStu, att: vAtt, pay: vPay, bak: vBak }[tab]() +
    (ledgerId ? vLedger(ledgerId) : '') +
    (receiptId ? vReceipt(receiptId) : '');
}

/* ---------- events ---------- */
document.addEventListener('input', e => {
  if (e.target.id === 'stusearch') {
    stuSearch = e.target.value;
    const el = $('#stu-list');
    if (el) el.innerHTML = stuListHtml();
  }
});

document.addEventListener('click', safe(async e => {
  const nb = e.target.closest('nav button');
  if (nb) {
    tab = nb.dataset.tab;
    if (tab !== 'stu') { editId = null; stuFormOpen = false; }
    ledgerId = null; receiptId = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (act === 'toggle-stu-form') {
    stuFormOpen = !stuFormOpen;
    if (!stuFormOpen) editId = null;
    render();
  }
  else if (act === 'stu-filter') {
    stuFilter = t.dataset.filter;
    render();
  }
  else if (act === 'edit') {
    editId = id;
    stuFormOpen = true;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  else if (act === 'cancel') {
    editId = null;
    stuFormOpen = false;
    render();
  }
  else if (act === 'ledger') { ledgerId = id; render(); }
  else if (act === 'close-ledger') { ledgerId = null; render(); }
  else if (act === 'receipt') { receiptId = id; render(); }
  else if (act === 'close-receipt') { receiptId = null; render(); }
  else if (act === 'copy-receipt') {
    await navigator.clipboard.writeText(t.dataset.text || '');
    toast('রসিদ কপি হয়েছে');
  }
  else if (act === 'delstu') {
    if (!confirm('এই স্টুডেন্টের সব হাজিরা ও বেতনের রেকর্ডসহ মুছে যাবে। নিশ্চিত?')) return;
    await removeStudent(id); if (editId === id) editId = null; if (ledgerId === id) ledgerId = null; await load(); toast('মুছে ফেলা হয়েছে');
  } else if (act === 'att') {
    const key = id + '|' + attDate, r = A.find(a => a.key === key);
    if (r && r.status === t.dataset.st) await del('attendance', key);
    else await put('attendance', { key, studentId: id, date: attDate, status: t.dataset.st });
    await load();
  } else if (act === 'att-all-p') {
    const actStudents = S.filter(s => s.active);
    if (!actStudents.length) return toast('কোনো সক্রিয় স্টুডেন্ট নেই');
    await multi((s, a, p) => {
      actStudents.forEach(st => {
        a.put({ key: st.id + '|' + attDate, studentId: st.id, date: attDate, status: 'p' });
      });
    });
    await load();
    toast('সবাইকে উপস্থিত করা হয়েছে');
  } else if (act === 'att-clear') {
    const actStudents = S.filter(s => s.active);
    if (!actStudents.length) return toast('কোনো সক্রিয় স্টুডেন্ট নেই');
    await multi((s, a, p) => {
      actStudents.forEach(st => {
        a.delete(st.id + '|' + attDate);
      });
    });
    await load();
    toast('হাজিরা মুছে ফেলা হয়েছে');
  } else if (act === 'pay') {
    const row = t.closest('.row');
    const amt = Number(row.querySelector('input[type=number]').value);
    const method = row.querySelector('.pay-method') ? row.querySelector('.pay-method').value : 'ক্যাশ';
    const pdate = row.querySelector('.pay-date') && row.querySelector('.pay-date').value ? row.querySelector('.pay-date').value : today();
    const studentId = row.dataset.id;
    const student = S.find(s => s.id === studentId);

    if (!student) {
      return toast('স্টুডেন্টের তথ্য পাওয়া যায়নি');
    }

    if (!Number.isInteger(amt) || amt <= 0) {
      return toast('সঠিক টাকার অঙ্ক দিন');
    }

    const due = student.fee - paidOf(studentId, payMonth);

    if (due <= 0) {
      return toast('এই মাসের বেতন ইতিমধ্যে পরিশোধিত');
    }

    if (amt > due) {
      return toast('বাকি টাকার বেশি জমা নেওয়া যাবে না');
    }

    await put('payments', {
      id: uid(),
      studentId,
      month: payMonth,
      amount: amt,
      method,
      paidAt: pdate
    });

    await load();
    toast('জমা হয়েছে');
  } else if (act === 'delpay') {
    if (!confirm('এই জমার হিসাবটি মুছবেন?')) return;
    await del('payments', id); await load();
  } else if (act === 'exp') {
    const file = new File([backupHtml()], 'tuition-backup-' + today() + '.html', { type: 'text/html' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'টিউশন ব্যাকআপ' }); markBackup(); render(); toast('ব্যাকআপ সেভ হয়েছে'); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    markBackup(); render(); toast('ব্যাকআপ ডাউনলোড হচ্ছে');
  } else if (act === 'rep') { repOpen = !repOpen; render(); }
  else if (act === 'data') { dataOpen = !dataOpen; render(); }
  else if (act === 'rshare') {
    const text = report(repMonth);
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
    await navigator.clipboard.writeText(text); toast('কপি হয়েছে');
  }
}));

document.addEventListener('submit', safe(async e => {
  if (e.target.id !== 'sf') return;
  e.preventDefault();
  const f = new FormData(e.target), name = String(f.get('name')).trim(), fee = Number(f.get('fee'));
  const joinDate = String(f.get('joinDate') || '');
  if (!joinDate || joinDate > today()) return toast('সঠিক শুরুর তারিখ দিন');
  if (!name) return toast('নাম লিখুন');
  if (!Number.isInteger(fee) || fee < 0) return toast('ফি পূর্ণ সংখ্যায় দিন');
  const old = S.find(s => s.id === editId);
  await put('students', {
    id: old ? old.id : uid(), name, joinDate, cls: String(f.get('cls')).trim(), subject: String(f.get('subject')).trim(),
    phone: String(f.get('phone')).trim(), gphone: String(f.get('gphone')).trim(), fee,
    active: f.get('active') === 'on', createdAt: old ? old.createdAt : Date.now()
  });
  editId = null;
  stuFormOpen = false;
  await load();
  toast('সেভ হয়েছে');
}));

document.addEventListener('change', safe(async e => {
  const t = e.target;
  if (t.id === 'attd' && t.value) {
    if (t.value > today()) {
      attDate = today();
      toast('ভবিষ্যতের তারিখে হাজিরা দেওয়া যাবে না');
    } else {
      attDate = t.value;
    }
    render();
  }
  else if (t.id === 'paym' && t.value) { payMonth = t.value; render(); }
  else if (t.id === 'repm' && t.value) { repMonth = t.value; render(); }
  else if (t.id === 'payinact') { payShowInactive = t.checked; render(); }
  else if (t.id === 'imp') {
    const file = t.files[0]; if (!file) return;
    let d; try { d = await readBackup(file); } catch (x) { t.value = ''; throw new Error('ফাইলটি পড়া যায়নি'); }
    if (!confirm('বর্তমান সব ডেটা মুছে ব্যাকআপের ডেটা বসবে। নিশ্চিত?')) { t.value = ''; return; }
    try { await importAll(d); } finally { t.value = ''; }
    await load(); toast('ডেটা ফিরিয়ে আনা হয়েছে');
  }
}));

/* ---------- start ---------- */
(async () => {
  try {
    db = await openDb();
    await load();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    console.error(err);
    $('#view').textContent = 'ডেটাবেস চালু করা যায়নি। প্রাইভেট মোড বন্ধ করে আবার খুলুন।';
  }
})();
if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
