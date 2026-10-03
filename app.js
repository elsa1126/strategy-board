'use strict';
/* =========================================================
   策略看板 v10 — 主程式
   設定值（幣種、金鑰、雲端）在 config.js
   計算公式（盈虧、槓桿、資金看板）與 v9.2 完全相同
   ========================================================= */

const APP_VERSION = 'v10';

// ===================== 小工具 =====================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    json(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
};

// 所有來自雲端或使用者輸入的文字，放進畫面前一律跳脫，避免被夾帶程式碼
function escH(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
const hasMouse = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const pad2 = n => String(n).padStart(2, '0');

// ===================== 狀態 =====================
const COIN_DEFAULTS = () => ({ entry: 0, target: 0, stopLoss: 0, isHolding: false, lastManualUpdate: 0, note: '', entrySide: null, capital: 0, leverage: 1, manualStatus: null });
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9/._-]{0,19}$/;
const CG_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MANUAL_STATUSES = ['target_reached', 'stopped_out', 'no_market'];
const isMetaKey = k => String(k).startsWith('__');

let userSettings = store.json('coinSettingsV3', {});
if (!userSettings || typeof userSettings !== 'object' || Array.isArray(userSettings)) userSettings = {};
let COIN_LIST = [];
let marketData = {};
let currentSort = 'updateTime';
let sortDirection = 'desc';
let currentFilter = 'all';
let viewMode = store.get('viewModeV10') === 'list' ? 'list' : 'card';
let editingCoin = null;
let selectedCoin = null;
const expandedCoins = new Set();

let countdown = REFRESH_SECONDS;
let cloudSyncCounter = 300;
let lastFetchAt = 0;
let lastPriceOkAt = 0;
let isFetchingMarket = false;
let priceState = { state: 'loading', text: '更新中…', title: '' };
let lastErrorToast = '';

const SORT_OPTIONS = [
    { key: 'updateTime', label: '更新時間', defaultDir: 'desc' },
    { key: 'name', label: '按字母排序', defaultDir: 'asc' },
    { key: 'change', label: '24H 漲跌幅', defaultDir: 'desc' },
    { key: 'expectedGain', label: '預期收益 (%)', defaultDir: 'desc' },
    { key: 'targetDist', label: '現價與目標價距離', defaultDir: 'asc' },
    { key: 'entryDist', label: '現價與進場價距離', defaultDir: 'asc' }
];
const FILTER_LABELS = { all: '全部', holding: '已進場', watching: '未進場', target_reached: '已達標', stopped_out: '已止損', no_market: '未適配' };

function saveSettings() { store.set('coinSettingsV3', JSON.stringify(userSettings)); }

function normalizeCoin(o) {
    const d = COIN_DEFAULTS();
    if (!o || typeof o !== 'object') return d;
    const r = Object.assign(d, o);
    r.entry = Number(r.entry) || 0;
    r.target = Number(r.target) || 0;
    r.stopLoss = Number(r.stopLoss) || 0;
    r.capital = Number(r.capital) || 0;
    r.leverage = Number(r.leverage) || 1;
    r.lastManualUpdate = Number(r.lastManualUpdate) || 0;
    r.isHolding = !!r.isHolding;
    r.note = typeof r.note === 'string' ? r.note : '';
    if (!MANUAL_STATUSES.includes(r.manualStatus)) r.manualStatus = null;
    if (!['breakout', 'dip'].includes(r.entrySide)) r.entrySide = null;
    if (r.cgId !== undefined && !(typeof r.cgId === 'string' && CG_ID_RE.test(r.cgId))) delete r.cgId;
    return r;
}

function removedSet() {
    const g = userSettings.__GLOBAL__;
    const extra = g && Array.isArray(g.removedCoins) ? g.removedCoins : [];
    return new Set(REMOVED_COINS.concat(extra).map(c => String(c).toUpperCase()));
}

// 依「預設清單 + 雲端/本機有的幣 − 已移除」重建 COIN_LIST，並把每檔資料補齊欄位
function syncCoinList() {
    const removed = removedSet();
    Object.keys(userSettings).forEach(k => {
        if (isMetaKey(k)) return;
        const K = k.toUpperCase();
        if (!SYMBOL_RE.test(K) || removed.has(K)) { delete userSettings[k]; return; }
        if (K !== k) { if (!userSettings[K]) userSettings[K] = userSettings[k]; delete userSettings[k]; }
    });
    const list = COIN_LIST_DEFAULT.filter(c => !removed.has(c));
    Object.keys(userSettings).forEach(k => { if (!isMetaKey(k) && !list.includes(k)) list.push(k); });
    COIN_LIST = list;
    COIN_LIST.forEach(c => { userSettings[c] = normalizeCoin(userSettings[c]); });
}

const cgIdOf = c => (userSettings[c] && userSettings[c].cgId) || COIN_ID_MAP[c] || null;

// ===================== 狀態判斷（與 v9.2 相同的規則，集中在一處） =====================
function coinState(coin) {
    const s = userSettings[coin] || COIN_DEFAULTS();
    const m = marketData[coin] || { price: 0, change: 0, vol: 0, src: '--' };
    const price = Number(m.price);
    const targetHit = s.manualStatus === 'target_reached' || (s.isHolding && s.target > 0 && price >= Number(s.target));
    const stoppedOut = s.manualStatus === 'stopped_out';
    const noMarket = s.manualStatus === 'no_market' || m.src === '--';
    const holding = s.isHolding && !targetHit;
    return { s, m, price, targetHit, stoppedOut, noMarket, holding };
}

function matchFilter(c, f) {
    const s = userSettings[c] || {}, m = marketData[c];
    switch (f) {
        case 'holding': return !!s.isHolding;
        case 'watching': return !s.isHolding;
        case 'target_reached': return s.manualStatus === 'target_reached' || (s.isHolding && s.target > 0 && m && Number(m.price) >= Number(s.target));
        case 'stopped_out': return s.manualStatus === 'stopped_out';
        case 'no_market': return s.manualStatus === 'no_market' || (m && m.src === '--');
        default: return true;
    }
}

// 持倉離止損多遠（只用來提醒，不會改變狀態）
function stopInfo(st) {
    const sl = Number(st.s.stopLoss);
    if (!st.holding || !(sl > 0) || !(st.price > 0)) return null;
    const dist = (st.price - sl) / st.price * 100;
    return { dist, broken: st.price <= sl, near: st.price > sl && dist < 5 };
}

// ===================== 數字格式 =====================
// 小數點後 4 個 0 以上改用下標寫法：0.0000000004067 → 0.0₉4067（只改顯示，數值不變；詳情頁顯示完整位數）
const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
function compactZeros(str) { const m = /^0\.(0{4,})(\d+)$/.exec(str); return m ? '0.0' + String(m[1].length).split('').map(d => SUB_DIGITS[d]).join('') + m[2] : str; }
function formatPrice(p) { const n = Number(p); if (n === 0) return '---'; if (n < 0.1) return compactZeros(n.toLocaleString('en-US', { maximumSignificantDigits: 4 })); if (n < 1) return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }); return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
// 完整精度、不會出現 1e-7 這種科學記號
function formatFull(p) { const n = Number(p); if (!n) return '--'; return n.toLocaleString('en-US', { maximumSignificantDigits: 12, useGrouping: false }); }
function formatRelativeTime(ts) { if (!ts) return '未曾設定'; const diff = Date.now() - ts; if (diff < 60000) return '剛剛'; const m = Math.floor(diff / 60000); if (m < 60) return `${m} 分鐘前`; const h = Math.floor(m / 60); if (h < 24) return `${h} 小時前`; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}` }
const hhmm = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// ===================== 提示訊息與對話框 =====================
function showToast(msg, type = 'success') {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.setAttribute('role', 'status');
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 3000);
}

function uiDialog({ title = '', message = '', input = false, value = '', placeholder = '', okText = '確定', cancelText = '取消', danger = false } = {}) {
    return new Promise(resolve => {
        const dlg = $('#dialog'), form = $('#dialog-form'), inp = $('#dialog-input'), ok = $('#dialog-ok'), cancel = $('#dialog-cancel');
        $('#dialog-title').textContent = title;
        $('#dialog-msg').textContent = message;
        $('#dialog-msg').hidden = !message;
        inp.hidden = !input; inp.value = value; inp.placeholder = placeholder;
        ok.textContent = okText; cancel.textContent = cancelText; cancel.hidden = !cancelText;
        ok.className = 'btn ' + (danger ? 'danger' : 'primary');
        $('.dialog-actions').style.gridTemplateColumns = cancelText ? '1fr 1fr' : '1fr';
        dlg.classList.add('open');
        setTimeout(() => (input ? inp : ok).focus(), 30);
        const done = val => { dlg.classList.remove('open'); form.onsubmit = null; cancel.onclick = null; dlg.onkeydown = null; resolve(val); };
        form.onsubmit = e => { e.preventDefault(); done(input ? inp.value : true); };
        cancel.onclick = () => done(input ? null : false);
        dlg.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); } };
    });
}
const uiConfirm = (title, message, opts = {}) => uiDialog(Object.assign({ title, message }, opts));
const uiPrompt = (title, message, opts = {}) => uiDialog(Object.assign({ title, message, input: true }, opts));
const uiAlert = (title, message) => uiDialog({ title, message, cancelText: '' });

// ===================== 面板開關 =====================
const PANELS = ['side-panel', 'notif-panel', 'bottom-sheet', 'sort-menu', 'gd'];
function openPanel(id, opts = {}) {
    PANELS.forEach(p => { if (p !== id) $('#' + p).classList.remove('open'); });
    $('#' + id).classList.add('open');
    const ov = $('#overlay');
    ov.classList.add('active');
    ov.classList.toggle('clear', !!opts.clearOverlay);
    document.body.classList.toggle('locked', !opts.clearOverlay);
}
function closePanels() {
    const sheetWasOpen = $('#bottom-sheet').classList.contains('open');
    PANELS.forEach(p => $('#' + p).classList.remove('open'));
    $('#overlay').classList.remove('active', 'clear');
    document.body.classList.remove('locked');
    if (sheetWasOpen) { editingCoin = null; selectedCoin = null; renderCards(); renderStatus(); }
}
const isOpen = id => $('#' + id).classList.contains('open');

// ===================== 雲端（JSONBin；有設定 WORKER_URL 時改走安全模式） =====================
async function fetchWithTimeout(url, timeoutMs = 15000, opts = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, Object.assign({}, opts, { signal: controller.signal })); }
    finally { clearTimeout(id); }
}

// 讀寫共用的合併規則（worker/worker.js 裡有一模一樣的一份）
function applyPatch(rec, ops) {
    if (ops.set) Object.keys(ops.set).forEach(k => { if (k.toLowerCase() !== k) delete rec[k.toLowerCase()]; rec[k] = ops.set[k]; });
    if (ops.del) ops.del.forEach(k => { delete rec[k]; delete rec[k.toLowerCase()]; });
    if (ops.global || ops.addRemoved || ops.unRemove) {
        const g = rec.__GLOBAL__ && typeof rec.__GLOBAL__ === 'object' && !Array.isArray(rec.__GLOBAL__) ? rec.__GLOBAL__ : {};
        Object.assign(g, ops.global || {});
        const removed = new Set(Array.isArray(g.removedCoins) ? g.removedCoins : []);
        (ops.addRemoved || []).forEach(c => removed.add(c));
        (ops.unRemove || []).forEach(c => removed.delete(c));
        if (removed.size) g.removedCoins = Array.from(removed); else delete g.removedCoins;
        rec.__GLOBAL__ = g;
    }
    if (ops.clearNotif) rec.__NOTIF_LOG__ = [];
    return rec;
}

const Cloud = {
    workerMode: !!WORKER_URL,
    bin: store.get('syncBin') || DEFAULT_BIN_ID,
    isAdmin: false,

    init() {
        this.isAdmin = this.workerMode ? !!this.token() : store.get('isAdmin') === 'true';
    },
    configured() { return this.workerMode || !!this.bin; },
    token() {
        const t = store.get('adminToken');
        if (!t) return null;
        try {
            const p = JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
            if (!p.exp || p.exp * 1000 < Date.now()) { store.del('adminToken'); return null; }
        } catch (e) { store.del('adminToken'); return null; }
        return t;
    },
    async workerCall(path, body) {
        const headers = { 'Content-Type': 'application/json' };
        const t = this.token(); if (t) headers.Authorization = 'Bearer ' + t;
        const r = await fetchWithTimeout(WORKER_URL + path, 20000, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
        let d = {}; try { d = await r.json(); } catch (e) {}
        if (r.status === 401) { if (path !== '/login') this.logout(true); throw new Error(d.error || '登入已過期，請重新登入'); }
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
    },
    async read() {
        if (this.workerMode) { const d = await this.workerCall('/data'); if (!d.record) throw new Error('雲端沒有資料'); return d.record; }
        if (!this.bin) throw new Error('請填寫 Bin ID');
        const r = await fetchWithTimeout('https://api.jsonbin.io/v3/b/' + encodeURIComponent(this.bin) + '/latest', 15000, { headers: { 'X-Master-Key': DEFAULT_API_KEY } });
        const d = await r.json();
        if (!d.record) throw new Error(d.message || ('HTTP ' + r.status));
        return d.record;
    },
    async write(rec) {
        const r = await fetchWithTimeout('https://api.jsonbin.io/v3/b/' + encodeURIComponent(this.bin), 20000, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': DEFAULT_API_KEY }, body: JSON.stringify(rec) });
        if (r.status === 401 || r.status === 403) throw new Error('雲端授權錯誤');
        if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch (e) {} throw new Error(m || ('HTTP ' + r.status)); }
    },
    async login(user, pass) {
        if (this.workerMode) {
            const d = await this.workerCall('/login', { user, pass });
            if (!d.token) throw new Error('登入失敗');
            store.set('adminToken', d.token);
        } else {
            if (await sha256(user) !== ADMIN_USER_HASH || await sha256(pass) !== ADMIN_PASS_HASH) throw new Error('帳號或密碼錯誤');
            store.set('isAdmin', 'true');
        }
        this.isAdmin = true;
    },
    logout(expired = false) {
        store.del('adminToken'); store.del('isAdmin');
        this.isAdmin = false;
        renderMode();
        if (expired) showToast('管理員登入已過期，請重新登入', 'error');
    },
    // 只改動「有變的那幾檔」：先抓雲端最新版再合併上去，不會蓋掉其他裝置或雲端程式剛寫入的資料
    async patch(ops) {
        if (!this.isAdmin) throw new Error('需要管理員權限');
        if (this.workerMode) { const d = await this.workerCall('/patch', { ops }); return d.record; }
        if (!this.bin) throw new Error('請先建立區塊');
        const rec = await this.read();
        applyPatch(rec, ops);
        await this.write(rec);
        return rec;
    },
    async replace(record) {
        if (!this.isAdmin) throw new Error('需要管理員權限');
        if (this.workerMode) { const d = await this.workerCall('/replace', { record }); return d.record; }
        if (!this.bin) throw new Error('請先建立區塊');
        await this.write(record);
        return record;
    },
    async createBin(record) {
        const r = await fetch('https://api.jsonbin.io/v3/b', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Master-Key': DEFAULT_API_KEY, 'X-Bin-Name': 'AltcoinVaultSync', 'X-Bin-Private': 'false' }, body: JSON.stringify(record) });
        const d = await r.json();
        if (!d.record) throw new Error(d.message || JSON.stringify(d));
        return d.metadata.id;
    }
};

async function sha256(str) { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('') }

function coinsSnapshot() { const o = {}; COIN_LIST.forEach(c => { o[c] = userSettings[c]; }); return JSON.stringify(o); }

// 把雲端資料合併進本機（規則同 v9.2：雲端有的幣以雲端為準）
function mergeCloudRecord(c) {
    const before = coinsSnapshot();
    const g = c.__GLOBAL__;
    if (g && typeof g === 'object' && !Array.isArray(g)) {
        userSettings.__GLOBAL__ = g;
        gdRealized = Number(g.realizedPnL) || 0;
        store.set('gdRealized', gdRealized);
        const rEl = $('#gd-realized'); if (rEl && document.activeElement !== rEl) rEl.value = gdRealized || '';
    }
    const removed = removedSet();
    Object.keys(c).forEach(k => {
        if (isMetaKey(k)) return;
        const K = k.toUpperCase();
        if (!SYMBOL_RE.test(K) || removed.has(K)) return;
        if (!COIN_LIST.includes(K)) { COIN_LIST.push(K); userSettings[K] = COIN_DEFAULTS(); }
    });
    COIN_LIST.forEach(coin => {
        const k = c[coin] || c[coin.toLowerCase()];
        if (k && typeof k === 'object') userSettings[coin] = normalizeCoin(k);
    });
    const newNotifs = Array.isArray(c.__NOTIF_LOG__) ? mergeNotifs(c.__NOTIF_LOG__) : 0;
    syncCoinList();
    saveSettings();
    return { coinsChanged: coinsSnapshot() !== before, newNotifs };
}

async function fetchFromCloud(silent = false) {
    if (!silent) saveSyncConfig();
    if (!Cloud.configured()) { if (!silent) showToast('請填寫 Bin ID', 'error'); return null; }
    try {
        const rec = await Cloud.read();
        const res = mergeCloudRecord(rec);
        if (!editingCoin && Object.keys(marketData).length) renderCards();
        gdUpdate();
        fetchExchangeData();
        if (!silent) showToast('已讀取雲端資料');
        return res;
    } catch (e) {
        if (!silent) showToast('雲端讀取失敗：' + e.message, 'error');
        return null;
    }
}

function saveSyncConfig() {
    if (Cloud.workerMode) return;
    const b = $('#sync-bin');
    if (b) { Cloud.bin = b.value.trim(); store.set('syncBin', Cloud.bin); }
    renderMode();
}

// 儲存本機後同步到雲端（管理員才會上傳）
async function syncOps(ops, okMsg) {
    if (!Cloud.isAdmin) return false;
    setSaving(true);
    try {
        const rec = await Cloud.patch(ops);
        if (rec) mergeCloudRecord(rec);
        if (okMsg) showToast(okMsg);
        return true;
    } catch (e) {
        showToast('已存在本機，但雲端同步失敗：' + e.message, 'error');
        return false;
    } finally {
        setSaving(false);
        if (!editingCoin) renderCards();
    }
}

let saving = false;
function setSaving(v) { saving = v; renderStatus(); }

// ===================== CoinGecko 報價 =====================
let missingKeyToastShown = false;
const cgDeadUntil = {};     // 金鑰失敗後 10 分鐘內先跳過（排到最後備用）
let cgActiveN = 1;          // 目前成功使用的是第幾把金鑰
let cgWarnedN = 0;          // 已經提醒過的金鑰編號（第 3 把起）
let binanceToastShown = false;

// 一次請求最多查 200 檔：現在的 156 檔只要 1 次請求（v9.2 每次要 3 次），額度省到三分之一
const CG_MAX_IDS_PER_REQUEST = 200;
function splitIntoBatches(list) {
    const out = [];
    for (let i = 0; i < list.length; i += CG_MAX_IDS_PER_REQUEST) out.push(list.slice(i, i + CG_MAX_IDS_PER_REQUEST));
    return out;
}

// 主／備用金鑰：依序嘗試，前一把失敗（額度、金鑰錯誤、被擋）就換下一把
function cgKeyList() {
    const all = [
        { n: 1, key: COINGECKO_API_KEY, plan: COINGECKO_PLAN, name: '主' },
        { n: 2, key: COINGECKO_API_KEY_BACKUP, plan: COINGECKO_PLAN_BACKUP, name: '備用1' },
        { n: 3, key: COINGECKO_API_KEY_BACKUP2, plan: COINGECKO_PLAN_BACKUP2, name: '備用2' },
        { n: 4, key: COINGECKO_API_KEY_BACKUP3, plan: COINGECKO_PLAN_BACKUP3, name: '備用3' },
        { n: 5, key: COINGECKO_API_KEY_BACKUP4, plan: COINGECKO_PLAN_BACKUP4, name: '備用4' }
    ].filter(k => k.key);
    const now = Date.now(), dead = k => cgDeadUntil[k.n] > now;
    return all.filter(k => !dead(k)).concat(all.filter(dead));   // 沒失敗過的照順序在前
}

async function cgGet(path, params) {
    const keys = cgKeyList();
    let lastErr;
    for (const k of keys) {
        const pro = k.plan === 'pro';
        const qs = new URLSearchParams(params);
        qs.set(pro ? 'x_cg_pro_api_key' : 'x_cg_demo_api_key', k.key);
        try {
            let res;
            try { res = await fetchWithTimeout(`https://${pro ? 'pro-api' : 'api'}.coingecko.com/api/v3${path}?${qs.toString()}`, 20000); }
            catch (e) { const err = new Error(e.name === 'AbortError' ? '請求逾時' : '網路錯誤或被瀏覽器擋下（常見於額度用完或網路封鎖）'); err.network = true; throw err; }
            if (!res.ok) {
                let body = ''; try { body = (await res.text()).slice(0, 200); } catch (e) {}
                const err = new Error('HTTP ' + res.status + (body ? ' ' + body : '')); err.status = res.status; throw err;
            }
            const data = await res.json();
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('回傳格式異常：' + JSON.stringify(data).slice(0, 200));
            if (data.status && data.status.error_message) throw new Error(data.status.error_message);
            delete cgDeadUntil[k.n];
            cgActiveN = k.n;
            if (k.n >= 3) {
                if (cgWarnedN !== k.n) {
                    cgWarnedN = k.n;
                    showToast(`已用到第 ${k.n} 把 CoinGecko 金鑰，請注意額度`, 'error');
                    addNotifLog('CoinGecko 金鑰警示', `前面的金鑰目前無法使用（額度用完或連線失敗），已切換到第 ${k.n} 把金鑰，請注意用量。`, 'stoploss');
                }
            } else cgWarnedN = 0;
            return data;
        } catch (e) {
            lastErr = e;
            console.warn(`[CoinGecko ${k.name}金鑰失敗]`, e.message);
            if (keys.length > 1) cgDeadUntil[k.n] = Date.now() + 600000;
        }
    }
    if (keys.length > 1) lastErr.message = '所有金鑰皆失敗：' + lastErr.message;
    throw lastErr;
}

async function cgRequest(idsStr) {
    // 安全模式：先問 Worker（它幫所有人共用同一份快取，訪客再多也不會多耗額度）
    if (WORKER_URL) {
        try {
            const r = await fetchWithTimeout(`${WORKER_URL}/prices?ids=${encodeURIComponent(idsStr)}`, 20000);
            if (r.ok) { const d = await r.json(); if (d && typeof d === 'object' && !Array.isArray(d) && !d.error) return d; }
        } catch (e) {}
        console.warn('[Worker 報價失敗] 改為直接向 CoinGecko 查詢');
    }
    return cgGet('/simple/price', { ids: idsStr, vs_currencies: 'usd', include_24hr_change: 'true', include_24hr_vol: 'true', precision: 'full' });
}

// 送出單一批次（/simple/price + ids），回傳 { 幣種代號: {price, change, vol, src} }；失敗時丟出錯誤
async function fetchCoinGeckoBatch(symbols) {
    const idToSyms = {};
    symbols.forEach(sym => { const id = cgIdOf(sym); (idToSyms[id] = idToSyms[id] || []).push(sym); });
    const data = await cgRequest(Object.keys(idToSyms).join(','));
    const out = {};
    Object.keys(idToSyms).forEach(id => {
        const t = data[id];
        if (!t || t.usd == null) { console.warn('[CoinGecko 無資料]', idToSyms[id].join(','), '→', id); return; }
        idToSyms[id].forEach(sym => {
            out[sym] = { price: Number(t.usd), change: Number(t.usd_24h_change) || 0, vol: Number(t.usd_24h_vol) || 0, src: 'CoinGecko' };
        });
    });
    return out;
}

// 幣安：維持 v9.2 原本的用途（BTC 交易對、AI、CoinGecko 查不到的備援幣），沒有擴大使用
async function fetchBinanceOne(pair) {
    const res = await fetchWithTimeout(`${BINANCE_PRICE_URL}?symbol=${pair}`, 10000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const n = Number(d && d.price);
    if (!(n > 0)) throw new Error('無價格');
    return n;
}
async function fetchBinancePrices(symbols) {
    const pairOf = {};
    symbols.forEach(s => { pairOf[s] = BINANCE_BTC_PAIRS[s] || (s.replace('/', '') + 'USDT'); });
    const entries = await Promise.all(symbols.map(sym =>
        fetchBinanceOne(pairOf[sym]).then(v => [sym, v]).catch(e => { console.warn('[Binance 無資料]', sym, '→', pairOf[sym], e.message); return [sym, 0]; })
    ));
    const out = {};
    let anyOk = false;
    entries.forEach(([sym, v]) => {
        if (v > 0) { anyOk = true; out[sym] = { price: v, change: 0, vol: 0, src: 'Binance', quote: BINANCE_BTC_PAIRS[sym] ? 'BTC' : 'USDT' }; }
    });
    if (!anyOk) throw new Error('Binance 全部請求失敗');
    return out;
}

function setPriceState(state, text, title = '') { priceState = { state, text, title }; renderStatus(); }

async function fetchExchangeData(force = false) {
    if (!cgKeyList().length && !WORKER_URL) {
        console.warn('尚未填入 CoinGecko API 金鑰（config.js 內的 COINGECKO_API_KEY）');
        setPriceState('warn', '未設定金鑰');
        if (!missingKeyToastShown) { missingKeyToastShown = true; showToast('請先在 config.js 填入 CoinGecko 金鑰', 'error'); }
        if (Object.keys(marketData).length === 0) COIN_LIST.forEach(coin => { marketData[coin] = { price: 0, change: 0, vol: 0, src: '--' }; });
        if (!editingCoin) renderCards();
        return;
    }
    if (isFetchingMarket) return;
    if (!force && Date.now() - lastFetchAt < MIN_FETCH_GAP_MS) return;
    isFetchingMarket = true;
    if (!lastPriceOkAt) setPriceState('loading', '更新中…');

    try {
        const binanceDirect = COIN_LIST.filter(c => BINANCE_ONLY.includes(c) || BINANCE_BTC_PAIRS[c]);
        const mappedCoins = COIN_LIST.filter(c => cgIdOf(c) && !BINANCE_BTC_PAIRS[c]);   // /BTC 交易對只走幣安（單位不同，不能混用 CoinGecko 美元價）
        const unmapped = COIN_LIST.filter(c => !cgIdOf(c) && !binanceDirect.includes(c));
        if (unmapped.length) console.warn('[缺少 CoinGecko ID 對照]', unmapped.join(', '));
        const batches = splitIntoBatches(mappedCoins);
        const results = await Promise.allSettled(batches.map((b, i) =>
            new Promise(r => setTimeout(r, i * 1000)).then(() => fetchCoinGeckoBatch(b))
        ));

        const cgMerged = {};
        results.forEach(r => { if (r.status === 'fulfilled') Object.assign(cgMerged, r.value); });
        const binanceList = binanceDirect.concat(BINANCE_FALLBACK.filter(c => COIN_LIST.includes(c) && !cgMerged[c]));
        let binanceOk = false;
        if (binanceList.length) {
            try { Object.assign(cgMerged, await fetchBinancePrices(binanceList)); binanceOk = true; }
            catch (e) { console.warn('[Binance 失敗]', e.message); if (!binanceToastShown) { binanceToastShown = true; showToast('Binance 報價失敗（BTC 交易對／AI）', 'error'); } }
        }

        let okCount = 0, rateLimited = false, authError = false, firstErr = '';
        if (binanceOk) okCount++;
        results.forEach(r => {
            if (r.status === 'fulfilled') okCount++;
            else {
                const msg = (r.reason && r.reason.message) || String(r.reason);
                console.warn('[CoinGecko 批次失敗]', msg);
                if (!firstErr) firstErr = msg;
                if (r.reason && r.reason.status === 429) rateLimited = true;
                if (r.reason && (r.reason.status === 401 || r.reason.status === 403)) authError = true;
            }
        });
        // 同一種錯誤只提示一次，恢復正常後才會再提示
        if (firstErr) { const key = firstErr.slice(0, 40); if (key !== lastErrorToast) { lastErrorToast = key; showToast('CoinGecko：' + firstErr.slice(0, 80), 'error'); } }
        else lastErrorToast = '';

        if (okCount === 0) {
            if (Object.keys(marketData).length === 0) COIN_LIST.forEach(coin => { marketData[coin] = { price: 0, change: 0, vol: 0, src: '--' }; });
            if (authError) setPriceState('warn', '金鑰錯誤', firstErr);
            else if (rateLimited) setPriceState('warn', '額度用完', firstErr);
            else setPriceState('error', '連線失敗', firstErr);
        } else {
            const failedBatchCoins = new Set();
            results.forEach((r, i) => { if (r.status !== 'fulfilled') batches[i].forEach(c => failedBatchCoins.add(c)); });
            if (!binanceOk) binanceList.forEach(c => failedBatchCoins.add(c));
            COIN_LIST.forEach(coin => {
                if (cgMerged[coin]) marketData[coin] = cgMerged[coin];
                else if (failedBatchCoins.has(coin) && marketData[coin]) { /* 該批次失敗：保留舊價 */ }
                else marketData[coin] = { price: 0, change: 0, vol: 0, src: '--' };
            });
            lastFetchAt = Date.now();
            lastPriceOkAt = lastFetchAt;
            if (cgActiveN >= 3) setPriceState('warn', `更新於 ${hhmm(lastPriceOkAt)}`, `目前使用第 ${cgActiveN} 把 CoinGecko 金鑰，請注意額度`);
            else setPriceState(firstErr ? 'warn' : 'ok', `更新於 ${hhmm(lastPriceOkAt)}`, firstErr ? '部分報價更新失敗：' + firstErr : '');
        }
        if (!editingCoin) renderCards();
        gdUpdate();
    } catch (e) {
        console.error('fetchExchangeData 失敗:', e);
        setPriceState('error', '連線失敗', e.message);
    } finally {
        isFetchingMarket = false;
    }
}

function renderStatus() {
    const el = $('#status'); if (!el) return;
    let { state, text, title } = priceState;
    if (saving) { state = 'loading'; text = '儲存中…'; }
    else if (editingCoin) { state = 'warn'; text = '編輯中'; title = '編輯時畫面暫停更新，存檔或關閉後恢復'; }
    el.dataset.state = state;
    $('#status-text').textContent = text;
    const next = Math.max(0, countdown);
    el.title = (title ? title + '\n' : '') + `點一下立即更新報價（下次自動更新：${Math.floor(next / 60)}:${pad2(next % 60)} 後）`;
}

// ===================== 通知中心 =====================
let notifLog = store.json('notifLog', []);
if (!Array.isArray(notifLog)) notifLog = [];
// 第一次開 v10：之前累積的通知都視為已讀，不會一打開就是 99+
let notifQuietMerge = store.get('notifInitV10') !== '1';
if (notifQuietMerge) notifLog.forEach(n => { n.read = true; });
let notifClearedAt = Number(store.get('notifClearedAt')) || 0;
const NOTIF_TYPES = ['entry', 'target', 'stoploss'];

function cleanNotif(n) {
    return {
        id: String(n.id || (n.time + '-' + Math.random())).slice(0, 80),
        title: String(n.title || '').slice(0, 200),
        body: String(n.body || '').slice(0, 1000),
        type: NOTIF_TYPES.includes(n.type) ? n.type : 'entry',
        time: Number(n.time) || Date.now(),
        read: !!n.read
    };
}
function saveNotifs() { store.set('notifLog', JSON.stringify(notifLog)); }
const visibleNotifs = () => notifLog.filter(n => n.time > notifClearedAt);

function addNotifLog(title, body, type) {
    notifLog.unshift(cleanNotif({ id: Date.now() + '-' + Math.floor(Math.random() * 1000), title, body, type, time: Date.now(), read: false }));
    if (notifLog.length > 100) notifLog = notifLog.slice(0, 100);
    saveNotifs(); updateNotifBadge(); renderNotifList();
}

// 雲端通知併進本機；回傳新進幾則
function mergeNotifs(cloudList) {
    const quiet = notifQuietMerge;
    const localIds = new Set(notifLog.map(n => n.id));
    const fresh = [];
    for (let i = cloudList.length - 1; i >= 0; i--) {
        const cn = cloudList[i];
        if (!cn || typeof cn !== 'object') continue;
        const n = cleanNotif(Object.assign({}, cn, { read: quiet }));
        if (!localIds.has(n.id)) { notifLog.unshift(n); localIds.add(n.id); fresh.push(n); }
    }
    if (fresh.length) {
        notifLog.sort((a, b) => b.time - a.time);
        if (notifLog.length > 100) notifLog = notifLog.slice(0, 100);
        saveNotifs();
        if (!quiet) {
            const shown = fresh.filter(n => n.time > notifClearedAt);
            shown.slice(-3).forEach(n => sendBrowserNotify(n.title, n.body));
            if (shown.length > 3) sendBrowserNotify('策略看板', `另有 ${shown.length - 3} 則新通知`);
        }
    }
    if (quiet) { notifQuietMerge = false; store.set('notifInitV10', '1'); }
    updateNotifBadge();
    renderNotifList();
    return quiet ? 0 : fresh.length;
}

function updateNotifBadge() {
    const unread = visibleNotifs().filter(n => !n.read).length;
    $('#notif-badge').textContent = unread > 0 ? (unread > 99 ? '99+' : unread) : '';
}

function renderNotifList() {
    const box = $('#notif-list');
    const list = visibleNotifs();
    $('#clear-notif-btn').hidden = !list.length;
    if (!list.length) { box.innerHTML = '<div class="n-empty">暫無通知紀錄</div>'; return; }
    let lastDate = '', html = '';
    list.forEach(n => {
        const d = new Date(n.time);
        const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
        if (dateStr !== lastDate) { lastDate = dateStr; html += `<div class="n-date">${dateStr}</div>`; }
        html += `<div class="n-item t-${n.type}${n.read ? '' : ' unread'}"><span class="n-dot"></span><div>
            <div class="n-title">${escH(n.title)}</div>
            ${n.body ? `<div class="n-body">${escH(n.body).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="n-time">${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}</div>
        </div></div>`;
    });
    box.innerHTML = html;
}

function markAllNotifRead() { notifLog.forEach(n => { n.read = true; }); saveNotifs(); updateNotifBadge(); }

async function clearNotifLog() {
    if (Cloud.isAdmin) {
        if (!await uiConfirm('清除所有通知？', '會同步清除雲端的通知紀錄，所有人都看不到這些通知了。', { okText: '清除', danger: true })) return;
        const ok = await syncOps({ clearNotif: true });
        if (!ok) return;
        notifLog = []; saveNotifs();
        showToast('通知紀錄已清除並同步至雲端');
    } else {
        if (!await uiConfirm('清除通知？', '只會清除這台裝置上的顯示，不影響雲端紀錄。', { okText: '清除', danger: true })) return;
        showToast('已清除這台裝置上的通知');
    }
    notifClearedAt = Date.now(); store.set('notifClearedAt', notifClearedAt);
    updateNotifBadge(); renderNotifList();
}

// ===================== 推播 =====================
const hasNotifyApi = () => typeof Notification !== 'undefined';
let tgToken = store.get('tgToken', '');
let tgChatId = store.get('tgChatId', '');

function saveTgConfig() {
    tgToken = ($('#tg-token').value || '').trim();
    tgChatId = ($('#tg-chatid').value || '').trim();
    store.set('tgToken', tgToken); store.set('tgChatId', tgChatId);
    showToast('通知設定已儲存');
    updateNotifyStatus();
}

function updateNotifyStatus() {
    const el = $('#notify-status');
    const perm = hasNotifyApi() ? Notification.permission : 'unsupported';
    const btn = $('#browser-notify-btn');
    if (perm === 'granted') { btn.innerHTML = '<svg class="ic"><use href="#i-bell"/></svg>瀏覽器通知已開啟'; btn.disabled = true; }
    else if (perm === 'unsupported') { btn.innerHTML = '<svg class="ic"><use href="#i-bell"/></svg>這個瀏覽器不支援通知'; btn.disabled = true; }
    const browser = perm === 'granted' ? '已開啟' : perm === 'unsupported' ? '不支援' : '未開啟';
    if (tgToken && tgChatId) { el.textContent = `Telegram 已設定 · 瀏覽器通知：${browser}`; el.className = 'hint status-line ok'; }
    else { el.textContent = `瀏覽器通知：${browser} · Telegram 未設定`; el.className = 'hint status-line'; }
}

async function sendTelegram(message) {
    if (!tgToken || !tgChatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChatId, text: message, parse_mode: 'HTML' })
        });
    } catch (e) { console.error('TG 發送失敗:', e); }
}
function sendBrowserNotify(title, body) {
    if (!hasNotifyApi() || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: 'icon.png', badge: 'icon.png' }); } catch (e) { console.error('瀏覽器通知失敗:', e); }
}
function sendAlert(title, body) {
    sendTelegram(`<b>${escH(title)}</b>\n${escH(body)}\n${new Date().toLocaleString('zh-TW')}`);
    sendBrowserNotify(title, body);
    showToast(title);
}
function requestBrowserNotify() {
    if (!hasNotifyApi()) { showToast('這個瀏覽器不支援通知', 'error'); return; }
    Notification.requestPermission().then(p => {
        if (p === 'granted') showToast('瀏覽器通知已開啟');
        else showToast('通知權限被拒絕', 'error');
        updateNotifyStatus();
    });
}
function testTgNotify() {
    if (!tgToken || !tgChatId) { showToast('請先填寫 Token 和 Chat ID', 'error'); return; }
    sendAlert('測試推播成功', `策略看板通知系統已就緒。\n這是一則從 ${APP_VERSION} 網頁版發出的測試訊息。`);
    addNotifLog('測試推播成功', `這是一則從 ${APP_VERSION} 網頁版發出的測試訊息。`, 'entry');
}

// ===================== 備份 =====================
function exportSettings() { const d = JSON.stringify(userSettings, null, 2), b = new Blob([d], { type: 'application/json' }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; const t = new Date(); a.download = `altcoin_vault_${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}.json`; a.click(); URL.revokeObjectURL(u); showToast('備份已匯出') }
function importSettings() {
    const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
    i.onchange = e => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = ev => {
            try {
                const imp = JSON.parse(ev.target.result); let c = 0;
                COIN_LIST.forEach(coin => { if (imp[coin] && typeof imp[coin] === 'object') { userSettings[coin] = normalizeCoin(Object.assign({}, userSettings[coin], imp[coin])); c++ } });
                saveSettings(); renderCards(); gdUpdate(); showToast(`已匯入 ${c} 筆策略（只存在這台裝置）`)
            } catch (err) { showToast('檔案格式不正確', 'error') }
        };
        r.readAsText(f);
    };
    i.click();
}

// ===================== 備註標籤 =====================
// 標籤庫存在本機；備註本身仍是一般文字（可自由輸入），標籤只是點選就能插入的「字符」
const NOTE_DELIM = /[\s,，、;；]+/;
let noteTags = (() => { const t = store.json('noteTagsV1', null); return Array.isArray(t) ? t.map(String) : ['17', '12', '現']; })();
let noteTagManage = false;
function saveNoteTags() { store.set('noteTagsV1', JSON.stringify(noteTags)); }
function noteTokens(n) { return String(n || '').split(NOTE_DELIM).filter(Boolean); }
function renderNoteTagChips(note) {
    const on = noteTokens(note);
    const chips = noteTags.map((t, i) => `<button type="button" class="note-chip${on.includes(t) && !noteTagManage ? ' on' : ''}" data-action="${noteTagManage ? 'note-tag-remove' : 'note-tag'}" data-i="${i}">${escH(t)}${noteTagManage ? ' ×' : ''}</button>`).join('');
    return chips + `<button type="button" class="note-chip add" data-action="note-tag-add">+ 新增</button><button type="button" class="note-chip add" data-action="note-tag-manage">${noteTagManage ? '完成' : '管理'}</button>`;
}
function refreshNoteChips() { const i = $('#edit-note'), r = $('#note-tag-row'); if (i && r) r.innerHTML = renderNoteTagChips(i.value); }
function toggleNoteTag(idx) {
    const inp = $('#edit-note'); if (!inp) return;
    const t = noteTags[idx]; let v = inp.value;
    if (noteTokens(v).includes(t)) {
        v = v.replace(new RegExp('(^|[\\s,，、;；])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s,，、;；])'), '').replace(/^[\s,，、;；]+/, '');
    } else {
        v = v.trim() ? v.replace(/[\s,，、;；]+$/, '') + '、' + t : t;
    }
    inp.value = v; refreshNoteChips();
}
async function addNoteTag() {
    const raw = await uiPrompt('新增備註標籤', '例如 17、現、突破', { placeholder: '標籤文字', okText: '新增' });
    const t = (raw || '').trim().replace(NOTE_DELIM, '');
    if (!t) return;
    if (!noteTags.includes(t)) { noteTags.push(t); saveNoteTags(); }
    noteTagManage = false;
    toggleNoteTag(noteTags.indexOf(t));
}
function removeNoteTag(idx) { noteTags.splice(idx, 1); saveNoteTags(); refreshNoteChips(); }
function renderNoteHtml(note) {
    return noteTokens(note).map(t => noteTags.includes(t)
        ? `<button type="button" class="note-pill" data-action="note-search" data-t="${escH(t)}">${escH(t)}</button>`
        : `<span class="note-txt">${escH(t)}</span>`).join('');
}

// ===================== 搜尋 =====================
function searchQuery() { return ($('#searchInput').value || $('#desktopSearchInput').value || '').trim(); }
function setSearchText(t) { ['searchInput', 'desktopSearchInput'].forEach(id => { $('#' + id).value = t; }); if (t && !isDesktop()) $('#pill').classList.add('searching'); renderCards(); }
function toggleSearch(open) {
    const pill = $('#pill');
    const willOpen = open === undefined ? !pill.classList.contains('searching') : open;
    pill.classList.toggle('searching', willOpen);
    if (willOpen) setTimeout(() => $('#searchInput').focus(), 20);
    else { $('#searchInput').value = ''; $('#desktopSearchInput').value = ''; renderCards(); }
}

// ===================== 篩選、排序、檢視 =====================
function setFilter(f) { currentFilter = f; renderCards(); }
function changeSort(key) {
    if (currentSort === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    else { currentSort = key; sortDirection = SORT_OPTIONS.find(o => o.key === key).defaultDir; }
    renderSortOpts(); renderCards();
}
function renderSortOpts() {
    $('#sort-opts').innerHTML = SORT_OPTIONS.map(o => {
        const active = currentSort === o.key;
        return `<button class="sort-opt${active ? ' active' : ''}" data-action="sort" data-key="${o.key}"><span>${o.label}</span><span>${active ? (sortDirection === 'asc' ? '由小到大 ↑' : '由大到小 ↓') : ''}</span></button>`;
    }).join('');
    const cur = SORT_OPTIONS.find(o => o.key === currentSort);
    $('#desk-sort-label').textContent = '排序：' + cur.label;
}
function setView(v) {
    viewMode = v === 'list' ? 'list' : 'card';
    store.set('viewModeV10', viewMode);
    renderViewToggle(); renderCards();
}
function renderViewToggle() {
    $$('[data-view]').forEach(b => { const on = b.dataset.view === viewMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const pb = $('#pill-view-btn');
    pb.innerHTML = viewMode === 'list' ? '<svg class="ic"><use href="#i-grid"/></svg><span>卡片</span>' : '<svg class="ic"><use href="#i-list"/></svg><span>列表</span>';
}

function renderChips() {
    $('#chip-row').innerHTML = Object.keys(FILTER_LABELS).map(f => `<button class="chip${f === currentFilter ? ' active' : ''}" aria-pressed="${f === currentFilter}" data-action="filter" data-f="${f}">${FILTER_LABELS[f]}<b>${COIN_LIST.filter(c => matchFilter(c, f)).length}</b></button>`).join('');
    updateChipFade();
}
function updateChipFade() { const r = $('#chip-row'); $('.chips-wrap').classList.toggle('at-end', r.scrollLeft + r.clientWidth >= r.scrollWidth - 4); }

function getSortValue(coin) {
    const m = marketData[coin] || { price: 0, change: 0 }; const s = userSettings[coin] || {};
    const p = Number(m.price), e = Number(s.entry), t = Number(s.target);
    switch (currentSort) {
        case 'name': return coin;
        case 'change': return Number(m.change) || 0;
        case 'updateTime': return s.lastManualUpdate || 0;
        case 'expectedGain': return (e > 0 && t > 0) ? ((t - e) / e * 100) : -9999;
        case 'targetDist': return (t > 0 && p > 0) ? ((t - p) / p * 100) : 9999;
        case 'entryDist': return (e > 0 && p > 0) ? (Math.abs(p - e) / e * 100) : 9999;
        default: return 0;
    }
}

function visibleCoins() {
    const q = searchQuery().toUpperCase();
    let list = COIN_LIST.filter(c => c.toUpperCase().includes(q) || (q && noteTokens((userSettings[c] || {}).note).some(t => t.toUpperCase().includes(q))));
    if (currentFilter !== 'all') list = list.filter(c => matchFilter(c, currentFilter));
    list.sort((a, b) => {
        if (currentSort === 'name') return sortDirection === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
        const va = getSortValue(a), vb = getSortValue(b);
        return sortDirection === 'asc' ? va - vb : vb - va;
    });
    return list;
}

// ===================== 卡片與列表 =====================
// 進度條位置：止損→進場佔左 36%，進場→目標佔右 64%，兩段都用對數比例
const RAIL_ENTRY = 36;
function railPos(v, lo, entry, target) {
    if (!(v > 0)) return 0;
    if (v <= entry) { if (v <= lo) return 0; return RAIL_ENTRY * Math.log(v / lo) / Math.log(entry / lo); }
    if (v >= target) return 100;
    return RAIL_ENTRY + (100 - RAIL_ENTRY) * Math.log(v / entry) / Math.log(target / entry);
}

function pnlInfo(st) {
    const { s } = st;
    const entryPrice = Number(s.entry), curPrice = st.price, targetPrice = Number(s.target);
    if (!((st.holding || st.targetHit) && entryPrice > 0 && curPrice > 0)) return null;
    const pnlCalcPrice = st.targetHit && targetPrice > 0 ? targetPrice : curPrice;
    const pnlPct = ((pnlCalcPrice - entryPrice) / entryPrice * 100 * (s.leverage || 1));
    const pnlAbs = s.capital > 0 ? (s.capital * pnlPct / 100).toFixed(2) : null;
    return { pnlPct, pnlAbs, label: st.targetHit ? '結算盈虧（估）' : '倉位盈虧（估）', cls: pnlPct >= 0 ? 'up' : 'down', text: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` };
}

function tagsHtml(st) {
    let h = '';
    if (st.holding) h += '<span class="tag hold">已進場</span>';
    if (st.targetHit) h += '<span class="tag target">已達標</span>';
    if (st.stoppedOut) h += '<span class="tag stopped">已止損</span>';
    const si = stopInfo(st);
    if (si && si.broken) h += '<span class="tag danger">跌破止損</span>';
    else if (si && si.near) h += '<span class="tag danger">接近止損</span>';
    return h;
}

function cardHtml(coin) {
    const st = coinState(coin);
    const { s, m } = st;
    const curPrice = st.price, entryPrice = Number(s.entry), targetPrice = Number(s.target);
    const isUp = Number(m.change) >= 0;
    const si = stopInfo(st);
    const cls = ['card'];
    if (st.holding) cls.push('is-holding');
    if (st.targetHit) cls.push('is-target');
    if (st.stoppedOut) cls.push('is-stopped');
    if (si && (si.near || si.broken)) cls.push('is-near-stop');
    if (expandedCoins.has(coin)) cls.push('expanded');

    const pi = pnlInfo(st);
    const pnlHtml = pi ? `<div class="pnl"><p class="lbl">${pi.label}</p><div class="pnl-v ${pi.cls}">${pi.text}${pi.pnlAbs ? ` <small>($${pi.pnlAbs})</small>` : ''}</div></div>` : '';

    let railHtml = '';
    if (!st.noMarket && targetPrice > entryPrice && entryPrice > 0 && curPrice > 0) {
        const slp = Number(s.stopLoss) || 0;
        const lo = (slp > 0 && slp < entryPrice) ? slp : entryPrice * 0.7;
        const pE = RAIL_ENTRY, pC = railPos(curPrice, lo, entryPrice, targetPrice);
        const col = curPrice >= entryPrice ? 'var(--up)' : 'var(--down)';
        const fl = Math.min(pE, pC), fw = Math.abs(pC - pE);
        railHtml = `<div class="rail-wrap"><div class="rail"><span class="rail-f" style="left:${fl}%;width:${fw}%;background:${col}"></span><span class="rail-e" style="left:${pE}%"></span><span class="rail-p" style="left:${pC}%;background:${col}"></span></div>
            <div class="rail-l"><span>${slp > 0 ? `止損<b>${formatPrice(slp)}</b>` : ''}</span><span>進場<b>${formatPrice(entryPrice)}</b></span><span>目標<b>${formatPrice(targetPrice)}</b></span></div></div>`;
    }

    let distHtml = '';
    if (st.noMarket) distHtml = '<span class="state-txt muted">未適配／暫無報價</span>';
    else if (curPrice > 0) {
        if (st.targetHit) distHtml = '<span class="state-txt warn">已達標出場</span>';
        else if (st.stoppedOut) distHtml = '<span class="state-txt down">已止損出場</span>';
        else {
            const parts = [];
            if (st.holding && si) parts.push(si.broken ? '<span class="danger">已跌破止損</span>' : `<span${si.near ? ' class="danger"' : ''}>距止損<b>${si.dist.toFixed(2)}%</b></span>`);
            const goalPrice = st.holding ? targetPrice : entryPrice;
            if (goalPrice > 0) parts.push(`<span>${st.holding ? '距目標' : '距觸發'}<b>${(Math.abs(goalPrice - curPrice) / curPrice * 100).toFixed(2)}%</b></span>`);
            distHtml = parts.length ? `<div class="dists">${parts.join('')}</div>` : '<span class="muted">無標價</span>';
        }
    }

    return `<article class="${cls.join(' ')}" data-coin="${escH(coin)}" role="button" tabindex="0" aria-label="${escH(coin)} 詳情">
        <div class="c-head">
            <div class="sym"><span class="sym-name">${escH(coin)}</span>${tagsHtml(st)}</div>
            <span class="chg ${isUp ? 'up' : 'down'}">${isUp ? '▲' : '▼'} ${Math.abs(Number(m.change)).toFixed(2)}%</span>
        </div>
        <div class="c-body">
            <div><p class="lbl">現價</p><div class="price">${formatPrice(m.price)}</div></div>
            ${pnlHtml}
        </div>
        ${railHtml}
        <div class="c-foot">${distHtml}<span class="c-time">${formatRelativeTime(s.lastManualUpdate)}</span></div>
        <div class="c-more">
            <div class="more-row">
                <div class="notes">${s.note ? renderNoteHtml(s.note) : '<span class="note-txt muted">無備註</span>'}</div>
                <span class="src">${escH(m.src)}</span>
            </div>
            <div class="more-row more-row-2">
                <div class="more-meta"><span>進場<b>${formatFull(s.entry)}</b></span><span>目標<b>${formatFull(s.target)}</b></span></div>
                <button type="button" class="more-btn" data-action="open" data-coin="${escH(coin)}">詳情</button>
            </div>
        </div>
    </article>`;
}

const LIST_COLS = [
    { k: 'name', label: '代號', sort: 'name' },
    { k: 'price', label: '現價' },
    { k: 'chg', label: '24H', sort: 'change' },
    { k: 'entry', label: '進場', cls: 'd-only' },
    { k: 'target', label: '目標', cls: 'd-only' },
    { k: 'sl', label: '止損', cls: 'xl-only' },
    { k: 'dEntry', label: '距進場', sort: 'entryDist', cls: 'lg-only' },
    { k: 'dTarget', label: '距目標', sort: 'targetDist', cls: 'd-only' },
    { k: 'dSl', label: '距止損', cls: 'xl-only' },
    { k: 'gain', label: '預期收益', sort: 'expectedGain', cls: 'xxl-only' },
    { k: 'pnl', label: '盈虧（估）', cls: 'd-only' },
    { k: 'time', label: '更新', sort: 'updateTime', cls: 'lg-only' },
    { k: 'mob', label: '盈虧／距離', cls: 'm-only' }
];

function rowHtml(coin) {
    const st = coinState(coin);
    const { s, m } = st;
    const p = st.price, e = Number(s.entry), t = Number(s.target), sl = Number(s.stopLoss);
    const isUp = Number(m.change) >= 0;
    const si = stopInfo(st);
    const pi = pnlInfo(st);
    let stateTxt = '', stateCls = '';
    if (st.stoppedOut) { stateTxt = '已止損'; stateCls = 'stopped'; }
    else if (st.targetHit) { stateTxt = '已達標'; stateCls = 'target'; }
    else if (si && si.broken) { stateTxt = '跌破止損'; stateCls = 'danger'; }
    else if (si && si.near) { stateTxt = '接近止損'; stateCls = 'danger'; }
    else if (st.holding) { stateTxt = '已進場'; stateCls = 'hold'; }
    else if (st.noMarket) stateTxt = '未適配';
    else stateTxt = '觀望中';
    const pct = v => `${v.toFixed(2)}%`;
    const dEntry = e > 0 && p > 0 ? pct(Math.abs(e - p) / p * 100) : '--';
    const dTarget = t > 0 && p > 0 ? pct(Math.abs(t - p) / p * 100) : '--';
    const dSl = si ? (si.broken ? '<span class="down">已跌破</span>' : `<span class="${si.near ? 'down' : ''}">${pct(si.dist)}</span>`) : '--';
    const gain = e > 0 && t > 0 ? '+' + ((t - e) / e * 100).toFixed(2) + '%' : '--';
    const pnlCell = pi ? `<span class="l-two"><span class="${pi.cls}">${pi.text}</span>${pi.pnlAbs ? `<small>($${pi.pnlAbs})</small>` : ''}</span>` : '--';
    let mob;
    if (pi) mob = `<span class="l-two"><span class="${pi.cls}">${pi.text}</span><small>${pi.pnlAbs ? `$${pi.pnlAbs}` : '盈虧'}</small></span>`;
    else if (!st.noMarket && !st.stoppedOut && e > 0 && p > 0) mob = `<span class="l-two"><span>${dEntry}</span><small>距觸發</small></span>`;
    else mob = '<span class="muted">--</span>';
    const rc = st.stoppedOut ? 'is-stopped' : st.targetHit ? 'is-target' : st.holding ? 'is-holding' : '';
    const cells = {
        name: `<span class="l-sym"><b>${escH(coin)}</b><small class="${stateCls}">${stateTxt}</small></span>`,
        price: `<span class="l-price">${formatPrice(m.price)}</span>`,
        chg: `<span class="${isUp ? 'up' : 'down'}">${isUp ? '+' : '-'}${Math.abs(Number(m.change)).toFixed(2)}%</span>`,
        entry: e ? formatPrice(e) : '--',
        target: t ? formatPrice(t) : '--',
        sl: sl ? formatPrice(sl) : '--',
        dEntry, dTarget, dSl, gain,
        pnl: pnlCell,
        time: `<span class="muted">${formatRelativeTime(s.lastManualUpdate)}</span>`,
        mob
    };
    return `<div class="lrow ${rc}" data-coin="${escH(coin)}" role="button" tabindex="0" aria-label="${escH(coin)} 詳情">${LIST_COLS.map(c => `<div class="${c.cls || ''}">${cells[c.k]}</div>`).join('')}</div>`;
}

function listHeadHtml() {
    return `<div class="lrow lhead">${LIST_COLS.map(c => {
        const on = c.sort && currentSort === c.sort;
        const arrow = on ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
        return `<div class="${c.cls || ''}${on ? ' on' : ''}"${c.sort ? ` data-sort="${c.sort}"` : ''}>${c.label}${arrow}</div>`;
    }).join('')}</div>`;
}

function renderCards() {
    const container = $('#coin-container');
    renderChips();
    const list = visibleCoins();
    container.className = viewMode === 'list' ? 'view-list' : 'view-card';
    if (!list.length) {
        container.className = '';
        container.innerHTML = `<div class="empty"><p>沒有符合條件的幣種</p><button class="btn btn-sm" data-action="reset-filters">清除搜尋與篩選</button></div>`;
        return;
    }
    container.innerHTML = viewMode === 'list' ? listHeadHtml() + list.map(rowHtml).join('') : list.map(cardHtml).join('');
}

// ===================== 詳情與編輯 =====================
function openBottomSheet(coin) {
    if (!userSettings[coin]) return;
    selectedCoin = coin; editingCoin = null;
    renderBottomSheet(false);
    openPanel('bottom-sheet');
    $('#bottom-sheet').scrollTop = 0;
}

function renderBottomSheet(isEdit) {
    const coin = selectedCoin; if (!coin) return;
    const st = coinState(coin);
    const { s, m } = st;
    const entry = Number(s.entry), target = Number(s.target), sl = Number(s.stopLoss);
    const isUp = Number(m.change) >= 0;
    const expectedGain = entry > 0 && target > 0 ? ((target - entry) / entry * 100).toFixed(2) : '--';
    const expectedLoss = entry > 0 && sl > 0 ? ((entry - sl) / entry * 100).toFixed(2) : '--';
    const [base, quote] = coin.split('/');
    const c = $('#sheet-content');

    if (!isEdit) {
        editingCoin = null;
        let statusTag = st.holding ? '<span class="tag hold">已進場</span>' : '<span class="tag">觀望中</span>';
        if (st.targetHit) statusTag = '<span class="tag target">已達標</span>';
        else if (st.stoppedOut) statusTag = '<span class="tag stopped">已止損</span>';
        else if (s.manualStatus === 'no_market') statusTag = '<span class="tag stopped">未有適配市場</span>';
        const pi = pnlInfo(st);
        const si = stopInfo(st);
        c.innerHTML = `
        <div class="d-head">
            <div>
                <h3 class="d-title">${escH(base)}<small>/${escH(quote || 'USDT')}</small><span class="src">${escH(m.src)}</span></h3>
                <div class="d-price ${isUp ? 'up' : 'down'}">${formatPrice(m.price)}<small>${isUp ? '+' : ''}${Number(m.change).toFixed(2)}%</small></div>
            </div>
            ${statusTag}
        </div>
        <div class="d-rows">
            <div class="drow"><span>最後更新時間</span><span>${formatRelativeTime(s.lastManualUpdate)}</span></div>
            <div class="drow"><span>觸發價（進場價）</span><span>${entry ? formatFull(entry) : '--'}</span></div>
            <div class="drow"><span>目標價</span><span class="up">${target ? formatFull(target) : '--'}</span></div>
            <div class="drow"><span>預期收益 (%)</span><span class="${expectedGain !== '--' && parseFloat(expectedGain) > 0 ? 'up' : ''}">${expectedGain !== '--' ? '+' + expectedGain + '%' : '--'}</span></div>
            <div class="drow"><span>停損價</span><span class="down">${sl ? formatFull(sl) : '--'}</span></div>
            <div class="drow"><span>預期虧損 (%)</span><span class="${expectedLoss !== '--' ? 'down' : ''}">${expectedLoss !== '--' ? '-' + expectedLoss + '%' : '--'}</span></div>
            ${si ? `<div class="drow"><span>距止損</span><span class="${si.near || si.broken ? 'down' : ''}">${si.broken ? '已跌破' : si.dist.toFixed(2) + '%'}</span></div>` : ''}
            ${s.capital ? `<div class="drow"><span>投入金額／槓桿</span><span>${s.capital} USDT · ${s.leverage || 1}x</span></div>` : ''}
            ${pi ? `<div class="drow"><span>${pi.label}</span><span class="${pi.cls}">${pi.text}${pi.pnlAbs ? ` ($${pi.pnlAbs})` : ''}</span></div>` : ''}
        </div>
        ${s.note ? `<div class="d-note"><p class="lbl" style="margin-bottom:8px">備註</p><div class="notes">${renderNoteHtml(s.note)}</div></div>` : ''}
        ${Cloud.isAdmin ? `<div class="d-actions"><button class="btn" data-action="edit"><svg class="ic"><use href="#i-edit"/></svg>修改計畫</button></div>` : ''}`;
        return;
    }

    editingCoin = coin;
    renderStatus();
    const dropdownValue = s.manualStatus ? s.manualStatus : (s.isHolding ? 'true' : 'false');
    let sumCapital = 0; COIN_LIST.forEach(x => { if (userSettings[x] && userSettings[x].capital) sumCapital += Number(userSettings[x].capital); });
    const sug = sumCapital > 0 ? (sumCapital * 0.05).toFixed(2) : null;
    const opt = (v, t) => `<option value="${v}"${dropdownValue === v ? ' selected' : ''}>${t}</option>`;
    c.innerHTML = `
    <div class="d-head"><h3 class="d-title">${escH(coin.includes('/') ? coin : coin + '/USDT')}<small>編輯計畫</small></h3></div>
    <form class="form" id="edit-form" novalidate>
        <div><label class="lbl" for="edit-holding">交易狀態</label>
            <select id="edit-holding">${opt('false', '觀望中')}${opt('true', '已進場')}${opt('target_reached', '已達標')}${opt('stopped_out', '已止損')}${opt('no_market', '未有適配市場')}</select></div>
        <div><label class="lbl" for="edit-entry">觸發價（進場價）</label><input type="number" step="any" inputmode="decimal" id="edit-entry" value="${s.entry || ''}" placeholder="0"></div>
        <div class="form-2">
            <div><label class="lbl" for="edit-target">目標價</label><input type="number" step="any" inputmode="decimal" id="edit-target" value="${s.target || ''}" placeholder="0"></div>
            <div><label class="lbl" for="edit-sl">停損價</label><input type="number" step="any" inputmode="decimal" id="edit-sl" value="${s.stopLoss || ''}" placeholder="0"></div>
        </div>
        <div><label class="lbl" for="edit-note">備註</label>
            <input type="text" id="edit-note" value="${escH(s.note || '')}" placeholder="可直接輸入，或點下方標籤">
            <div id="note-tag-row" class="note-chips">${renderNoteTagChips(s.note)}</div></div>
        <div class="form-sec">
            <p class="sec-title">資金計算</p>
            <div class="form-2">
                <div><label class="lbl" for="edit-capital">單筆投入金額（USDT）</label><input type="number" step="any" inputmode="decimal" id="edit-capital" value="${s.capital || ''}" placeholder="0"></div>
                <div><label class="lbl" for="edit-leverage">槓桿（x）</label><input type="number" step="any" inputmode="decimal" id="edit-leverage" value="${s.leverage || 1}" min="1" max="100"></div>
            </div>
            ${sug && !s.capital ? `<p class="suggest">建議投入清單本金 5%：<button type="button" data-action="apply-capital" data-v="${sug}">套用 $${sug}</button></p>` : ''}
        </div>
        <div class="form-actions">
            <button type="submit" class="btn primary">儲存計畫</button>
            <button type="button" class="btn" data-action="cancel-edit">取消</button>
            <button type="button" class="btn danger" data-action="remove-coin"><svg class="ic"><use href="#i-trash"/></svg>移除這個幣種</button>
        </div>
    </form>`;
}

async function saveEdit() {
    const coin = selectedCoin; if (!coin) return;
    const newEntry = parseFloat($('#edit-entry').value) || 0;
    const holdingVal = $('#edit-holding').value;
    let newHolding = holdingVal === 'true' || holdingVal === 'target_reached';
    let newManualStatus = (holdingVal === 'target_reached' || holdingVal === 'no_market' || holdingVal === 'stopped_out') ? holdingVal : null;

    // 自動重置防呆機制：如果原本是「已止損」或「已達標」，且「修改了進場價」，自動解除鎖定狀態變回「觀望中」
    const oldEntry = Number(userSettings[coin].entry) || 0;
    if (newEntry !== oldEntry && (newManualStatus === 'stopped_out' || newManualStatus === 'target_reached')) {
        newHolding = false;
        newManualStatus = null;
    }

    const newTarget = parseFloat($('#edit-target').value) || 0;
    const newSl = parseFloat($('#edit-sl').value) || 0;
    const newNote = $('#edit-note').value || '';
    const newCapital = parseFloat($('#edit-capital').value) || 0;
    const newLeverage = parseFloat($('#edit-leverage').value) || 1;

    const cur = userSettings[coin];
    const needsTimeUpdate = cur.entry !== newEntry || cur.target !== newTarget || cur.stopLoss !== newSl || cur.isHolding !== newHolding || cur.manualStatus !== newManualStatus || cur.capital !== newCapital || cur.leverage !== newLeverage;

    Object.assign(cur, { entry: newEntry, target: newTarget, stopLoss: newSl, isHolding: newHolding, manualStatus: newManualStatus, note: newNote, capital: newCapital, leverage: newLeverage });
    if (needsTimeUpdate) cur.lastManualUpdate = Date.now();

    if (!newHolding && newEntry > 0) { const cp = Number((marketData[coin] || {}).price || 0); if (cp > 0 && cp < newEntry) cur.entrySide = 'breakout'; else if (cp > 0 && cp > newEntry) cur.entrySide = 'dip'; else cur.entrySide = null } else { cur.entrySide = null }

    saveSettings();
    closePanels();
    gdUpdate();
    await syncOps({ set: { [coin]: Object.assign({}, cur) } }, '已儲存 ' + coin + ' 計畫並同步雲端');
}

async function removeCoin(coin) {
    if (!await uiConfirm(`移除 ${coin}？`, '這個幣種的計畫會一併刪除，雲端也會同步移除。之後可以從「設定 → 新增幣種」再加回來。', { okText: '移除', danger: true })) return;
    delete userSettings[coin];
    delete marketData[coin];
    expandedCoins.delete(coin);
    const g = userSettings.__GLOBAL__ && typeof userSettings.__GLOBAL__ === 'object' ? userSettings.__GLOBAL__ : {};
    g.removedCoins = Array.from(new Set((g.removedCoins || []).concat(coin)));
    userSettings.__GLOBAL__ = g;
    syncCoinList(); saveSettings();
    closePanels(); gdUpdate();
    await syncOps({ del: [coin], addRemoved: [coin] }, `已移除 ${coin}`);
}

// ===================== 新增幣種（用 CoinGecko 搜尋幣 ID） =====================
function openAddCoin() {
    selectedCoin = null; editingCoin = null;
    $('#sheet-content').innerHTML = `
    <div class="d-head"><h3 class="d-title">新增幣種</h3></div>
    <form class="form" id="add-coin-form">
        <div><label class="lbl" for="add-coin-q">幣種代號或名稱</label><input type="text" id="add-coin-q" placeholder="例如 SOL、Solana" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
        <button type="submit" class="btn primary"><svg class="ic"><use href="#i-search"/></svg>在 CoinGecko 搜尋</button>
    </form>
    <div class="search-results" id="add-coin-results"></div>`;
    openPanel('bottom-sheet');
    setTimeout(() => $('#add-coin-q').focus(), 60);
}

let addCoinCandidates = [];
async function searchCoin(q) {
    const box = $('#add-coin-results');
    if (!q) return;
    box.innerHTML = '<div class="empty" style="padding:24px 0"><div class="spinner"></div></div>';
    try {
        const d = await cgGet('/search', { query: q });
        addCoinCandidates = (d.coins || []).slice(0, 8);
        if (!addCoinCandidates.length) { box.innerHTML = '<p class="hint">找不到符合的幣種，換個關鍵字試試。</p>'; return; }
        box.innerHTML = addCoinCandidates.map((x, i) => {
            const sym = String(x.symbol || '').toUpperCase();
            const exists = COIN_LIST.includes(sym), blocked = REMOVED_COINS.includes(sym);
            return `<button type="button" class="result" data-action="add-coin-pick" data-i="${i}"${exists || blocked ? ' disabled' : ''}>
                <span><b>${escH(sym)}</b><small>${escH(x.name)} · ${escH(x.id)}</small></span>
                <small>${exists ? '已在清單' : blocked ? '設定檔已停用' : x.market_cap_rank ? '市值第 ' + escH(x.market_cap_rank) + ' 名' : '無市值排名'}</small></button>`;
        }).join('');
    } catch (e) {
        box.innerHTML = `<p class="hint">搜尋失敗：${escH(e.message)}</p>`;
    }
}

async function pickCoin(i) {
    const x = addCoinCandidates[i]; if (!x) return;
    const sym = String(x.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(sym) || !CG_ID_RE.test(x.id)) { showToast('這個幣種代號無法使用', 'error'); return; }
    if (COIN_LIST.includes(sym)) { showToast(sym + ' 已在清單中', 'error'); return; }
    if (REMOVED_COINS.includes(sym)) { showToast(sym + ' 在 config.js 的 REMOVED_COINS 裡被停用，要先從那裡拿掉', 'error'); return; }
    const settings = Object.assign(COIN_DEFAULTS(), COIN_ID_MAP[sym] === x.id ? {} : { cgId: x.id });
    userSettings[sym] = settings;
    const g = userSettings.__GLOBAL__;
    if (g && Array.isArray(g.removedCoins)) g.removedCoins = g.removedCoins.filter(c => c !== sym);
    syncCoinList(); saveSettings();
    closePanels();
    showToast(`已新增 ${sym}`);
    await syncOps({ set: { [sym]: settings }, unRemove: [sym] });
    fetchExchangeData(true);
}

// ===================== 資金看板（計算與 v9.2 相同） =====================
let gdRealized = parseFloat(store.get('gdRealized')) || 0;
if (userSettings.__GLOBAL__ && userSettings.__GLOBAL__.realizedPnL !== undefined) {
    gdRealized = Number(userSettings.__GLOBAL__.realizedPnL) || 0;
    store.set('gdRealized', gdRealized);
}

function gdGetFloatPnl() {
    let tot = 0;
    COIN_LIST.forEach(coin => {
        const s = userSettings[coin], m = marketData[coin];
        if (!s || !m || !s.isHolding || !s.capital || !s.entry) return;
        const targetHit = s.manualStatus === 'target_reached' || (s.isHolding && s.target > 0 && Number(m.price) >= Number(s.target));
        if (targetHit) return;
        const p = Number(m.price), e = Number(s.entry), cap = Number(s.capital), lev = Number(s.leverage || 1);
        if (p > 0 && e > 0) tot += cap * ((p - e) / e) * lev;
    });
    return tot;
}

function gdCalcProgress() {
    let sumCapital = 0;
    let sumTargetProfit = 0;
    COIN_LIST.forEach(coin => {
        const s = userSettings[coin];
        if (!s || !s.capital) return;
        const cap = Number(s.capital);
        sumCapital += cap;
        const e = Number(s.entry), t = Number(s.target);
        const lev = Number(s.leverage || 1);
        if (e > 0 && t > 0) sumTargetProfit += cap * lev * ((t - e) / e);
    });
    return { sumCapital, sumTargetProfit };
}

function gdSaveLocal() {
    gdRealized = parseFloat($('#gd-realized').value) || 0;
    store.set('gdRealized', gdRealized);
    gdUpdate();
}

async function gdSaveCloud() {
    gdSaveLocal();
    const g = userSettings.__GLOBAL__ && typeof userSettings.__GLOBAL__ === 'object' ? userSettings.__GLOBAL__ : {};
    g.realizedPnL = gdRealized;
    userSettings.__GLOBAL__ = g;
    saveSettings();
    await syncOps({ global: { realizedPnL: gdRealized } }, '已實現損益已同步雲端');
}

const setText = (id, txt, color) => { const el = $('#' + id); if (!el) return; el.textContent = txt; if (color !== undefined) el.style.color = color; };

function gdUpdate() {
    const floatPnl = gdGetFloatPnl();
    const totalProfit = gdRealized + floatPnl;
    const { sumCapital, sumTargetProfit } = gdCalcProgress();

    setText('gd-principal-disp', sumCapital.toFixed(2) + ' U', 'var(--text)');
    setText('gd-target-profit-disp', sumTargetProfit.toFixed(2) + ' U', 'var(--up)');
    setText('gd-float', (floatPnl >= 0 ? '+' : '') + floatPnl.toFixed(2) + ' U', floatPnl >= 0 ? 'var(--up)' : 'var(--down)');
    const totalTxt = (totalProfit >= 0 ? '+' : '') + totalProfit.toFixed(2) + ' USDT';
    const totalCol = totalProfit >= 0 ? 'var(--up)' : 'var(--down)';
    setText('gd-total-profit', totalTxt, totalCol);
    setText('gd-sum-total', totalTxt, totalCol);

    let pillTxt = '', pillCol = '';
    if (sumCapital > 0) { const p2 = totalProfit / sumCapital * 100; pillTxt = (p2 >= 0 ? '+' : '') + p2.toFixed(1) + '%'; pillCol = p2 >= 0 ? 'var(--up)' : 'var(--down)'; }
    setText('gd-pill', pillTxt, pillCol);
    setText('gd-sum-pill', pillTxt, pillCol);

    let overallPct = 0;
    if (sumTargetProfit > 0) overallPct = Math.max(0, Math.min(100, totalProfit / sumTargetProfit * 100));

    const barAPct = overallPct;
    $('#gd-bar-a-fill').style.width = barAPct + '%';
    $('#gd-bar-a-dot').style.left = barAPct + '%';
    setText('gd-bar-a-pct', barAPct.toFixed(1) + '%', barAPct >= 50 ? 'var(--up)' : 'var(--warn)');
    setText('gd-bar-a-mid', barAPct.toFixed(1) + '%');

    const barBPct = barAPct;
    const curU = totalProfit;
    const tgtU = sumTargetProfit;
    $('#gd-bar-b-fill').style.width = barBPct + '%';
    $('#gd-bar-b-dot').style.left = barBPct + '%';
    setText('gd-bar-b-l', sumCapital > 0 ? '$' + sumCapital.toLocaleString() : '$0');
    setText('gd-bar-b-m', (curU >= 0 ? '+$' : '-$') + Math.abs(curU).toFixed(0), curU >= 0 ? 'var(--up)' : 'var(--down)');
    setText('gd-bar-b-r', tgtU > 0 ? '+$' + tgtU.toFixed(0) : '--');
    setText('gd-bar-b-lbl', (curU >= 0 ? '+$' : '-$') + Math.abs(curU).toFixed(2), curU >= 0 ? 'var(--up)' : 'var(--down)');
    setText('gd-bar-b-right', tgtU > 0 ? '目標 +$' + tgtU.toFixed(0) : '（未設目標）');
    setText('gd-note', Cloud.isAdmin ? '' : '「歷史已實現損益」只有管理員修改時才會同步到雲端。');
}

// ===================== 模式顯示 =====================
function renderMode() {
    const admin = Cloud.isAdmin;
    const tag = $('#mode-tag');
    tag.textContent = admin ? '管理者' : (Cloud.configured() ? '訪客' : '本機');
    tag.classList.toggle('admin', admin);
    const s = $('#sync-status');
    if (admin) { s.textContent = '管理者模式'; s.className = 'sync-status admin'; }
    else if (Cloud.configured()) { s.textContent = '唯讀訪客模式'; s.className = 'sync-status'; }
    else { s.textContent = '本地端未連線'; s.className = 'sync-status'; }
    if (Cloud.workerMode) s.textContent += ' · 安全模式';
    $('#login-form').hidden = admin;
    $('#logout-box').hidden = !admin;
    $('#admin-tools').hidden = !admin;
    $('#sec-bin').hidden = Cloud.workerMode;
    $('#create-bin-btn').hidden = Cloud.workerMode;
    $('#version-line').textContent = `策略看板 ${APP_VERSION}`;
    gdUpdate();
}

// ===================== 動作 =====================
async function doLogin() {
    const u = $('#admin-user').value.trim(), p = $('#admin-pass').value.trim();
    if (!u || !p) { showToast('請輸入帳號和密碼', 'error'); return; }
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = '登入中…';
    try {
        await Cloud.login(u, p);
        $('#admin-user').value = ''; $('#admin-pass').value = '';
        renderMode(); renderCards();
        showToast('登入成功');
    } catch (e) {
        showToast('登入失敗：' + e.message, 'error');
    } finally { btn.disabled = false; btn.textContent = '登入'; }
}

async function doLogout() {
    if (!await uiConfirm('登出管理者模式？', '登出後就無法修改計畫，資料不會被刪除。', { okText: '登出' })) return;
    Cloud.logout(); renderCards(); showToast('已登出', 'info');
}

async function guestRefresh() {
    const btn = $('#guest-refresh-btn'); btn.disabled = true;
    saveSyncConfig();
    if (!Cloud.configured()) { showToast('尚未填寫 Bin ID', 'error'); btn.disabled = false; return; }
    await fetchFromCloud(false);
    btn.disabled = false;
}

async function forcePush() {
    if (!await uiConfirm('強制上傳到雲端？', '會用這台裝置上的全部資料覆蓋雲端，其他裝置或雲端程式剛寫入的改動會被蓋掉。只有在確定這台的資料最正確時才使用。', { okText: '覆蓋上傳', danger: true })) return;
    setSaving(true);
    try { await Cloud.replace(userSettings); showToast('已覆蓋上傳雲端'); }
    catch (e) { showToast('上傳失敗：' + e.message, 'error'); }
    finally { setSaving(false); }
}

async function createCloudBin() {
    if (!Cloud.isAdmin) { showToast('請先登入管理員', 'error'); return; }
    if (!await uiConfirm('建立全新的公開區塊？', '會用這台裝置的資料建立一個新的雲端區塊，並切換到新區塊。原本的區塊不會被刪除。', { okText: '建立' })) return;
    try {
        const id = await Cloud.createBin(userSettings);
        $('#sync-bin').value = id; saveSyncConfig();
        await uiAlert('新區塊已建立', 'Bin ID：' + id);
    } catch (e) { showToast('建立失敗：' + e.message, 'error'); }
}

// ===================== 事件 =====================
let longPressTimer = null, longPressFired = false, pressStart = null, lastPointerType = 'mouse';

function bindEvents() {
    $('#overlay').addEventListener('click', closePanels);
    $$('[data-close]').forEach(b => b.addEventListener('click', closePanels));

    // 卡片：滑鼠點一下開詳情；手指點一下展開、長按開詳情（iPad 接觸控板也能用）
    const cc = $('#coin-container');
    cc.addEventListener('pointerdown', e => {
        lastPointerType = e.pointerType || 'mouse';
        const card = e.target.closest('.card');
        if (!card || e.target.closest('button') || e.pointerType === 'mouse') return;
        longPressFired = false;
        pressStart = { x: e.clientX, y: e.clientY };
        card.classList.add('pressing');
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            longPressFired = true;
            card.classList.remove('pressing');
            if (navigator.vibrate) navigator.vibrate(60);
            openBottomSheet(card.dataset.coin);
        }, 600);
    });
    const cancelPress = () => { clearTimeout(longPressTimer); $$('.card.pressing').forEach(c => c.classList.remove('pressing')); };
    cc.addEventListener('pointermove', e => { if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) { cancelPress(); pressStart = null; } });
    cc.addEventListener('pointerup', cancelPress);
    cc.addEventListener('pointercancel', () => { cancelPress(); pressStart = null; });
    cc.addEventListener('contextmenu', e => { if (e.target.closest('.card') && lastPointerType !== 'mouse') e.preventDefault(); });
    cc.addEventListener('click', e => {
        const sortCell = e.target.closest('[data-sort]');
        if (sortCell) { changeSort(sortCell.dataset.sort); return; }
        if (e.target.closest('[data-action]')) return;   // 交給下面的通用動作處理
        const item = e.target.closest('[data-coin]');
        if (!item) return;
        if (longPressFired) { longPressFired = false; return; }
        if (item.classList.contains('card') && lastPointerType !== 'mouse' && !hasMouse()) {
            const coin = item.dataset.coin;
            const on = item.classList.toggle('expanded');
            on ? expandedCoins.add(coin) : expandedCoins.delete(coin);
        } else openBottomSheet(item.dataset.coin);
    });
    cc.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-coin][role=button]')) { e.preventDefault(); openBottomSheet(e.target.dataset.coin); }
    });

    // 通用動作
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (!el || el.disabled) return;
        const a = el.dataset.action;
        switch (a) {
            case 'filter': setFilter(el.dataset.f); break;
            case 'sort': changeSort(el.dataset.key); if (!isDesktop()) closePanels(); break;
            case 'sort-menu': toggleSortMenu(el); break;
            case 'toggle-view': setView(viewMode === 'list' ? 'card' : 'list'); break;
            case 'search': toggleSearch(true); break;
            case 'search-close': toggleSearch(false); break;
            case 'notif': openPanel('notif-panel'); renderNotifList(); markAllNotifRead(); break;
            case 'settings': openPanel('side-panel'); break;
            case 'gd': openPanel('gd'); break;
            case 'clear-notif': clearNotifLog(); break;
            case 'open': e.stopPropagation(); openBottomSheet(el.dataset.coin); break;
            case 'edit': renderBottomSheet(true); break;
            case 'cancel-edit': renderBottomSheet(false); renderStatus(); break;
            case 'remove-coin': removeCoin(selectedCoin); break;
            case 'apply-capital': $('#edit-capital').value = el.dataset.v; break;
            case 'note-tag': toggleNoteTag(+el.dataset.i); break;
            case 'note-tag-remove': removeNoteTag(+el.dataset.i); break;
            case 'note-tag-add': addNoteTag(); break;
            case 'note-tag-manage': noteTagManage = !noteTagManage; refreshNoteChips(); break;
            case 'note-search': e.stopPropagation(); closePanels(); setSearchText(el.dataset.t); break;
            case 'reset-filters': ['searchInput', 'desktopSearchInput'].forEach(id => { $('#' + id).value = ''; }); $('#pill').classList.remove('searching'); setFilter('all'); break;
            case 'guest-refresh': guestRefresh(); break;
            case 'logout': doLogout(); break;
            case 'add-coin': openAddCoin(); break;
            case 'add-coin-pick': pickCoin(+el.dataset.i); break;
            case 'fetch-cloud': fetchFromCloud(false); break;
            case 'force-push': forcePush(); break;
            case 'create-bin': createCloudBin(); break;
            case 'browser-notify': requestBrowserNotify(); break;
            case 'tg-save': saveTgConfig(); break;
            case 'tg-test': testTgNotify(); break;
            case 'export': exportSettings(); break;
            case 'import': importSettings(); break;
        }
    });

    $$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#status').addEventListener('click', () => { countdown = REFRESH_SECONDS; setPriceState('loading', '更新中…', ''); fetchExchangeData(true); });
    $('#login-form').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
    $('#sync-bin').addEventListener('change', saveSyncConfig);
    $('#gd-realized').addEventListener('input', gdSaveLocal);
    $('#gd-realized').addEventListener('change', gdSaveCloud);
    $('#chip-row').addEventListener('scroll', updateChipFade, { passive: true });

    document.addEventListener('submit', e => {
        if (e.target.id === 'edit-form') { e.preventDefault(); saveEdit(); }
        if (e.target.id === 'add-coin-form') { e.preventDefault(); searchCoin($('#add-coin-q').value.trim()); }
    });
    document.addEventListener('input', e => { if (e.target.id === 'edit-note') refreshNoteChips(); });
    document.addEventListener('focusin', e => { if (e.target.type === 'number' && parseFloat(e.target.value) === 0 && e.target.id !== 'gd-realized') e.target.value = ''; });

    let searchTimer;
    ['searchInput', 'desktopSearchInput'].forEach(id => $('#' + id).addEventListener('input', e => {
        const other = id === 'searchInput' ? 'desktopSearchInput' : 'searchInput';
        $('#' + other).value = e.target.value;
        clearTimeout(searchTimer); searchTimer = setTimeout(renderCards, 120);
    }));

    document.addEventListener('keydown', e => {
        if ($('#dialog').classList.contains('open')) return;
        if (e.key === 'Escape') {
            if (PANELS.some(isOpen)) closePanels();
            else if ($('#pill').classList.contains('searching')) toggleSearch(false);
            return;
        }
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        if (e.key === '/' && !typing && isDesktop()) { e.preventDefault(); $('#desktopSearchInput').focus(); }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || editingCoin) return;
        fetchExchangeData();
        if (!(lastFetchAt && Date.now() - lastFetchAt < MIN_FETCH_GAP_MS)) countdown = REFRESH_SECONDS;
        cloudSyncCounter = 300;
        if (Cloud.configured()) fetchFromCloud(true).then(res => { if (res && (res.coinsChanged || res.newNotifs)) showToast('已同步雲端最新狀態'); });
    });

    window.addEventListener('resize', () => { syncTopbarHeight(); if (isDesktop() && isOpen('gd')) closePanels(); });
}

function toggleSortMenu(btn) {
    if (isOpen('sort-menu')) { closePanels(); return; }
    const m = $('#sort-menu');
    if (isDesktop()) {
        const b = (btn && btn.getBoundingClientRect && btn.offsetParent) ? btn : $('#desk-sort-btn');
        const r = b.getBoundingClientRect();
        m.style.top = (r.bottom + 8) + 'px';
        m.style.left = Math.min(r.left, window.innerWidth - 296) + 'px';
        openPanel('sort-menu', { clearOverlay: true });
    } else {
        m.style.top = ''; m.style.left = '';
        openPanel('sort-menu');
    }
}

function syncTopbarHeight() { document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px'); }

// ===================== 定時更新 =====================
function tick() {
    // 分頁在背景時暫停報價倒數，不會在沒人看的時候消耗 CoinGecko 額度
    if (!document.hidden) {
        countdown--;
        if (countdown <= 0) { countdown = REFRESH_SECONDS; fetchExchangeData(true); }
        gdUpdate();
        renderStatus();
    }
    // 雲端通知照常每 5 分鐘同步（不耗 CoinGecko 額度），有新通知才能跳提醒
    cloudSyncCounter--;
    if (cloudSyncCounter <= 0) { cloudSyncCounter = 300; if (Cloud.configured() && !editingCoin) fetchFromCloud(true); }
}

// ===================== 啟動 =====================
function init() {
    Cloud.init();
    syncCoinList();
    saveSettings();
    $('#sync-bin').value = Cloud.bin;
    $('#tg-token').value = tgToken || '';
    $('#tg-chatid').value = tgChatId || '';
    $('#gd-realized').value = gdRealized || '';
    bindEvents();
    renderMode();
    renderSortOpts();
    renderViewToggle();
    updateNotifyStatus();
    updateNotifBadge();
    renderNotifList();
    gdUpdate();
    syncTopbarHeight();
    if (window.ResizeObserver) new ResizeObserver(syncTopbarHeight).observe($('#topbar'));
    renderStatus();
    fetchExchangeData(true);
    if (Cloud.configured()) fetchFromCloud(true);
    setInterval(tick, 1000);
}

init();
