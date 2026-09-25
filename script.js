
(function () {
    'use strict';

    /*
     * Резервационната форма говори със сървъра (server.js).
     * Работното време, услугите и броят дни напред идват от config.json през /api/config —
     * не се пипат тук.
     */

    const monthsBG = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
    const daysBG = ['нед', 'пон', 'вто', 'сря', 'чет', 'пет', 'съб'];

    const dateRow = document.getElementById('dateRow');
    const slotsGrid = document.getElementById('slotsGrid');
    const submitBtn = document.getElementById('submitBtn');
    const formMsg = document.getElementById('formMsg');
    const form = document.getElementById('bookingForm');
    const serviceSelect = document.getElementById('fservice');
    const newBookingBtn = document.getElementById('newBookingBtn');

    let selectedDate = null;   // "YYYY-MM-DD"
    let selectedTime = null;   // "HH:MM"
    let submitting = false;

    /* ------------------------------------------------------------ helpers -- */

    function showMsg(text, kind) {
        formMsg.className = 'form-msg ' + kind;
        formMsg.textContent = text;
        formMsg.style.display = 'block';
    }

    function clearMsg() {
        formMsg.className = 'form-msg';
        formMsg.style.display = 'none';
    }

    function showBookingForm() {
        form.hidden = false;
        newBookingBtn.hidden = true;
        clearMsg();
    }

    function showBookingSuccess(text) {
        form.hidden = true;
        formMsg.className = 'form-msg ok';
        formMsg.textContent = text;
        formMsg.style.display = 'block';

        newBookingBtn.hidden = false;
    }



    async function api(url, options) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        let data = null;
        try {
            data = await res.json();
        } catch {
            /* празно или невалидно тяло — обработва се по-долу */
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || 'Възникна грешка. Опитай отново.');
            err.status = res.status;
            throw err;
        }
        return data;
    }

    function labelForDate(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return { day: daysBG[dt.getDay()], num: `${dt.getDate()} ${monthsBG[dt.getMonth()]}` };
    }

    function setGridMessage(text) {
        slotsGrid.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'slots-empty';
        el.textContent = text;
        slotsGrid.appendChild(el);
    }

    async function loadNotice() {
    try {
        const cfg = await api('/api/config');
        const noticeBanner = document.getElementById('noticeBanner');

        if (!noticeBanner) return;

        const notice = cfg.notice;

        if (!notice || !notice.enabled) {
            noticeBanner.hidden = true;
            return;
        }

        function parseLocalDate(dateString) {
            const [year, month, day] = dateString.split('-').map(Number);
            return new Date(year, month - 1, day);
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const to = parseLocalDate(notice.to);
        to.setHours(23, 59, 59, 999);

        /*
         * Съобщението се показва от момента,
         * в който е включено (enabled: true),
         * до края на отпуска.
         */
        if (today <= to) {
            noticeBanner.innerHTML = `
            <span class="notice-icon">⚠️</span>
            <span>${notice.text.replace(/^⚠️\s*/, '')}</span>
            `;
            noticeBanner.hidden = false;
        } else {
            noticeBanner.hidden = true;
        }

    } catch (err) {
        console.error('Грешка при зареждане на съобщението:', err);
    }

    
    }


    /* ------------------------------------------------------------ рендер -- */

    function renderDates(dates) {
        dateRow.innerHTML = '';
        dates.forEach(dateStr => {
            const { day, num } = labelForDate(dateStr);
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'date-pill';
            pill.dataset.date = dateStr;
            pill.innerHTML = `<div class="d">${day}</div><div class="n">${num}</div>`;
            pill.addEventListener('click', () => selectDate(dateStr));
            dateRow.appendChild(pill);
        });
    }

    function renderServices(services) {
        serviceSelect.innerHTML = '<option value="">Избери услуга…</option>';
        services.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.name;
            opt.textContent = s.name;
            serviceSelect.appendChild(opt);
        });
    }

    function renderSlots(slots) {
        slotsGrid.innerHTML = '';

        const free = slots.filter(s => !s.taken && !s.past);
        if (free.length === 0) {
            setGridMessage('За този ден няма свободни часове. Виж следващ ден.');
            return;
        }

        slots.forEach(s => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'slot';
            el.textContent = s.time;

            if (s.taken) {
                el.classList.add('is-taken');
                el.disabled = true;
                el.title = 'Часът вече е зает';
                el.setAttribute('aria-label', `${s.time} — зает`);
            } else if (s.past) {
                el.classList.add('is-past');
                el.disabled = true;
                el.title = 'Часът е минал';
                el.setAttribute('aria-label', `${s.time} — минал`);
            } else {
                el.addEventListener('click', () => {
                    slotsGrid.querySelectorAll('.slot').forEach(x => x.classList.remove('selected'));
                    el.classList.add('selected');
                    selectedTime = s.time;
                    clearMsg();
                    updateSubmitState();
                });
            }
            slotsGrid.appendChild(el);
        });
    }

    function updateSubmitState() {
        if (submitting) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Запазване…';
        } else if (selectedDate && selectedTime) {
            submitBtn.disabled = false;
            submitBtn.textContent = `Запази ${selectedDate} в ${selectedTime}`;
        } else {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Избери дата и час';
        }
    }

    /* ------------------------------------------------------------ данни -- */

    async function loadSlots(dateStr) {
        setGridMessage('Зареждане…');
        try {
            const data = await api(`/api/availability?date=${encodeURIComponent(dateStr)}`);
            if (dateStr !== selectedDate) return;   // потребителят вече е сменил датата
            if (data.closed) {
                setGridMessage('Кабинетът е затворен на тази дата.');
                return;
            }
            renderSlots(data.slots);
        } catch (err) {
            if (dateStr !== selectedDate) return;
            setGridMessage('Часовете не можаха да се заредят. Провери връзката и опресни страницата.');
            console.error(err);
        }
    }

    function selectDate(dateStr) {
        selectedDate = dateStr;
        selectedTime = null;
        dateRow.querySelectorAll('.date-pill').forEach(p => {
            p.classList.toggle('active', p.dataset.date === dateStr);
        });
        clearMsg();
        updateSubmitState();
        loadSlots(dateStr);
    }

    async function init() {
        try {
            const cfg = await api('/api/config');
            renderServices(cfg.services);

            if (!cfg.dates.length) {
                setGridMessage('В момента няма отворени дати за резервация.');
                return;
            }
            renderDates(cfg.dates);
            selectDate(cfg.dates[0]);
        } catch (err) {
            console.error(err);
            setGridMessage('Няма връзка със сървъра. Увери се, че е стартиран (node server.js).');
            showMsg('Онлайн резервацията е временно недостъпна. Моля, обадете се на 0899 187 889.', 'err');
        }
    }

    /* ---------------------------------------------------------- изпращане -- */

    newBookingBtn.addEventListener('click', () => {
        showBookingForm();
        form.reset();
        selectedTime = null;
        updateSubmitState();
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (submitting) return;
        clearMsg();

        if (!selectedDate || !selectedTime) {
            showMsg('Моля, избери дата и час.', 'err');
            return;
        }

        const payload = {
            date: selectedDate,
            time: selectedTime,
            name: document.getElementById('fname').value.trim(),
            phone: document.getElementById('fphone').value.trim(),
            email: document.getElementById('femail').value.trim(),
            service: serviceSelect.value,
            note: document.getElementById('fnote').value.trim(),
        };

        if (!payload.name || !payload.phone || !payload.email || !payload.service) {
            showMsg('Моля, попълни име, телефон, имейл и услуга.', 'err');
            return;
        }

        submitting = true;
        updateSubmitState();

        try {
            const data = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
            showBookingSuccess(
                `Часът е запазен за ${data.booking.date} в ${data.booking.time}. Ще получите потвърждение на имейла си, след като завършите резервацията си.`
            );
            form.reset();
            selectedTime = null;
        } catch (err) {
            showMsg(err.message, 'err');
        } finally {
            submitting = false;
            // винаги презареждаме — при конфликт часът вече е зает от друг
            await loadSlots(selectedDate);
            updateSubmitState();
        }
    });

    init();
    loadNotice();
})();
