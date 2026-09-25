'use strict';

/*
 * Backend за резервации на дентален кабинет.
 * Без външни зависимости — само вградените модули на Node.js.
 *
 * Стартиране:  node server.js
 * Настройки:   config.json (работно време, услуги, дни напред)
 * База:        data/bookings.json (създава се автоматично)
 */
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    family: 4,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

async function sendEmail(to, subject, text) {
    await mailTransporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject,
        text,
    });
}



const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'bookings.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 часа

const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const DEFAULT_ADMIN_PASSWORD = '';


/* ---------------------------------------------------------------- конфиг -- */

function loadConfig() {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    const wh = cfg.workHours || {};
    if (!Number.isInteger(wh.start) || !Number.isInteger(wh.end) || wh.start >= wh.end) {
        throw new Error('config.json: workHours.start трябва да е по-малко от workHours.end');
    }
    if (!Number.isInteger(cfg.slotMin) || cfg.slotMin < 5 || cfg.slotMin > 240) {
        throw new Error('config.json: slotMin трябва да е между 5 и 240 минути');
    }
    if (!Number.isInteger(cfg.daysAhead) || cfg.daysAhead < 1 || cfg.daysAhead > 180) {
        throw new Error('config.json: daysAhead трябва да е между 1 и 180');
    }
    if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
        throw new Error('config.json: трябва да има поне една услуга');
    }
    cfg.closedWeekdays = Array.isArray(cfg.closedWeekdays) ? cfg.closedWeekdays : [];
    return cfg;
}

const CONFIG = loadConfig();
const SERVICE_NAMES = new Set(CONFIG.services.map(s => s.name));

/* ------------------------------------------------------- дати и часове -- */

function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    // отхвърля неща като 2026-02-31, които Date мълчаливо превърта
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
}

/** Всички часове в рамките на работния ден, напр. ["12:00","12:30",...]. */
function buildTimes() {
    const times = [];
    const startMin = CONFIG.workHours.start * 60;
    const endMin = CONFIG.workHours.end * 60;
    for (let mins = startMin; mins + CONFIG.slotMin <= endMin; mins += CONFIG.slotMin) {
        times.push(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
    }
    return times;
}

const ALL_TIMES = buildTimes();

/** Датите, за които изобщо приемаме резервации (от днес напред, без почивните дни). */
function bookableDates() {
    const out = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);

    for (let i = 0; i < CONFIG.daysAhead; i++) {
        const dateStr = fmtDate(d);

        let isVacation = false;

        if (
            CONFIG.notice &&
            CONFIG.notice.enabled &&
            CONFIG.notice.from &&
            CONFIG.notice.to
        ) {
            isVacation =
                dateStr >= CONFIG.notice.from &&
                dateStr <= CONFIG.notice.to;
        }

        if (
            !CONFIG.closedWeekdays.includes(d.getDay()) &&
            !isVacation
        ) {
            out.push(dateStr);
        }

        d.setDate(d.getDate() + 1);
    }

    return out;
}

function isPastSlot(dateStr, time) {
    const [h, m] = time.split(':').map(Number);
    const slot = parseDateStr(dateStr);
    slot.setHours(h, m, 0, 0);
    return slot.getTime() <= Date.now();
}

/* ---------------------------------------------------------------- база -- */

let db = { bookings: [] };
let writeChain = Promise.resolve();

async function loadDb() {
    try {
        const result = await dbPool.query(`
            SELECT
                id,
                date,
                time,
                name,
                phone,
                email,
                service,
                note,
                status,
                created_at
            FROM bookings
            ORDER BY date, time
        `);

        db = {
            bookings: result.rows.map(row => ({
                id: row.id,
                date: row.date.toISOString().slice(0, 10),
                time: row.time,
                name: row.name,
                phone: row.phone,
                email: row.email || '',
                service: row.service,
                note: row.note || '',
                status: row.status,
                createdAt: row.created_at.toISOString()
            }))
        };

        console.log(`✅ Заредени резервации от PostgreSQL: ${db.bookings.length}`);
    } catch (error) {
        console.error('❌ Грешка при зареждане на резервациите от PostgreSQL:');
        console.error(error.message);

        db = { bookings: [] };
    }
}

/** Атомарен запис — първо във временен файл, после rename. */
async function persist() {
    const client = await dbPool.connect();

    try {
        await client.query('BEGIN');

        await client.query('DELETE FROM bookings');

        for (const booking of db.bookings) {
            await client.query(
                `
                INSERT INTO bookings
                (
                    id,
                    date,
                    time,
                    name,
                    phone,
                    email,
                    service,
                    note,
                    status,
                    created_at
                )
                VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `,
                [
                    booking.id,
                    booking.date,
                    booking.time,
                    booking.name,
                    booking.phone,
                    booking.email || null,
                    booking.service,
                    booking.note || '',
                    booking.status,
                    booking.createdAt
                ]
            );
        }

        await client.query('COMMIT');

        console.log(`✅ Запазени резервации в PostgreSQL: ${db.bookings.length}`);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Пуска fn сериализирано спрямо всички други мутации.
 * Така две едновременни заявки не могат да запишат един и същ час.
 */
function withDb(fn) {
    const run = writeChain.then(fn);
    writeChain = run.then(() => {}, () => {});
    return run;
}

function isActive(b) {
    return b.status !== 'cancelled';
}

function takenTimes(dateStr) {
    return new Set(db.bookings.filter(b => b.date === dateStr && isActive(b)).map(b => b.time));
}

/* -------------------------------------------------------------- сесии -- */

const sessions = new Map();   // token -> expiresAt

function adminPassword() {
    return process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
}

function passwordMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(adminPassword()).digest();
    return crypto.timingSafeEqual(a, b);
}

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
}

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}

function isAdmin(req) {
    const token = readCookie(req, 'dc_session');
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token);
}, 30 * 60 * 1000).unref();

/* -------------------------------------------------- ограничение на заявки -- */

const rateBuckets = new Map();   // ключ -> { count, resetAt }

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
        rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (bucket.count >= max) return false;
    bucket.count++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(key);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
    return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------- helpers -- */

function sendJson(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
    });
    res.end(body);
}

function readBody(req, limitBytes = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(Object.assign(new Error('Заявката е твърде голяма'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                const parsed = JSON.parse(raw);
                resolve(parsed && typeof parsed === 'object' ? parsed : {});
            } catch {
                reject(Object.assign(new Error('Невалиден JSON'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

function str(value, maxLen) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

/* ------------------------------------------------- статични файлове -- */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

// файлове, които не бива да са достъпни през браузъра
const BLOCKED = new Set(['server.js', 'config.json', 'package.json', 'claude.md', 'readme.md']);

async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';

    const target = path.join(ROOT, path.normalize(rel));
    // никакво излизане извън папката на проекта
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
        return sendJson(res, 403, { error: 'Забранен достъп' });
    }
    const name = path.basename(target).toLowerCase();
    if (BLOCKED.has(name) || name.startsWith('.') || target.startsWith(DATA_DIR)) {
        return sendJson(res, 403, { error: 'Забранен достъп' });
    }

    try {
        const stat = await fsp.stat(target);
        if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(target).pipe(res);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 — страницата не е намерена</h1><p><a href="/">Към началото</a></p>');
    }
}

/* ------------------------------------------------------ публично API -- */

function apiConfig(res) {
    sendJson(res, 200, {
        clinicName: CONFIG.clinicName,
        workHours: CONFIG.workHours,
        slotMin: CONFIG.slotMin,
        daysAhead: CONFIG.daysAhead,
        closedWeekdays: CONFIG.closedWeekdays,
        services: CONFIG.services,
        notice: CONFIG.notice,
        dates: bookableDates(),
    });
}

/** Публичен изглед: само дали часът е свободен — без данни на пациенти. */
function apiAvailability(res, dateStr) {
    if (!parseDateStr(dateStr)) {
        return sendJson(res, 400, { error: 'Невалидна дата.' });
    }
    if (!bookableDates().includes(dateStr)) {
        return sendJson(res, 200, { date: dateStr, closed: true, slots: [] });
    }
    const taken = takenTimes(dateStr);
    sendJson(res, 200, {
        date: dateStr,
        closed: false,
        slots: ALL_TIMES.map(time => ({
            time,
            taken: taken.has(time),
            past: isPastSlot(dateStr, time),
        })),
    });
}

async function apiCreateBooking(req, res) {
    if (!rateLimit(`book:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
        return sendJson(res, 429, { error: 'Твърде много опити. Опитай отново след около час.' });
    }

    const body = await readBody(req);
    const date = str(body.date, 10);
    const time = str(body.time, 5);
    const name = str(body.name, 80);
    const phone = str(body.phone, 30);
    const email = str(body.email, 120);
    const service = str(body.service, 80);
    const note = str(body.note, 500);

    if (!parseDateStr(date) || !bookableDates().includes(date)) {
        return sendJson(res, 400, { error: 'Тази дата не е достъпна за резервация.' });
    }
    if (!ALL_TIMES.includes(time)) {
        return sendJson(res, 400, { error: 'Този час е извън работното време.' });
    }
    if (isPastSlot(date, time)) {
        return sendJson(res, 400, { error: 'Този час вече е минал. Избери друг.' });
    }
    if (name.length < 2) {
        return sendJson(res, 400, { error: 'Моля, попълни име и фамилия.' });
    }
    if (!/^[\d\s+()\-/]{6,30}$/.test(phone)) {
        return sendJson(res, 400, { error: 'Моля, въведи валиден телефонен номер.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(res, 400, { error: 'Моля, въведи валиден имейл адрес.' });
    }

    if (!SERVICE_NAMES.has(service)) {
        return sendJson(res, 400, { error: 'Моля, избери услуга от списъка.' });
    }

    // проверката "зает ли е" и записът стават в един сериализиран блок,
    // за да не може два едновременни заявки да вземат един и същ час
    const result = await withDb(async () => {
        if (takenTimes(date).has(time)) return { conflict: true };

        const booking = {
            id: crypto.randomUUID(),
            date,
            time,
            name,
            phone,
            email,
            service,
            note,
            status: 'new',
            createdAt: new Date().toISOString(),
        };
        db.bookings.push(booking);
        await persist();
        return { booking };
    });

    if (result.conflict) {
        return sendJson(res, 409, { error: 'За съжаление този час току-що беше зает. Избери друг.' });
    }

    console.log(`[резервация] ${result.booking.date} ${result.booking.time} — ${result.booking.name} (${result.booking.service})`);
    sendJson(res, 201, {
        ok: true,
        booking: {
            id: result.booking.id,
            date: result.booking.date,
            time: result.booking.time,
            service: result.booking.service,
        },
    });
}

/* --------------------------------------------------------- админ API -- */

async function apiAdminLogin(req, res) {
    if (!rateLimit(`login:${clientIp(req)}`, 8, 15 * 60 * 1000)) {
        return sendJson(res, 429, { error: 'Твърде много опити за вход. Изчакай 15 минути.' });
    }
    const body = await readBody(req);
    if (!passwordMatches(body.password)) {
        return sendJson(res, 401, { error: 'Грешна парола.' });
    }
    const token = createSession();
    const secure = process.env.COOKIE_SECURE === '1' ? ' Secure;' : '';
    sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `dc_session=${token}; HttpOnly; Path=/; SameSite=Strict;${secure} Max-Age=${SESSION_TTL_MS / 1000}`,
    });
}

function apiAdminLogout(req, res) {
    const token = readCookie(req, 'dc_session');
    if (token) sessions.delete(token);
    sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'dc_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
    });
}

function apiAdminList(req, res, url) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    let rows = db.bookings.slice();
    if (from && parseDateStr(from)) rows = rows.filter(b => b.date >= from);
    if (to && parseDateStr(to)) rows = rows.filter(b => b.date <= to);
    if (status && status !== 'all') rows = rows.filter(b => (b.status || 'new') === status);
    if (q) {
    rows = rows.filter(b =>
        (b.name || '').toLowerCase().includes(q) ||
        (b.phone || '').toLowerCase().includes(q) ||
        (b.email || '').toLowerCase().includes(q) ||
        (b.service || '').toLowerCase().includes(q));
    }

    rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const today = fmtDate(new Date());
   
    sendJson(res, 200, {
        bookings: rows,
        stats: {
            total: db.bookings.length,
            active: db.bookings.filter(isActive).length,
            today: db.bookings.filter(b => b.date === today && isActive(b)).length,
            upcoming: db.bookings.filter(b => b.date >= today && isActive(b)).length,
        },
    });
}

async function apiAdminUpdate(req, res, id) {
    const body = await readBody(req);
    const status = str(body.status, 20);

    if (!['new', 'confirmed', 'cancelled'].includes(status)) {
        return sendJson(res, 400, { error: 'Невалиден статус.' });
    }

    const result = await withDb(async () => {
        const booking = db.bookings.find(b => b.id === id);

        if (!booking) {
            return { missing: true };
        }

        const oldStatus = booking.status;
        booking.status = status;

        await persist();

        return { booking, oldStatus };
    });

    if (result.missing) {
        return sendJson(res, 404, { error: 'Резервацията не е намерена.' });
    }

    // Потвърждение
    if (status === 'confirmed' && result.oldStatus !== 'confirmed') {
        try {
            await sendEmail(
                result.booking.email,
                'Потвърдена резервация – Dental Clinic',
                `Здравейте, ${result.booking.name}!

Вашата резервация е потвърдена успешно.

ДЕТАЙЛИ ЗА ВАШИЯ ЧАС

---------------------

Дата: ${result.booking.date}

Час: ${result.booking.time}

Услуга: ${result.booking.service}

АДРЕС

---------------------

гр. Елхово, ул. Охрид 51

Ако желаете да промените или отмените своя час, моля, свържете се с кабинета.

Телефон: 0899 187 889

Д-р Веселинка Стефаниева

Дентален кабинет`
            );
        } catch (err) {
            console.error(
                '❌ Неуспешно изпращане на потвърждение:',
                err.message
            );
        }
    }

    // Отказ
    if (status === 'cancelled' && result.oldStatus !== 'cancelled') {
        try {
            await sendEmail(
                result.booking.email,
                'Отказана резервация – Dental Clinic',
                `Здравейте, ${result.booking.name}!

Уведомяваме Ви, че Вашата резервация е отказана.

ДЕТАЙЛИ ЗА РЕЗЕРВАЦИЯТА

------------------------

Дата: ${result.booking.date}

Час: ${result.booking.time}

Услуга: ${result.booking.service}

АДРЕС

---------------------

гр. Елхово, ул. Охрид 51

Ако желаете да запазите друг час, моля, свържете се с кабинета.

Телефон: 0899 187 889

Д-р Веселинка Стефаниева

Дентален кабинет`
            );
        } catch (err) {
            console.error(
                '❌ Неуспешно изпращане на отказ:',
                err.message
            );
        }
    }

    sendJson(res, 200, {
        ok: true,
        booking: result.booking
    });
}

async function apiAdminDelete(res, id) {
    const result = await withDb(async () => {
        const idx = db.bookings.findIndex(b => b.id === id);
        if (idx === -1) return { missing: true };
        const [removed] = db.bookings.splice(idx, 1);
        await persist();
        return { removed };
    });

    if (result.missing) return sendJson(res, 404, { error: 'Резервацията не е намерена.' });
    sendJson(res, 200, { ok: true });
}

function toCsv(rows) {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Дата', 'Час', 'Име', 'Телефон', 'Имейл', 'Услуга', 'Бележка', 'Статус', 'Създадена'];
    const lines = [head.map(esc).join(',')];
    for (const b of rows) {
        lines.push([b.date, b.time, b.name, b.phone, b.email, b.service, b.note, b.status, b.createdAt].map(esc).join(','));
    }
    // BOM, за да се отвори правилно кирилицата в Excel
    return '﻿' + lines.join('\r\n');
}

function apiAdminExport(res) {
    const rows = db.bookings.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const csv = toCsv(rows);
    res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rezervacii-${fmtDate(new Date())}.csv"`,
        'Cache-Control': 'no-store',
    });
    res.end(csv);
}

/* --------------------------------------------------------- рутиране -- */

async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendJson(res, 405, { error: 'Методът не е позволен' });
        }
        return serveStatic(req, res, pathname);
    }

    // --- публични ---
    if (pathname === '/api/config' && req.method === 'GET') return apiConfig(res);
    if (pathname === '/api/availability' && req.method === 'GET') {
        return apiAvailability(res, url.searchParams.get('date'));
    }
    if (pathname === '/api/bookings' && req.method === 'POST') return apiCreateBooking(req, res);

    // --- вход/изход за админ ---
    if (pathname === '/api/admin/login' && req.method === 'POST') return apiAdminLogin(req, res);
    if (pathname === '/api/admin/logout' && req.method === 'POST') return apiAdminLogout(req, res);
    if (pathname === '/api/admin/session' && req.method === 'GET') {
        return sendJson(res, 200, { authenticated: isAdmin(req) });
    }

    // --- всичко останало под /api/admin изисква вход ---
    if (pathname.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'Необходим е вход.' });

        if (pathname === '/api/admin/bookings' && req.method === 'GET') return apiAdminList(req, res, url);
        if (pathname === '/api/admin/export' && req.method === 'GET') return apiAdminExport(res);

        const match = pathname.match(/^\/api\/admin\/bookings\/([\w-]{1,64})$/);
        if (match) {
            if (req.method === 'PATCH') return apiAdminUpdate(req, res, match[1]);
            if (req.method === 'DELETE') return apiAdminDelete(res, match[1]);
        }
    }

    sendJson(res, 404, { error: 'Няма такъв ресурс' });
}

const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    route(req, res).catch(err => {
        const status = err.status || 500;
        if (status === 500) console.error('[грешка]', err);
        if (!res.headersSent) sendJson(res, status, { error: err.message || 'Вътрешна грешка на сървъра' });
        else res.end();
    });
});

/* ------------------------------------------------------------- старт -- */

(async () => {
    await loadDb();

    const isLocal = HOST === '127.0.0.1' || HOST === 'localhost';
    if (!process.env.ADMIN_PASSWORD && !isLocal) {
        console.error('\n  СПРЯНО: сървърът е достъпен отвън, но ADMIN_PASSWORD не е зададена.');
        console.error('  Задай парола преди да пуснеш сайта публично, напр.:');
        console.error('      $env:ADMIN_PASSWORD = "своя-силна-парола"; node server.js\n');
        process.exit(1);
    }

    
    server.listen(PORT, HOST, () => {
        console.log(`\n  ${CONFIG.clinicName}`);
        console.log(`  Сайт:        http://${HOST}:${PORT}/`);
        console.log(`  Админ панел: http://${HOST}:${PORT}/admin`);
        console.log(`  Резервации:  ${DB_FILE}`);
        console.log(`  Заредени:    ${db.bookings.length} резервации`);
        if (!process.env.ADMIN_PASSWORD) {
            console.log(`\n  [внимание] Използва се паролата по подразбиране: ${DEFAULT_ADMIN_PASSWORD}`);
            console.log(`  Смени я така:  $env:ADMIN_PASSWORD = "своя-парола"; node server.js`);
        }
        console.log('');
    });
})();
