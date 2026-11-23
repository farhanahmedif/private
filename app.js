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

let db, S = [], A = [], P = [], tab = 'dash', editId = null, attDate = today(), payMonth = thisMonth(), repOpen = false, dataOpen = false;

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
  const stu = d.students.map(x => ({ id: x.id, name: x.name, cls: String(x.cls || ''), subject: String(x.subject || ''), phone: String(x.phone || ''), gphone: String(x.gphone || ''), fee: x.fee, active: x.active !== false, createdAt: x.createdAt || Date.now() }));
  const ids = new Set(stu.map(x => x.id));
  return multi((s, a, p) => {
    s.clear(); a.clear(); p.clear();
    stu.forEach(x => s.put(x));
    d.attendance.filter(x => ids.has(x.studentId)).forEach(x => a.put({ key: x.key, studentId: x.studentId, date: x.date, status: x.status }));
    d.payments.filter(x => ids.has(x.studentId)).forEach(x => p.put({ id: x.id, studentId: x.studentId, month: x.month, amount: x.amount, paidAt: x.paidAt }));
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
const empty = t => '<p class="mu">' + t + '</p>';

/* ---------- views ---------- */
function vDash() {
  const m = thisMonth(), d = today(), act = S.filter(s => s.active);
  const exp = act.reduce((a, s) => a + s.fee, 0);
  const coll = P.filter(p => p.month === m).reduce((a, p) => a + p.amount, 0);
  const dues = act.map(s => ({ s, due: s.fee - paidOf(s.id, m) })).filter(x => x.due > 0);
  const dueT = dues.reduce((a, x) => a + x.due, 0);
  const pr = act.filter(s => (attOf(s.id, d) || {}).status === 'p').length;
  const ab = act.filter(s => (attOf(s.id, d) || {}).status === 'a').length;
  return '<div class="big"><b>' + taka(dueT) + '</b><span>এ মাসে মোট বাকি</span></div>' +
    '<div class="stats"><div class="stat"><b>' + bn(act.length) + '</b><span>সক্রিয় স্টুডেন্ট</span></div>' +
    '<div class="stat"><b>' + taka(exp) + '</b><span>এ মাসে প্রাপ্য</span></div>' +
    '<div class="stat"><b>' + taka(coll) + '</b><span>এ মাসে আদায়</span></div></div>' +
    '<section class="blk"><h2>আজকের হাজিরা</h2><p>উপস্থিত ' + bn(pr) + ', অনুপস্থিত ' + bn(ab) + ', এখনো নেওয়া হয়নি ' + bn(act.length - pr - ab) + '</p></section>' +
    '<section class="blk"><h2>বাকির তালিকা</h2>' + (dues.length ? dues.map(x =>
      '<div class="line"><span>' + esc(x.s.name) + '<small>' + esc(x.s.cls) + '</small></span><b class="no">' + taka(x.due) + '</b></div>').join('') : empty('এ মাসে কারও বাকি নেই।')) + '</section>';
}

function vStu() {
  const e = S.find(s => s.id === editId) || { name: '', cls: '', subject: '', phone: '', gphone: '', fee: '', active: true };
  return '<section class="blk"><h2>' + (editId ? 'স্টুডেন্টের তথ্য বদলান' : 'নতুন স্টুডেন্ট যোগ করুন') + '</h2>' +
    '<form id="sf" autocomplete="off">' +
    '<label>নাম<input name="name" required maxlength="80" value="' + esc(e.name) + '"></label>' +
    '<div class="two"><label>ক্লাস<input name="cls" maxlength="30" value="' + esc(e.cls) + '"></label>' +
    '<label>বিষয়<input name="subject" maxlength="60" value="' + esc(e.subject) + '"></label></div>' +
    '<div class="two"><label>স্টুডেন্টের ফোন<input name="phone" type="tel" value="' + esc(e.phone) + '"></label>' +
    '<label>অভিভাবকের ফোন<input name="gphone" type="tel" value="' + esc(e.gphone) + '"></label></div>' +
    '<label>মাসিক ফি (টাকা)<input name="fee" type="number" min="0" step="1" inputmode="numeric" required value="' + esc(e.fee) + '"></label>' +
    '<label class="chk"><input name="active" type="checkbox"' + (e.active ? ' checked' : '') + '> এখনো পড়ছে</label>' +
    '<div class="acts"><button class="btn" type="submit">সেভ করুন</button>' +
    (editId ? '<button class="btn ghost" type="button" data-act="cancel">বাতিল</button>' : '') + '</div></form></section>' +
    '<section class="blk"><h2>সব স্টুডেন্ট (' + bn(S.length) + ')</h2>' + (S.length ? S.map(s =>
      '<div class="line"><span>' + esc(s.name) + (s.active ? '' : ' (পড়ছে না)') + '<small>' + esc([s.cls, s.subject].filter(Boolean).join(', ')) + ' ফি ' + taka(s.fee) + '</small></span>' +
      '<span class="acts"><button class="btn sm ghost" data-act="edit" data-id="' + esc(s.id) + '">বদলান</button>' +
      '<button class="btn sm danger" data-act="delstu" data-id="' + esc(s.id) + '">মুছুন</button></span></div>').join('') : empty('এখনো কোনো স্টুডেন্ট নেই। উপরের ফর্ম থেকে যোগ করুন।')) + '</section>';
}

function vAtt() {
  const act = S.filter(s => s.active);
  return '<section class="blk"><h2>হাজিরা</h2><label>তারিখ<input type="date" id="attd" max="' + today() + '" value="' + esc(attDate) + '"></label></section>' +
    '<section class="blk">' + (act.length ? act.map(s => {
      const st = (attOf(s.id, attDate) || {}).status;
      return '<div class="line"><span>' + esc(s.name) + '<small>' + esc(s.cls) + '</small></span><span class="acts">' +
        '<button class="btn sm ' + (st === 'p' ? 'okb' : 'ghost') + '" data-act="att" data-st="p" data-id="' + esc(s.id) + '">উপস্থিত</button>' +
        '<button class="btn sm ' + (st === 'a' ? 'nob' : 'ghost') + '" data-act="att" data-st="a" data-id="' + esc(s.id) + '">অনুপস্থিত</button></span></div>';
    }).join('') : empty('আগে স্টুডেন্ট যোগ করুন।')) + '</section>';
}

function vPay() {
  const act = S.filter(s => s.active);
  const list = P.filter(p => p.month === payMonth).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  return '<section class="blk"><h2>বেতন</h2><label>মাস<input type="month" id="paym" value="' + esc(payMonth) + '"></label></section>' +
    '<section class="blk">' + (act.length ? act.map(s => {
      const pd = paidOf(s.id, payMonth), due = s.fee - pd;
      return '<div class="row" data-id="' + esc(s.id) + '"><div class="line"><span>' + esc(s.name) + '<small>ফি ' + taka(s.fee) + ', দিয়েছে ' + taka(pd) + '</small></span>' +
        '<b class="' + (due > 0 ? 'no' : 'ok') + '">' + (due > 0 ? 'বাকি ' + taka(due) : due < 0 ? 'বেশি ' + taka(-due) : 'পরিশোধিত') + '</b></div>' +
        '<div class="acts"><input type="number" min="1" step="1" inputmode="numeric" placeholder="টাকা" value="' + (due > 0 ? due : '') + '">' +
        '<button class="btn sm" data-act="pay">জমা নিন</button></div></div>';
    }).join('') : empty('আগে স্টুডেন্ট যোগ করুন।')) + '</section>' +
    '<section class="blk"><h2>এ মাসের জমার হিসাব</h2>' + (list.length ? list.map(p =>
      '<div class="line"><span>' + esc(sname(p.studentId)) + '<small>' + esc(bn(p.paidAt)) + '</small></span><span class="acts"><b>' + taka(p.amount) +
      '</b><button class="btn sm danger" data-act="delpay" data-id="' + esc(p.id) + '">মুছুন</button></span></div>').join('') : empty('এ মাসে এখনো কোনো জমা নেই।')) + '</section>';
}

function report() {
  const m = thisMonth(), act = S.filter(s => s.active);
  const col = P.filter(p => p.month === m).reduce((x, p) => x + p.amount, 0);
  let out = 'টিউশন রিপোর্ট, ' + bn(m) + '\n\n', due = 0;
  act.forEach(s => {
    const pd = paidOf(s.id, m), d = Math.max(0, s.fee - pd); due += d;
    const cnt = st => A.filter(a => a.studentId === s.id && a.date.slice(0, 7) === m && a.status === st).length;
    out += s.name + (s.cls ? ' (' + s.cls + ')' : '') + '\n  ফি ' + taka(s.fee) + ', জমা ' + taka(pd) + ', বাকি ' + taka(d) +
      '\n  উপস্থিত ' + bn(cnt('p')) + ' দিন, অনুপস্থিত ' + bn(cnt('a')) + ' দিন\n';
  });
  return out + '\nমোট আদায়: ' + taka(col) + '\nমোট বাকি: ' + taka(due);
}
const markBackup = () => { try { localStorage.setItem('lastBackup', today()); } catch (e) { /* ignore */ } };

function tablesHtml() {
  const cnt = (id, st) => A.filter(a => a.studentId === id && a.status === st).length;
  const stu = S.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.cls) + '</td><td>' + esc(x.subject) + '</td><td>' + taka(x.fee) + '</td><td>' + (x.active ? 'পড়ছে' : 'পড়ছে না') + '</td></tr>').join('');
  const att = S.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + bn(cnt(x.id, 'p')) + '</td><td>' + bn(cnt(x.id, 'a')) + '</td></tr>').join('');
  const pay = [...P].sort((a, b) => b.paidAt.localeCompare(a.paidAt)).map(x => '<tr><td>' + esc(bn(x.paidAt)) + '</td><td>' + esc(sname(x.studentId)) + '</td><td>' + esc(bn(x.month)) + '</td><td>' + taka(x.amount) + '</td></tr>').join('');
  return '<h2>স্টুডেন্ট</h2><table><tr><th>নাম</th><th>ক্লাস</th><th>বিষয়</th><th>ফি</th><th>অবস্থা</th></tr>' + stu + '</table>' +
    '<h2>হাজিরা (মোট দিন)</h2><table><tr><th>নাম</th><th>উপস্থিত</th><th>অনুপস্থিত</th></tr>' + att + '</table>' +
    '<h2>বেতন জমা</h2><table><tr><th>তারিখ</th><th>নাম</th><th>মাস</th><th>টাকা</th></tr>' + pay + '</table>';
}

// The backup is a readable web page; the real data sits inside it for restoring.
function backupHtml() {
  const data = { app: 'tuition', version: 1, exported: new Date().toISOString(), students: S, attendance: A, payments: P };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
    '<title>টিউশন ব্যাকআপ ' + today() + '</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:auto;padding:16px}h1{font-size:20px}h2{font-size:17px;margin-top:24px}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #8886;padding:6px 8px;text-align:left;font-size:14px}th{background:#8882}.n{border:1px solid #e3b52c;border-radius:8px;padding:10px}</style></head><body>' +
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
  return JSON.parse(txt); // older .json backups
}

function dataSection() {
  return '<section class="blk"><h2>সব তথ্য দেখুন</h2><p class="mu">স্টুডেন্ট, হাজিরা ও বেতনের সব হিসাব এক পেজে।</p>' +
    '<div class="acts"><button class="btn ghost" data-act="data">' + (dataOpen ? 'লুকান' : 'দেখুন') + '</button></div>' +
    (dataOpen ? '<style>.dt table{border-collapse:collapse;width:100%}.dt th,.dt td{border:1px solid var(--bd);padding:6px 8px;text-align:left;font-size:14px}.dt th{background:var(--bg)}.dt h2{font-size:16px;margin:16px 0 8px}</style><div class="dt" style="overflow-x:auto">' + tablesHtml() + '</div>' : '') + '</section>';
}

function vBak() {
  let last = 'এখনো নেওয়া হয়নি';
  try { const v = localStorage.getItem('lastBackup'); if (v) last = v; } catch (e) { /* storage blocked */ }
  return dataSection() + '<section class="blk"><h2>ব্যাকআপ নিন</h2><p class="mu">সব ডেটা শুধু এই ফোনের ব্রাউজারে থাকে। বাটন চাপলে শেয়ার মেনু আসবে, সেখান থেকে Google Drive, WhatsApp বা Files-এ সেভ করুন। ফাইলটি শুধু জমিয়ে রাখার জন্য, ফাইল ম্যানেজারে খুললে কোডের মতো দেখাতে পারে। পড়তে হলে উপরের "সব তথ্য দেখুন" ব্যবহার করুন।</p>' +
    '<p>শেষ ব্যাকআপ: ' + esc(bn(last)) + '</p><div class="acts"><button class="btn" data-act="exp">ব্যাকআপ সেভ করুন</button></div></section>' +
    '<section class="blk"><h2>ডেটা ফিরিয়ে আনুন</h2><p class="mu">আগে সেভ করা ব্যাকআপ ফাইলটি বেছে নিন।</p>' +
    '<label class="btn ghost" style="margin:0">ফাইল বেছে নিন<input type="file" id="imp" hidden></label></section>' +
    '<section class="blk"><h2>এ মাসের রিপোর্ট</h2><p class="mu">পড়ার মতো সহজ লেখা, WhatsApp-এ পাঠানো যায়।</p>' +
    '<div class="acts"><button class="btn ghost" data-act="rep">' + (repOpen ? 'লুকান' : 'রিপোর্ট দেখুন') + '</button>' +
    (repOpen ? '<button class="btn" data-act="rshare">শেয়ার করুন</button>' : '') + '</div>' +
    (repOpen ? '<pre class="rep">' + esc(report()) + '</pre>' : '') + '</section>';
}

function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view').innerHTML = { dash: vDash, stu: vStu, att: vAtt, pay: vPay, bak: vBak }[tab]();
}

/* ---------- events ---------- */
document.addEventListener('click', safe(async e => {
  const nb = e.target.closest('nav button');
  if (nb) { tab = nb.dataset.tab; if (tab !== 'stu') editId = null; render(); window.scrollTo(0, 0); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (act === 'edit') { editId = id; render(); window.scrollTo(0, 0); }
  else if (act === 'cancel') { editId = null; render(); }
  else if (act === 'delstu') {
    if (!confirm('এই স্টুডেন্টের সব হাজিরা ও বেতনের রেকর্ডসহ মুছে যাবে। নিশ্চিত?')) return;
    await removeStudent(id); if (editId === id) editId = null; await load(); toast('মুছে ফেলা হয়েছে');
  } else if (act === 'att') {
    const key = id + '|' + attDate, r = A.find(a => a.key === key);
    if (r && r.status === t.dataset.st) await del('attendance', key);
    else await put('attendance', { key, studentId: id, date: attDate, status: t.dataset.st });
    await load();
  } else if (act === 'pay') {
    const row = t.closest('.row');
    const amt = Number(row.querySelector('input').value);
    const studentId = row.dataset.id;
    const student = S.find(s => s.id === studentId);

    if (!student || !student.active) {
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
      paidAt: today()
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
    const text = report();
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
    await navigator.clipboard.writeText(text); toast('কপি হয়েছে');
  }
}));

document.addEventListener('submit', safe(async e => {
  if (e.target.id !== 'sf') return;
  e.preventDefault();
  const f = new FormData(e.target), name = String(f.get('name')).trim(), fee = Number(f.get('fee'));
  if (!name) return toast('নাম লিখুন');
  if (!Number.isInteger(fee) || fee < 0) return toast('ফি পূর্ণ সংখ্যায় দিন');
  const old = S.find(s => s.id === editId);
  await put('students', {
    id: old ? old.id : uid(), name, cls: String(f.get('cls')).trim(), subject: String(f.get('subject')).trim(),
    phone: String(f.get('phone')).trim(), gphone: String(f.get('gphone')).trim(), fee,
    active: f.get('active') === 'on', createdAt: old ? old.createdAt : Date.now()
  });
  editId = null; await load(); toast('সেভ হয়েছে');
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
