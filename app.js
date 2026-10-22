// Адрес backend (Yandex Cloud Functions).
// ВАЖНО: путь к API передаётся через query-параметр ?path=, т.к. Cloud Functions
// не передаёт путь после ID функции (см. server/index.js — event.queryStringParameters.path).
const FUNCTION_URL = "https://functions.yandexcloud.net/d4elvbg35d2cp08omcrr";
function apiPath(path) {
  return FUNCTION_URL + "?path=" + encodeURIComponent("/api/" + path);
}

// Генерация UUID v4 (колонка audits.id в БД имеет тип UUID)
function generateUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Формирует payload для отправки в реестр БЕЗ фотографий (base64).
// Фото в реестре не сохраняются — они нужны только для печати PDF-акта
// на устройстве. Большой объём base64 переполнял лимит/таймаут запроса
// Cloud Functions, из-за чего акт не уходил в реестр и оставался в буфере.
function buildAuditPayload(session) {
  return Object.assign({}, session, {
    results: (session.results || []).map(function (r) {
      const copy = Object.assign({}, r);
      delete copy.photos;
      return copy;
    }),
  });
}

let auditSession = {
  inspector: "",
  objectId: "", // <-- ДОБАВЛЕНО: поле для короткого ID объекта
  objectName: "",
  contractor: "",
  results: [],
};

// Универсальный fetch с таймаутом: если ответ не пришёл за timeoutMs,
// запрос прерывается (AbortController) и выбрасывается ошибка.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs || 12000);
  try {
    return await fetch(
      url,
      Object.assign({}, options, { signal: controller.signal }),
    );
  } finally {
    clearTimeout(timer);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then(function () {
    console.log("Офлайн PWA активен");
  });
}

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
// Мобильные браузеры приостанавливают таймеры в фоне — при возврате
// в приложение (visibilitychange) сразу проверяем буфер.
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && navigator.onLine) {
    syncOfflineQueue();
  }
});

// Периодическая синхронизация буфера: событие online на мобильных
// браузерах срабатывает ненадёжно, поэтому дополнительно проверяем
// буфер каждые 30 секунд, пока приложение открыто.
const SYNC_INTERVAL_MS = 30000;
let syncTimer = null;
function startPeriodicSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(function () {
    if (navigator.onLine) {
      syncOfflineQueue();
    }
  }, SYNC_INTERVAL_MS);
}

function updateNetworkStatus() {
  const indicator = document.getElementById("net-indicator");
  if (navigator.onLine) {
    indicator.textContent = "🌐 Режим: Онлайн (Данные пишутся в облако)";
    indicator.className = "network-status online-mode";
    syncOfflineQueue();
  } else {
    indicator.textContent = "⚠️ Режим: Офлайн (Данные сохраняются на телефон)";
    indicator.className = "network-status offline-mode";
  }
}

async function loadSetupData() {
  try {
    // Таймаут 15 сек: если сервер (или «спящий» Supabase) отвечает медленно,
    // не держим приложение в бесконечной загрузке — уходим в fallback на кеш.
    const response = await fetchWithTimeout(apiPath("setup"), {
      method: "GET",
      redirect: "follow",
    }, 15000);
    const res = await response.json();
    if (res.success) {
      localStorage.setItem("cached_setup", JSON.stringify(res));
      populateSelects(res);
    } else {
      // Сервер ответил ошибкой — используем ранее загруженные данные
      const cached = localStorage.getItem("cached_setup");
      if (cached) populateSelects(JSON.parse(cached));
    }
  } catch (e) {
    // Сеть недоступна — используем ранее загруженные данные
    const cached = localStorage.getItem("cached_setup");
    if (cached) populateSelects(JSON.parse(cached));
  }
}

// Кнопка «Обновить» — перезагрузка справочников и чек-листа.
// При длительном нажатии (или при изменении версии приложения) сбрасывает
// кеш старой версии, чтобы загрузить актуальные файлы.
let refreshForceMode = false;

async function refreshData(force) {
  const btn = document.getElementById("refresh-btn");
  let hard = force === true || refreshForceMode;
  refreshForceMode = false;

  if (hard) {
    // Принудительный сброс кеша: очищаем кеши service worker и перезагружаем страницу.
    // Каждая операция ограничена по времени (2 сек), чтобы сброс всегда завершался,
    // даже если браузер завис на caches.keys()/delete.
    try {
      const withTimeout = function (p, ms, fallback) {
        return Promise.race([
          p,
          new Promise(function (resolve) {
            setTimeout(function () { resolve(fallback); }, ms || 2000);
          }),
        ]);
      };
      await withTimeout(
        Promise.resolve()
          .then(function () {
            if (window.caches && caches.keys) {
              return caches.keys().then(function (keys) {
                return Promise.all(
                  keys.map(function (k) { return caches.delete(k); }),
                );
              });
            }
            return null;
          }),
        2000,
      );
      await withTimeout(
        Promise.resolve()
          .then(function () {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              return navigator.serviceWorker
                .getRegistrations()
                .then(function (regs) {
                  return Promise.all(
                    regs.map(function (r) { return r.unregister(); }),
                  );
                });
            }
            return null;
          }),
        2000,
      );
    } catch (e) {
      console.error("Ошибка при сбросе кеша:", e);
    }
    location.reload();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Обновление...";
  }
  await loadSetupData();
  const step3 = document.getElementById("step-3-checklist");
  if (step3 && step3.style.display !== "none") {
    try {
      // Таймаут 15 сек: не даём «Обновлению» висеть бесконечно при медленном сервере.
      const response = await fetchWithTimeout(apiPath("checklist"), {
        method: "GET",
        redirect: "follow",
      }, 15000);
      const result = await response.json();
      if (result.success) {
        localStorage.setItem("cached_checklist", JSON.stringify(result.data));
        renderGroupedChecklist(result.data);
      } else {
        // Сервер ответил ошибкой — используем ранее загруженные вопросы
        const cachedQuestions = localStorage.getItem("cached_checklist");
        if (cachedQuestions) renderGroupedChecklist(JSON.parse(cachedQuestions));
      }
    } catch (e) {
      const cachedQuestions = localStorage.getItem("cached_checklist");
      if (cachedQuestions) renderGroupedChecklist(JSON.parse(cachedQuestions));
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "🔄 Обновить";
  }
}

// Долгое нажатие на кнопку «Обновить» включает режим принудительного сброса кеша
function setupRefreshLongPress() {
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;
  let longPressTimer = null;
  btn.addEventListener("pointerdown", function () {
    longPressTimer = setTimeout(function () {
      refreshForceMode = true;
      btn.textContent = "♻️ Сброс кеша...";
    }, 800);
  });
  btn.addEventListener("pointerup", function () {
    clearTimeout(longPressTimer);
  });
  btn.addEventListener("pointerleave", function () {
    clearTimeout(longPressTimer);
  });
}

document.addEventListener("DOMContentLoaded", async function () {
  // Перенос старый буфер из localStorage в IndexedDB (если он был)
  await migrateLegacyOfflineQueue();
  updateNetworkStatus();
  // Проверяем буфер при старте приложения (вдруг сеть уже есть)
  if (navigator.onLine) {
    syncOfflineQueue();
  }
  startPeriodicSync();
  setupRefreshLongPress();
  await loadSetupData();
});

function populateSelects(res) {
  const objectSelect = document.getElementById("object-select");
  const contractorSelect = document.getElementById("contractor-select");

  objectSelect.innerHTML = '<option value="">-- Выберите объект --</option>';
  contractorSelect.innerHTML =
    '<option value="">-- Выберите подрядчика --</option>';

  res.objects.forEach(function (obj) {
    // ИСПРАВЛЕНО: value теперь содержит obj.id (короткое имя/код), 
    // а отображаемый текст остается полным (obj.id + " | " + obj.name)
    objectSelect.add(new Option(obj.id + " | " + obj.name, obj.id));
  });
  
  res.contractors.forEach(function (contr) {
    contractorSelect.add(new Option(contr, contr));
  });

  document.getElementById("setup-loading").style.display = "none";
  document.getElementById("form-fields-wrapper").style.display = "block";
}

function toggleNewContractor() {
  const wrapper = document.getElementById("new-contractor-wrapper");
  wrapper.style.display = wrapper.style.display === "none" ? "block" : "none";
}

async function addNewContractor() {
  const input = document.getElementById("new-contractor-input");
  const name = input.value.trim();
  if (!name) return alert("Введите название подрядчика!");
  try {
    const response = await fetch(apiPath("contractors"), {
      method: "POST",
      // Без Content-Type: application/json — это «простой» запрос,
      // браузер не шлёт preflight OPTIONS (обход CORS на стороне YC).
      redirect: "follow",
      body: JSON.stringify({ name: name }),
    });
    const res = await response.json();
    if (res.success) {
      input.value = "";
      document.getElementById("new-contractor-wrapper").style.display = "none";
      alert("Подрядчик добавлен: " + name);
      // Обновляем справочники, чтобы новый подрядчик появился в списке
      loadSetupData();
    } else {
      alert("Ошибка: " + (res.error || "неизвестная"));
    }
  } catch (e) {
    console.error(e);
    alert("Ошибка сети при добавлении подрядчика");
  }
}

async function startFullAudit() {
  const insp = document.getElementById("inspector").value.trim();
  const objSelect = document.getElementById("object-select");
  const objValue = objSelect.value; // Это теперь obj.id (короткое имя)
  const objText = objSelect.options[objSelect.selectedIndex].text; // Полное отображение
  
  const contr = document.getElementById("contractor-select").value;
  
  if (!insp || !objValue || !contr) return alert("Заполните форму первого шага!");

  auditSession.inspector = insp;
  auditSession.objectId = objValue; // <-- СОХРАНЯЕМ КОРОТКИЙ ID
  auditSession.objectName = objText; // Сохраняем полное имя для отображения в PDF
  auditSession.contractor = contr;
  auditSession.results = [];
  
  document.getElementById("pdf-btn").disabled = true;
  document.getElementById("submit-btn").disabled = false;

  const container = document.getElementById("questions-container");
  container.innerHTML = "⏳ Загрузка вопросов чек-листа...";
  document.getElementById("step-3-checklist").style.display = "block";
  document.getElementById("step-1-form").style.display = "none";

  document.getElementById("audit-meta-insp").textContent = insp;
  document.getElementById("audit-meta-obj").textContent = objText; // Показываем полное имя
  document.getElementById("audit-meta-contr").textContent = contr;
  document.getElementById("audit-meta-date").textContent =
    new Date().toLocaleDateString("ru-RU");

  try {
    // Таймаут 15 сек: при медленном сервере не держим экран
    // «⏳ Загрузка вопросов чек-листа...» бесконечно — уходим в fallback на кеш.
    const response = await fetchWithTimeout(apiPath("checklist"), {
      method: "GET",
      redirect: "follow",
    }, 15000);
    const result = await response.json();
    if (result.success) {
      localStorage.setItem("cached_checklist", JSON.stringify(result.data));
      renderGroupedChecklist(result.data);
    } else {
      // Сервер ответил ошибкой — используем ранее загруженные вопросы
      const cachedQuestions = localStorage.getItem("cached_checklist");
      if (cachedQuestions) {
        renderGroupedChecklist(JSON.parse(cachedQuestions));
      } else {
        container.innerHTML = "⚠️ Нет сети и нет сохранённых вопросов. Подключитесь к интернету и нажмите «Обновить».";
      }
    }
  } catch (e) {
    // Сеть недоступна — используем ранее загруженные вопросы
    const cachedQuestions = localStorage.getItem("cached_checklist");
    if (cachedQuestions) {
      renderGroupedChecklist(JSON.parse(cachedQuestions));
    } else {
      container.innerHTML = "⚠️ Нет сети и нет сохранённых вопросов. Подключитесь к интернету и нажмите «Обновить».";
    }
  }
}

function renderGroupedChecklist(data) {
  const container = document.getElementById("questions-container");
  container.innerHTML = "";

  const categoriesMap = {};
  data.forEach(function (q) {
    const blockName = q.category ? q.category : "Общий раздел";
    if (!categoriesMap[blockName]) categoriesMap[blockName] = [];
    categoriesMap[blockName].push(q);
  });

  let catIndex = 0;
  for (let catName in categoriesMap) {
    catIndex++;
    const questionsList = categoriesMap[catName];

    const blockDiv = document.createElement("div");
    blockDiv.className = "category-block";
    const headerDiv = document.createElement("div");
    headerDiv.className = "category-header";
    headerDiv.id = "cat-header-" + catIndex;
    headerDiv.innerHTML =
      "<span>" +
      catIndex +
      ". " +
      catName +
      "</span><span class='category-counter'>Вопросов: " +
      questionsList.length +
      "</span>";

    const contentDiv = document.createElement("div");
    contentDiv.className = "category-content";
    contentDiv.id = "cat-content-" + catIndex;

    (function (cId) {
      headerDiv.addEventListener("click", function () {
        const content = document.getElementById("cat-content-" + cId);
        content.style.display =
          content.style.display === "block" ? "none" : "block";
      });
    })(catIndex);

    questionsList.forEach(function (q) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = "q-box-" + q.id;

      const qTxt = document.createElement("p");
      qTxt.style.margin = "5px 0 12px 0";
      qTxt.style.fontSize = "16px";
      qTxt.style.fontWeight = "600";
      qTxt.textContent = q.question;
      card.appendChild(qTxt);

      if (q.normative) {
        const normDiv = document.createElement("div");
        normDiv.className = "normative-text";
        normDiv.innerHTML = "<b>Норматив:</b> ";
        const normSpan = document.createElement("span");
        normSpan.textContent = q.normative;
        normDiv.appendChild(normSpan);
        card.appendChild(normDiv);
      }

      const btnRow = document.createElement("div");
      btnRow.className = "btn-row";

      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "btn btn-success";
      okBtn.textContent = "Соответствует";
      okBtn.addEventListener("click", function () {
        setResult(q.id, "Соответствует", q.question, catName, q.normative);
      });

      const failBtn = document.createElement("button");
      failBtn.type = "button";
      failBtn.className = "btn btn-danger";
      failBtn.textContent = "Нарушение";
      failBtn.addEventListener("click", function () {
        setResult(q.id, "Нарушение", q.question, catName, q.normative);
      });

      btnRow.appendChild(okBtn);
      btnRow.appendChild(failBtn);
      card.appendChild(btnRow);

      const commentInp = document.createElement("input");
      commentInp.type = "text";
      commentInp.id = "comment-" + q.id;
      commentInp.className = "comment-box";
      commentInp.placeholder = "Опишите детали нарушения...";
      card.appendChild(commentInp);

      const dateInp = document.createElement("input");
      dateInp.type = "date";
      dateInp.id = "date-limit-" + q.id;
      dateInp.className = "comment-box";
      dateInp.style.marginTop = "8px";
      dateInp.style.display = "none";
      card.appendChild(dateInp);

      const photoContainer = document.createElement("div");
      photoContainer.className = "photo-input-container";
      photoContainer.id = "photo-area-" + q.id;
      photoContainer.style.display = "none";
      photoContainer.innerHTML =
        '<label style="margin-top:5px; font-size:13px; color:#555;">Прикрепить фото нарушения (до 4-х штук):</label>' +
        '<input type="file" id="file-' +
        q.id +
        '" accept="image/*" multiple style="font-size:13px;" onchange="handlePhotoUpload(this, ' +
        q.id +
        ')">' +
        '<div class="photo-preview-grid" id="preview-' +
        q.id +
        '"></div>';
      card.appendChild(photoContainer);
      contentDiv.appendChild(card);
    });
    blockDiv.appendChild(headerDiv);
    blockDiv.appendChild(contentDiv);
    container.appendChild(blockDiv);
  }
}

function handlePhotoUpload(input, questionId) {
  const previewGrid = document.getElementById("preview-" + questionId);
  previewGrid.innerHTML = "";
  let item = auditSession.results.find(function (r) {
    return r.id === questionId;
  });
  if (!item) return;
  item.photos = [];

  const files = Array.from(input.files).slice(0, 4);
  files.forEach(function (file) {
    const reader = new FileReader();
    reader.onload = function (event) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement("canvas");
        const MAX_WIDTH = 800;
        let width = img.width;
        let height = img.height;
        if (width > MAX_WIDTH) {
          height *= MAX_WIDTH / width;
          width = MAX_WIDTH;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const compressedBase64 = canvas.toDataURL("image/jpeg", 0.85);
        item.photos.push(compressedBase64);

        const prevImg = document.createElement("img");
        prevImg.className = "photo-preview-item";
        prevImg.src = compressedBase64;
        previewGrid.appendChild(prevImg);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}
function setResult(id, status, question, category, normative) {
  let item = auditSession.results.find(function (r) {
    return r.id === id;
  });
  if (!item) {
    item = {
      id: id,
      question: question,
      category: category,
      normative: normative,
      status: status,
      comment: "",
      deadLine: "",
      photos: [],
    };
    auditSession.results.push(item);
  } else {
    item.status = status;
  }

  const comp = document.getElementById("comment-" + id);
  const dateLimit = document.getElementById("date-limit-" + id);
  const photoArea = document.getElementById("photo-area-" + id);
  if (comp) comp.style.display = status === "Нарушение" ? "block" : "none";
  if (dateLimit)
    dateLimit.style.display = status === "Нарушение" ? "block" : "none";
  if (photoArea)
    photoArea.style.display = status === "Нарушение" ? "block" : "none";
  document.getElementById("q-box-" + id).style.borderLeftColor =
    status === "Соответствует" ? "var(--success)" : "var(--danger)";
}

async function submitAuditWithOffline() {
  if (auditSession.results.length === 0)
    return alert("Вы не ответили ни на один вопрос!");
  const violations = [];
  let hasEmptyDates = false;

  auditSession.results.forEach(function (item) {
    if (item.status === "Нарушение") {
      const inputField = document.getElementById("comment-" + item.id);
      const dateField = document.getElementById("date-limit-" + item.id);
      if (inputField) item.comment = inputField.value.trim() || "-";
      if (dateField && dateField.value) {
        const dParts = dateField.value.split("-");
        item.deadLine = dParts[2] + "." + dParts[1] + "." + dParts[0];
      } else {
        item.deadLine = "";
        hasEmptyDates = true;
      }

      let line = "• [" + item.category + "] " + item.question;
      if (item.normative) {
        line += " (Норматив: " + item.normative + ")";
      }
      line +=
        "\n  Замечание: " +
        item.comment +
        " (Срок до: " +
        (item.deadLine || "не указан") +
        ")";
      violations.push(line);
    }
  });

  if (hasEmptyDates)
    return alert(
      "⚠️ Блокировка: Укажите дедлайн в календаре для всех нарушений!",
    );

  finalViolationsText =
    violations.length > 0 ? violations.join("\n\n") : "Нарушений не выявлено.";
  auditSession.aggregatedViolations = finalViolationsText;
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;

  // Генерируем auditId (UUID v4) для идемпотентности — колонка audits.id имеет тип UUID
  if (!auditSession.auditId) {
    auditSession.auditId = generateUuid();
  }

  if (navigator.onLine) {
    btn.innerText = "⏳ Отправка...";
    try {
      // Таймаут 90 сек. В реестр отправляем данные БЕЗ фото (base64) —
      // фото в реестре не хранятся, а большой payload с фото упирался
      // в лимит/таймаут Cloud Functions и акт не уходил.
      const response = await fetchWithTimeout(
        apiPath("audits"),
        {
          method: "POST",
          // Без Content-Type: application/json — «простой» запрос,
          // браузер не шлёт preflight OPTIONS (обход CORS на стороне YC).
          body: JSON.stringify(buildAuditPayload(auditSession)),
        },
        90000,
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      btn.innerText = "Акт сохранен!";
      document.getElementById("pdf-btn").disabled = false;
      alert("Данные успешно сохранены в реестр!");
    } catch (e) {
      // Логируем причину (таймаут/CORS/сеть), чтобы было видно в консоли.
      console.error("Ошибка отправки акта в облако:", e);
      // Гарантированное сохранение в память телефона при любой ошибке связи.
      saveToOfflineQueue(auditSession);
    }
  } else {
    saveToOfflineQueue(auditSession);
  }
}

// --- Офлайн-буфер на IndexedDB (вместо localStorage) ---
// localStorage ограничен ~5 МБ на домен — фото в base64 его переполняют,
// и акт не сохраняется. IndexedDB позволяет хранить сотни МБ, поэтому
// акты с фото сохраняются надёжно, независимо от свободной памяти телефона.

const OFFLINE_DB_NAME = "otipb-offline";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = "audit_queue";

function openOfflineDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = function (event) {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: "auditId" });
      }
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

function idbAddAudit(session) {
  return openOfflineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(OFFLINE_STORE, "readwrite");
      const store = tx.objectStore(OFFLINE_STORE);
      // put с ключом auditId — идемпотентно (не создаёт дубль)
      store.put(session);
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function idbGetAllAudits() {
  return openOfflineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(OFFLINE_STORE, "readonly");
      const store = tx.objectStore(OFFLINE_STORE);
      const request = store.getAll();
      request.onsuccess = function () {
        db.close();
        resolve(request.result || []);
      };
      request.onerror = function () {
        db.close();
        reject(request.error);
      };
    });
  });
}

function idbRemoveAudit(auditId) {
  return openOfflineDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(OFFLINE_STORE, "readwrite");
      const store = tx.objectStore(OFFLINE_STORE);
      store.delete(auditId);
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}

// Перенос старых актов из localStorage (лимит ~5 МБ) в IndexedDB,
// чтобы ничего не потерять после перехода на новый буфер.
async function migrateLegacyOfflineQueue() {
  try {
    const legacy = localStorage.getItem("offline_audit_queue");
    if (!legacy) return;
    const queue = JSON.parse(legacy);
    if (!Array.isArray(queue) || queue.length === 0) {
      localStorage.removeItem("offline_audit_queue");
      return;
    }
    for (let i = 0; i < queue.length; i++) {
      if (queue[i] && queue[i].auditId) {
        await idbAddAudit(queue[i]);
      }
    }
    localStorage.removeItem("offline_audit_queue");
    console.log("Миграция офлайн-буфера в IndexedDB выполнена:", queue.length);
  } catch (e) {
    console.error("Не удалось перенести старый буфер:", e);
  }
}

async function saveToOfflineQueue(session) {
  try {
    await idbAddAudit(session);
    document.getElementById("submit-btn").innerText = "💾 Офлайн-сохранено!";
    document.getElementById("pdf-btn").disabled = false;
    alert("⚠️ Данные сохранены в буфер телефона.");
    return true;
  } catch (e) {
    // IndexedDB недоступна/переполнена — данные в память не сохранить.
    console.error("Не удалось сохранить акт в буфер телефона:", e);
    alert(
      "⚠️ Не удалось сохранить акт в память телефона.\n" +
        "Скачайте акт сейчас, чтобы не потерять данные.",
    );
    document.getElementById("pdf-btn").disabled = false;
    return false;
  }
}

let syncInProgress = false;
async function syncOfflineQueue() {
  // Защита от параллельного запуска (таймер + событие online + фокус/visibility)
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    let queue = [];
    try {
      queue = await idbGetAllAudits();
    } catch (e) {
      console.error("Не удалось прочитать буфер:", e);
      return;
    }
    if (queue.length === 0) return;
    let synced = 0;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      // Убеждаемся, что у офлайн-акта есть auditId (UUID v4)
      if (!item.auditId) {
        item.auditId = generateUuid();
      }
      try {
        // Таймаут 90 сек. В реестр отправляем данные БЕЗ фото (base64) —
        // фото в реестре не хранятся, а большой payload с фото упирался
        // в лимит/таймаут Cloud Functions и акт не выгружался из буфера.
        const response = await fetchWithTimeout(
          apiPath("audits"),
          {
            method: "POST",
            // Без Content-Type: application/json — «простой» запрос (обход preflight CORS).
            body: JSON.stringify(buildAuditPayload(item)),
          },
          90000,
        );
        if (response.ok) {
          synced++;
          // Удаляем из буфера только успешно отправленные акты
          await idbRemoveAudit(item.auditId);
        } else {
          // Сервер ответил ошибкой — акт остаётся в буфере для следующей попытки
          console.warn(
            "Сервер вернул ошибку, акт остаётся в буфере:",
            response.status,
          );
        }
      } catch (e) {
        // Сеть снова пропала — останавливаемся, остальное отправим позже.
        console.warn("Ошибка отправки из буфера, повторим позже:", e);
        break;
      }
    }
    if (synced > 0) {
      alert(
        "✅ Связь восстановлена. Отправлено в реестр из буфера: " +
          synced +
          " акт(ов).",
      );
    }
  } finally {
    syncInProgress = false;
  }
}

function downloadChecklistPdf() {
  const currentDateStr = new Date().toLocaleDateString("ru-RU");
  document.getElementById("p-date").textContent = currentDateStr;
  document.getElementById("p-inspector").textContent = auditSession.inspector;
  document.getElementById("p-object").textContent = auditSession.objectName;
  document.getElementById("p-contractor").textContent = auditSession.contractor;

  const tbody = document.getElementById("p-violations-tbody");
  tbody.innerHTML = "";
  const violationsOnly = auditSession.results.filter(function (r) {
    return r.status === "Нарушение";
  });

  if (violationsOnly.length === 0) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.style.padding = "12px";
    cell.style.textAlign = "center";
    cell.style.color = "#27ae60";
    cell.style.fontWeight = "bold";
    cell.textContent = "Нарушений не выявлено.";
  } else {
    violationsOnly.forEach(function (item, index) {
      const row = tbody.insertRow();

      const cNum = row.insertCell();
      cNum.style.border = "1px solid #ddd";
      cNum.style.padding = "8px";
      cNum.style.textAlign = "center";
      cNum.textContent = index + 1;
      item.pdfIndex = index + 1;

      const cCat = row.insertCell();
      cCat.style.border = "1px solid #ddd";
      cCat.style.padding = "8px";
      cCat.style.fontWeight = "bold";
      cCat.style.fontSize = "13px";
      cCat.textContent = "[" + item.category + "]";

      const cQuest = row.insertCell();
      cQuest.style.border = "1px solid #ddd";
      cQuest.style.padding = "8px";
      cQuest.style.fontSize = "13px";

      // ИСПРАВЛЕНО: Теперь норматив из колонки C принудительно рендерится в печатную таблицу Акта
      if (item.normative) {
        cQuest.textContent = item.question;
        const sm = document.createElement("small");
        sm.style.color = "#555";
        sm.style.display = "block";
        sm.style.marginTop = "5px";
        sm.style.fontStyle = "italic";
        sm.textContent = "Норматив: " + item.normative;
        cQuest.appendChild(sm);
      } else {
        cQuest.textContent = item.question;
      }

      const cComm = row.insertCell();
      cComm.style.border = "1px solid #ddd";
      cComm.style.padding = "8px";
      cComm.style.fontSize = "13px";
      cComm.style.color = "#b33939";
      cComm.style.backgroundColor = "#fdf2f2";
      cComm.innerHTML =
        item.comment +
        '<br><span style="color:#d35400; font-weight:bold; font-size:11px;">⏱️ Срок до: ' +
        item.deadLine +
        "</span>";
    });
  }

  const galleryWrapper = document.getElementById("pdf-gallery-wrapper");
  galleryWrapper.innerHTML = "";
  let allUploadedPhotos = [];
  violationsOnly.forEach(function (item) {
    if (item.photos && item.photos.length > 0) {
      item.photos.forEach(function (base64Src) {
        allUploadedPhotos.push({
          src: base64Src,
          index: item.pdfIndex,
          category: item.category,
        });
      });
    }
  });

  const photosSummary = document.getElementById("p-photos-summary");
  if (photosSummary) photosSummary.textContent = "";

  if (allUploadedPhotos.length > 0) {
    let photosPerPage = 4;
    // Считаем фактическое количество страниц фото
    const photoPages = Math.ceil(allUploadedPhotos.length / photosPerPage);
    if (photosSummary) {
      photosSummary.textContent =
        "Приложение: Фотографии в количестве " +
        allUploadedPhotos.length +
        " шт. на " +
        photoPages +
        " листе(ах).";
    }
    for (let i = 0; i < allUploadedPhotos.length; i += photosPerPage) {
      const pageDiv = document.createElement("div");
      pageDiv.className = "pdf-page-break";
      pageDiv.innerHTML =
        '<div style="margin-top:20px; font-size:14px; font-weight:bold; color:#2c3e50; border-bottom:1px solid #2c3e50; padding-bottom:5px; text-transform:uppercase;">Приложение к Акту. Фотофиксация нарушений (Лист ' +
        (Math.floor(i / 4) + 1) +
        ")</div>";
      const grid = document.createElement("div");
      grid.className = "pdf-photo-grid";
      let pagePhotos = allUploadedPhotos.slice(i, i + photosPerPage);
      pagePhotos.forEach(function (pData) {
        const photoCard = document.createElement("div");
        photoCard.className = "pdf-photo-card";
        photoCard.innerHTML =
          '<div class="pdf-photo-container-img"><img class="pdf-photo-img" src="' +
          pData.src +
          '"></div><div class="pdf-photo-desc">Нарушение №' +
          pData.index +
          " " +
          pData.category +
          "</div>";
        grid.appendChild(photoCard);
      });
      pageDiv.appendChild(grid);
      galleryWrapper.appendChild(pageDiv);
    }
  }

  // Стабильная печать: ждём полной загрузки всех фото (base64-изображения
  // могут быть большими), затем открываем печать. Если печать недоступна —
  // показываем понятное сообщение, данные при этом не теряются.
  const pdfImages = Array.prototype.slice.call(
    document.querySelectorAll(".pdf-photo-img"),
  );
  const btn = document.getElementById("pdf-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Подготовка акта...";
  }

  Promise.all(
    pdfImages.map(function (img) {
      return new Promise(function (resolve) {
        if (img.complete && img.naturalWidth > 0) return resolve();
        img.addEventListener("load", resolve);
        img.addEventListener("error", resolve);
        // Страховка от зависания: ждём максимум 10 секунд на каждое фото
        setTimeout(resolve, 10000);
      });
    }),
  ).then(function () {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "2. Скачать Акт в PDF 📄";
    }
    try {
      const printed = window.print();
      // Убираем автоперезагрузку сразу после window.print(): на мобильных
      // браузерах вызов не блокирует JS, и перезагрузка через 1 сек прерывала
      // просмотр/скачивание акта (вариант Б). Теперь спрашиваем очистку
      // чек-листа только после фактического закрытия окна печати (afterprint).
      let cleanupAsked = false;
      function askCleanup() {
        if (cleanupAsked) return;
        cleanupAsked = true;
        setTimeout(function () {
          if (confirm("Выгрузка завершена! Очистить чек-лист для нового обхода?")) {
            location.reload();
          }
        }, 300);
      }
      // Основной путь: событие afterprint (десктоп-браузеры).
      window.addEventListener("afterprint", askCleanup, { once: true });
      // Страховка без принудительной перезагрузки: если событие afterprint
      // не сработало (некоторые мобильные браузеры), через 3 секунды просто
      // спрашиваем — страница перезагружается ТОЛЬКО по явному согласию.
      setTimeout(function () {
        if (!cleanupAsked) {
          askCleanup();
        }
      }, 3000);
      if (printed === false) {
        // window.print() может вернуть false (например, окно печати недоступно)
        askCleanup();
      }
    } catch (e) {
      console.error("Ошибка вызова печати:", e);
      alert(
        "⚠️ Не удалось открыть окно печати. Попробуйте ещё раз или обновите страницу.",
      );
      return;
    }
  });
}

function backToStep1() {
  document.getElementById("step-3-checklist").style.display = "none";
  document.getElementById("step-1-form").style.display = "block";
}
