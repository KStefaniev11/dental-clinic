
(function () {
    'use strict';
    

    const loginScreen = document.getElementById('loginScreen');
    const loginForm = document.getElementById('loginForm');
    const loginMsg = document.getElementById('loginMsg');
    const loginBtn = document.getElementById('loginBtn');
    const panel = document.getElementById('panel');

    const statRow = document.getElementById('statRow');
    const rowsEl = document.getElementById('rows');
    const tableEmpty = document.getElementById('tableEmpty');

    const fFrom = document.getElementById('fFrom');
    const fTo = document.getElementById('fTo');
    const fStatus = document.getElementById('fStatus');
    const fSearch = document.getElementById('fSearch');

    const STATUS_LABEL = { new: 'Нова', confirmed: 'Потвърдена', cancelled: 'Отказана' };
    const monthsBG = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
    const daysBG = ['нед', 'пон', 'вто', 'сря', 'чет', 'пет', 'съб'];

    let refreshTimer = null;

    /* ------------------------------------------------------------ helpers -- */

    async function api(url, options) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        if (res.status === 401) {
            showLogin();
            throw new Error('Сесията е изтекла. Влез отново.');
        }
        let data = null;
        try {
            data = await res.json();
        } catch {
            /* без тяло */
        }
        if (!res.ok) throw new Error((data && data.error) || 'Възникна грешка.');
        return data;
    }

    function fmtDateLabel(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return `${daysBG[dt.getDay()]}, ${dt.getDate()} ${monthsBG[dt.getMonth()]}`;
    }

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /* -------------------------------------------------------------- изглед -- */

    function showLogin() {
        clearInterval(refreshTimer);
        refreshTimer = null;
        panel.hidden = true;
        loginScreen.hidden = false;
        document.getElementById('password').focus();
    }

    function showPanel() {
        loginScreen.hidden = true;
        panel.hidden = false;
        load();
        if (!refreshTimer) refreshTimer = setInterval(load, 30000);   // авто-обновяване
    }

    function renderStats(stats) {
        const cards = [
            { label: 'Днес', value: stats.today },
            { label: 'Предстоящи', value: stats.upcoming },
            { label: 'Активни', value: stats.active },
            { label: 'Общо', value: stats.total },
        ];
        statRow.innerHTML = '';
        cards.forEach(c => {
            const el = document.createElement('div');
            el.className = 'stat-card';
            el.innerHTML = `<span class="stat-label"></span><span class="stat-value"></span>`;
            el.querySelector('.stat-label').textContent = c.label;
            el.querySelector('.stat-value').textContent = c.value;
            statRow.appendChild(el);
        });
    }

    function cell(text, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = text || '—';
        return td;
    }

    function renderRows(bookings) {
        rowsEl.innerHTML = '';
        tableEmpty.hidden = bookings.length > 0;

        const today = todayStr();

        bookings.forEach(b => {
            const status = b.status || 'new';
            const tr = document.createElement('tr');
            tr.className = `status-${status}`;
            if (b.date === today && status !== 'cancelled') tr.classList.add('is-today');

            tr.appendChild(cell(fmtDateLabel(b.date)));
            tr.appendChild(cell(b.time, 'col-time'));
            tr.appendChild(cell(b.name, 'col-name'));

            const phoneTd = document.createElement('td');
            const link = document.createElement('a');
            link.href = `tel:${b.phone.replace(/\s/g, '')}`;
            link.textContent = b.phone;
            phoneTd.appendChild(link);
            tr.appendChild(phoneTd);
            tr.appendChild(cell(b.email, 'col-email'));

            tr.appendChild(cell(b.service));
            tr.appendChild(cell(b.note, 'col-note'));

            const statusTd = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = `badge badge-${status}`;
            badge.textContent = STATUS_LABEL[status] || status;
            statusTd.appendChild(badge);
            tr.appendChild(statusTd);

            const actionsTd = document.createElement('td');
            actionsTd.className = 'col-actions';

            if (status !== 'confirmed') {
                actionsTd.appendChild(actionBtn('Потвърди', () => setStatus(b.id, 'confirmed')));
            }
            if (status !== 'cancelled') {
                actionsTd.appendChild(actionBtn('Откажи', () => {
                    if (confirm(`Да откажа ли часа на ${b.name} за ${b.date} ${b.time}?\nЧасът ще се освободи за други пациенти.`)) {
                        setStatus(b.id, 'cancelled');
                    }
                }));
            } else {
                actionsTd.appendChild(actionBtn('Върни', () => setStatus(b.id, 'new')));
            }
            actionsTd.appendChild(actionBtn('Изтрий', () => {
                if (confirm(`Да изтрия ли окончателно резервацията на ${b.name}?`)) remove(b.id);
            }, 'danger'));

            tr.appendChild(actionsTd);
            rowsEl.appendChild(tr);
        });
    }

    function actionBtn(text, onClick, extra) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-btn' + (extra ? ' ' + extra : '');
        btn.textContent = text;
        btn.addEventListener('click', onClick);
        return btn;
    }

    /* --------------------------------------------------------------- данни -- */

    async function load() {
        const params = new URLSearchParams();
        if (fFrom.value) params.set('from', fFrom.value);
        if (fTo.value) params.set('to', fTo.value);
        if (fStatus.value !== 'all') params.set('status', fStatus.value);
        if (fSearch.value.trim()) params.set('q', fSearch.value.trim());

        try {
            const data = await api(`/api/admin/bookings?${params}`);
            renderStats(data.stats);
            renderRows(data.bookings);
        } catch (err) {
            console.error(err);
        }
    }

    async function setStatus(id, status) {
        try {
            await api(`/api/admin/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
            await load();
        } catch (err) {
            alert(err.message);
        }
    }

    async function remove(id) {
        try {
            await api(`/api/admin/bookings/${id}`, { method: 'DELETE' });
            await load();
        } catch (err) {
            alert(err.message);
        }
    }

    /* -------------------------------------------------------------- събития -- */

    loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        loginMsg.className = 'form-msg';
        loginMsg.style.display = 'none';
        loginBtn.disabled = true;

        try {
            await api('/api/admin/login', {
                method: 'POST',
                body: JSON.stringify({ password: document.getElementById('password').value }),
            });
            loginForm.reset();
            showPanel();
        
        } catch (err) {
            loginMsg.className = 'form-msg err';
            loginMsg.textContent = err.message;
            loginMsg.style.display = 'block';
        } finally {
            loginBtn.disabled = false;
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
        showLogin();
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
        fFrom.value = '';
        fTo.value = '';
        fStatus.value = 'all';
        fSearch.value = '';
        load();
    });

    [fFrom, fTo, fStatus].forEach(el => el.addEventListener('change', load));

    let searchTimer;
    fSearch.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(load, 250);
    });

    /* ---------------------------------------------------------------- старт -- */

    (async () => {
        try {
            const { authenticated } = await api('/api/admin/session');
            if (authenticated) showPanel();
            else showLogin();
        } catch {
            showLogin();
        }
    })();
})();
