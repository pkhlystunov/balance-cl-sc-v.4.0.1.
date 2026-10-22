// Ядро ситуационного центра ОТиПБ v12.
// Адрес backend (Yandex Cloud Functions).
// ВАЖНО: путь к API передаётся через query-параметр ?path=, т.к. Cloud Functions
// не передаёт путь после ID функции (см. server/index.js — event.queryStringParameters.path).
const FUNCTION_URL = "https://functions.yandexcloud.net/d4elvbg35d2cp08omcrr";
function apiPath(path) {
    return FUNCTION_URL + "?path=" + encodeURIComponent("/api/" + path);
}

let rawData = [];
let shortObjectsMap = {}; // Карта сопоставления: "Полное имя" -> "Короткий ID (Колонка А)"

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
    document.querySelectorAll('.tab-btn').forEach(function(el) { el.classList.remove('active'); });
    
    document.getElementById(tabId).classList.add('active');
    if (tabId === 'registry-tab') {
        document.getElementById('btn-registry').classList.add('active');
    } else {
        document.getElementById('btn-analytics').classList.add('active');
    }
    applyFilters(); 
}

async function loadData() {
    const statusText = document.getElementById('sync-status');
    try {
        // Шаг 1: Сначала подтягиваем справочник объектов, чтобы узнать короткие имена
        const setupResponse = await fetch(apiPath("setup"), { method: "GET", redirect: "follow" });
        const setupRes = await setupResponse.json();
        
        if (setupRes && setupRes.success) {
            // Очищаем карту перед заполнением
            shortObjectsMap = {};
            setupRes.objects.forEach(function(obj) {
                // Запоминаем: связку name (полное название) -> id (короткое имя)
                shortObjectsMap[obj.name] = obj.id;
            });
        }

        // Шаг 2: Скачиваем реестр проверок инспекторов
        const response = await fetch(apiPath("audits"), { method: "GET", redirect: "follow" });
        const res = await response.json();
        
        if (res && res.success) {
            rawData = res.data;
            buildFilterOptions();
            applyFilters();
            statusText.textContent = "● Оперативный центр подключен к облаку";
            statusText.style.color = "#27ae60";
        }
    } catch (e) {
        console.error(e);
        statusText.textContent = "❌ Ошибка синхронизации шлюза";
        statusText.style.color = "red";
    }
}

function buildFilterOptions() {
    const objSelect = document.getElementById('f-object');
    const contrSelect = document.getElementById('f-contractor');
    
    objSelect.innerHTML = '<option value="Все">-- Все объекты --</option>';
    contrSelect.innerHTML = '<option value="Все">-- Все подрядчики --</option>';

    const objects = new Set();
    const contractors = new Set();
    
    rawData.forEach(function(r) {
        if(r.object) objects.add(r.object);
        if(r.contractor) contractors.add(r.contractor);
    });

    objects.forEach(function(o) { objSelect.add(new Option(o, o)); });
    contractors.forEach(function(c) { contrSelect.add(new Option(c, c)); });
}

function applyFilters() {
    const objF = document.getElementById('f-object').value;
    const contrF = document.getElementById('f-contractor').value;
    const startF = document.getElementById('f-start').value;
    const endF = document.getElementById('f-end').value;
    const statusF = document.getElementById('f-status').value;

    const start = startF ? new Date(startF) : null;
    const end = endF ? new Date(endF) : null;

    const filtered = rawData.filter(function(r) {
        if (!r.date) return false;
        const rDate = new Date(r.date);
        
        if (objF !== "Все" && r.object !== objF) return false;
        if (contrF !== "Все" && r.contractor !== contrF) return false;
        if (start && rDate < start) return false;
        if (end && rDate > end) return false;
        if (statusF === "Открыто" && r.isClosed) return false;
        if (statusF === "Закрыто" && !r.isClosed) return false;
        return true;
    });

    renderRegistry(filtered);
    renderDoubleCharts(filtered);
}

function renderRegistry(data) {
    const tbody = document.getElementById('registry-tbody');
    tbody.innerHTML = "";

    if (data.length === 0) {
        tbody.innerHTML = "<tr><td colspan='6' style='text-align:center; padding:20px;'>По заданным фильтрам проверок не найдено</td></tr>";
        return;
    }

    const copyData = data.slice();
    copyData.forEach(function(r) {
        const tr = document.createElement('tr');
        let formattedDate = "Акт";
        try { if(r.date) formattedDate = new Date(r.date).toLocaleDateString('ru-RU'); } catch(e) {}

        const isClosed = !!r.isClosed;
        const statusHtml = isClosed
            ? "<span style='color:#27ae60; font-weight:bold;'>✅ Закрыто</span>"
            : "<span style='color:#e74c3c; font-weight:bold;'>🔴 Открыто</span>";

        const actionHtml = isClosed
            ? "<button onclick='reopenAudit(\"" + r.id + "\")' style='padding:6px 10px; border:none; background:#f39c12; color:#fff; font-weight:bold; border-radius:4px; cursor:pointer; font-size:12px;'>↩️ Открыть</button>"
            : "<button onclick='closeAudit(\"" + r.id + "\")' style='padding:6px 10px; border:none; background:#27ae60; color:#fff; font-weight:bold; border-radius:4px; cursor:pointer; font-size:12px;'>✅ Закрыть</button>";

        const delBtn = "<button onclick='deleteAudit(\"" + r.id + "\")' style='padding:6px 10px; border:none; background:#e74c3c; color:#fff; font-weight:bold; border-radius:4px; cursor:pointer; font-size:12px; margin-left:4px;'>🗑️ Удалить</button>";

        tr.innerHTML = "<td>" + formattedDate + "</td>" +
                       "<td><b>" + r.object + "</b></td>" +
                       "<td>" + r.contractor + "</td>" +
                       "<td style='white-space: pre-wrap; font-size:13px; line-height:1.4; color:#2c3e50;'>" + (r.text || "Нарушений не выявлено") + "</td>" +
                       "<td style='text-align:center;'>" + statusHtml + "</td>" +
                       "<td style='text-align:center;'>" + actionHtml + delBtn + "</td>";
        tbody.appendChild(tr);
    });
}

// Закрытие предписания (только админка)
async function closeAudit(id) {
    if (!confirm("Закрыть предписание?")) return;
    try {
        const response = await fetch(apiPath("audits/" + id + "/close"), {
            method: "POST",
            // Без Content-Type: application/json — «простой» запрос (обход preflight CORS).
            redirect: "follow"
        });
        const res = await response.json();
        if (res.success) {
            alert("Предписание закрыто ✅");
            loadData();
        } else {
            alert("Ошибка: " + (res.error || "неизвестная"));
        }
    } catch (e) {
        console.error(e);
        alert("Ошибка сети при закрытии предписания");
    }
}

// Открытие предписания обратно (только админка)
async function reopenAudit(id) {
    if (!confirm("Открыть предписание обратно?")) return;
    try {
        const response = await fetch(apiPath("audits/" + id + "/reopen"), {
            method: "POST",
            // Без Content-Type: application/json — «простой» запрос (обход preflight CORS).
            redirect: "follow"
        });
        const res = await response.json();
        if (res.success) {
            alert("Предписание открыто ↩️");
            loadData();
        } else {
            alert("Ошибка: " + (res.error || "неизвестная"));
        }
    } catch (e) {
        console.error(e);
        alert("Ошибка сети при открытии предписания");
    }
}

// Удаление предписания (только админка)
async function deleteAudit(id) {
    if (!confirm("Удалить предписание навсегда? Это действие необратимо.")) return;
    try {
        // DELETE заменён на POST ?method=DELETE — «простой» запрос без preflight OPTIONS
        // (Yandex Cloud Functions не передаёт OPTIONS в код функции, CORS на платформе выключен).
        const response = await fetch(apiPath("audits/" + id) + "&method=DELETE", {
            method: "POST",
            redirect: "follow"
        });
        const res = await response.json();
        if (res.success) {
            alert("Предписание удалено 🗑️");
            loadData();
        } else {
            alert("Ошибка: " + (res.error || "неизвестная"));
        }
    } catch (e) {
        console.error(e);
        alert("Ошибка сети при удалении предписания");
    }
}

// Кнопка «Обновить» — перезагрузка реестра и аналитики
async function refreshData() {
    const btn = document.getElementById('btn-refresh');
    const statusText = document.getElementById('sync-status');
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Обновление..."; }
    statusText.textContent = "⏳ Синхронизация...";
    statusText.style.color = "#d35400";
    await loadData();
    if (btn) { btn.disabled = false; btn.textContent = "🔄 Обновить"; }
}

// СБОР СТАТИСТИКИ И ОТРИСОВКА ГИСТОГРАММ
function renderDoubleCharts(data) {
    let totalViolations = 0;
    let totalClosed = 0;
    
    const objectsMap = {};     // Карта для Объектов
    const contractorsMap = {}; // Карта для Подрядчиков
    const closedObjectsMap = {};     // Карта закрытых по Объектам
    const closedContractorsMap = {}; // Карта закрытых по Подрядчикам

    data.forEach(function(r) {
        totalViolations += r.vCount;
        if (r.isClosed) totalClosed++;

        // Вычисляем короткое имя объекта из справочника (Колонка А), если не нашли - пишем "Акт"
        let shortPrefix = shortObjectsMap[r.object] || "Акт";
        let uniqueContractorKey = "[" + shortPrefix + "] " + r.contractor;

        if (r.vCount > 0) {
            // Считаем дефекты по Объектам
            if (!objectsMap[r.object]) objectsMap[r.object] = 0;
            objectsMap[r.object] += r.vCount;

            // Уникальный ключ для группировки: "[Короткий_Объект] Название Подрядчика"
            if (!contractorsMap[uniqueContractorKey]) contractorsMap[uniqueContractorKey] = 0;
            contractorsMap[uniqueContractorKey] += r.vCount;
        }

        // Считаем закрытые предписания по Объектам и Подрядчикам
        if (r.isClosed) {
            if (!closedObjectsMap[r.object]) closedObjectsMap[r.object] = 0;
            closedObjectsMap[r.object]++;

            if (!closedContractorsMap[uniqueContractorKey]) closedContractorsMap[uniqueContractorKey] = 0;
            closedContractorsMap[uniqueContractorKey]++;
        }
    });

    document.getElementById('w-checks').textContent = data.length;
    document.getElementById('w-violations').textContent = totalViolations;
    document.getElementById('w-closed').textContent = totalClosed;

    // --- ОТРИСОВКА ГИСТОГРАММЫ №1: ОБЪЕКТЫ ---
    const objChartBody = document.getElementById('objects-chart-body');
    objChartBody.innerHTML = "";
    
    const sortedObjects = Object.keys(objectsMap).map(function(name) {
        return { name: name, count: objectsMap[name] };
    }).sort(function(a, b) { return b.count - a.count; });

    if (sortedObjects.length === 0) {
        objChartBody.innerHTML = "<div style='text-align:center; color:#27ae60; font-weight:bold; padding:15px;'>Нарушений на объектах не зафиксировано!</div>";
    } else {
        let maxObjCount = 0;
        sortedObjects.forEach(function(item) { if(item.count > maxObjCount) maxObjCount = item.count; });
        
        sortedObjects.forEach(function(item) {
            // ИСПРАВЛЕНО: Используем короткое имя из карты, если оно есть
            let displayName = shortObjectsMap[item.name] || item.name;
            
            const percent = maxObjCount > 0 ? (item.count / maxObjCount) * 100 : 0;
            const row = document.createElement('div');
            row.className = "chart-row";
            row.innerHTML = '<div class="chart-label" title="' + item.name + '">' + displayName + '</div>' +
                            '<div class="chart-bar-wrapper">' +
                                '<div class="chart-bar-fill" style="width: ' + percent + '%; background:#3498db;"></div>' +
                            '</div>' +
                            '<div class="chart-value">' + item.count + ' шт.</div>';
            objChartBody.appendChild(row);
        });
    }

    // --- ОТРИСОВКА ГИСТОГРАММЫ №2: ПОДРЯДЧИКИ [ОБЪЕКТ | ПОДРЯДЧИК] ---
    const contrChartBody = document.getElementById('contractors-chart-body');
    contrChartBody.innerHTML = "";

    const sortedContractors = Object.keys(contractorsMap).map(function(key) {
        return { label: key, count: contractorsMap[key] };
    }).sort(function(a, b) { return b.count - a.count; });

    if (sortedContractors.length === 0) {
        contrChartBody.innerHTML = "<div style='text-align:center; color:#27ae60; font-weight:bold; padding:15px;'>Нарушений подрядных организаций не зафиксировано!</div>";
    } else {
        let maxContrCount = 0;
        sortedContractors.forEach(function(item) { if(item.count > maxContrCount) maxContrCount = item.count; });
        
        sortedContractors.forEach(function(item) {
            const percent = maxContrCount > 0 ? (item.count / maxContrCount) * 100 : 0;
            const row = document.createElement('div');
            row.className = "chart-row";
            row.innerHTML = '<div class="chart-label" title="' + item.label + '">' + item.label + '</div>' +
                            '<div class="chart-bar-wrapper">' +
                                '<div class="chart-bar-fill" style="width: ' + percent + '%; background:#e74c3c;"></div>' +
                            '</div>' +
                            '<div class="chart-value">' + item.count + ' шт.</div>';
            contrChartBody.appendChild(row);
        });
    }

    // --- ОТРИСОВКА ГИСТОГРАММЫ №3: ЗАКРЫТЫЕ ПРЕДПИСАНИЯ ПО ОБЪЕКТАМ ---
    const closedObjChartBody = document.getElementById('closed-objects-chart-body');
    closedObjChartBody.innerHTML = "";

    const sortedClosedObjects = Object.keys(closedObjectsMap).map(function(name) {
        return { name: name, count: closedObjectsMap[name] };
    }).sort(function(a, b) { return b.count - a.count; });

    if (sortedClosedObjects.length === 0) {
        closedObjChartBody.innerHTML = "<div style='text-align:center; color:#27ae60; font-weight:bold; padding:15px;'>Закрытых предписаний по объектам нет</div>";
    } else {
        let maxClosedObjCount = 0;
        sortedClosedObjects.forEach(function(item) { if(item.count > maxClosedObjCount) maxClosedObjCount = item.count; });

        sortedClosedObjects.forEach(function(item) {
            // ИСПРАВЛЕНО: Используем короткое имя из карты, если оно есть
            let displayName = shortObjectsMap[item.name] || item.name;

            const percent = maxClosedObjCount > 0 ? (item.count / maxClosedObjCount) * 100 : 0;
            const row = document.createElement('div');
            row.className = "chart-row";
            row.innerHTML = '<div class="chart-label" title="' + item.name + '">' + displayName + '</div>' +
                            '<div class="chart-bar-wrapper">' +
                                '<div class="chart-bar-fill" style="width: ' + percent + '%; background:#2ecc71;"></div>' +
                            '</div>' +
                            '<div class="chart-value">' + item.count + ' шт.</div>';
            closedObjChartBody.appendChild(row);
        });
    }

    // --- ОТРИСОВКА ГИСТОГРАММЫ №4: ЗАКРЫТЫЕ ПРЕДПИСАНИЯ ПО ПОДРЯДЧИКАМ [ОБЪЕКТ | ПОДРЯДЧИК] ---
    const closedContrChartBody = document.getElementById('closed-contractors-chart-body');
    closedContrChartBody.innerHTML = "";

    const sortedClosedContractors = Object.keys(closedContractorsMap).map(function(key) {
        return { label: key, count: closedContractorsMap[key] };
    }).sort(function(a, b) { return b.count - a.count; });

    if (sortedClosedContractors.length === 0) {
        closedContrChartBody.innerHTML = "<div style='text-align:center; color:#27ae60; font-weight:bold; padding:15px;'>Закрытых предписаний по подрядчикам нет</div>";
    } else {
        let maxClosedContrCount = 0;
        sortedClosedContractors.forEach(function(item) { if(item.count > maxClosedContrCount) maxClosedContrCount = item.count; });

        sortedClosedContractors.forEach(function(item) {
            const percent = maxClosedContrCount > 0 ? (item.count / maxClosedContrCount) * 100 : 0;
            const row = document.createElement('div');
            row.className = "chart-row";
            row.innerHTML = '<div class="chart-label" title="' + item.label + '">' + item.label + '</div>' +
                            '<div class="chart-bar-wrapper">' +
                                '<div class="chart-bar-fill" style="width: ' + percent + '%; background:#2ecc71;"></div>' +
                            '</div>' +
                            '<div class="chart-value">' + item.count + ' шт.</div>';
            closedContrChartBody.appendChild(row);
        });
    }
}

window.onload = loadData;
