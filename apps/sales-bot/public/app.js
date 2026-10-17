const client = String.raw`(() => {
  const tg = window.Telegram?.WebApp;
  const content = document.getElementById("app-content");
  const nav = document.getElementById("app-nav");
  const shell = document.getElementById("app-shell");
  const toast = document.getElementById("app-toast");
  const initData = tg?.initData || "";
  const state = {
    role: null,
    dashboard: null,
    view: "home",
    loading: false,
    wizard: null,
    result: null,
    resultTimer: null,
  };

  const RECOVERY_KEY = "madar.pendingAccountId";

  function rememberPendingAccount(accountId) {
    if (!accountId) return;
    try {
      window.sessionStorage?.setItem(RECOVERY_KEY, String(accountId));
    } catch {}
  }

  function readPendingAccount() {
    try {
      const value = window.sessionStorage?.getItem(RECOVERY_KEY);
      return value && value.length <= 120 ? value : null;
    } catch {
      return null;
    }
  }

  function forgetPendingAccount() {
    try {
      window.sessionStorage?.removeItem(RECOVERY_KEY);
    } catch {}
  }

  const fa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });
  const integerFa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function bytes(value) {
    if (value === null || value === undefined) return "نامحدود";
    const n = Number(value) || 0;
    if (n >= 1e12) return fa.format(n / 1e12) + " ترابایت";
    if (n >= 1e9) return fa.format(n / 1e9) + " گیگ";
    if (n >= 1e6) return fa.format(n / 1e6) + " مگ";
    return integerFa.format(n) + " بایت";
  }

  function count(value) {
    return integerFa.format(Number(value) || 0);
  }

  function duration(value) {
    const seconds = Number(value) || 0;
    if (seconds === 1800) return "۳۰ دقیقه";
    if (seconds % 86400 === 0) return count(seconds / 86400) + " روز";
    if (seconds % 3600 === 0) return count(seconds / 3600) + " ساعت";
    return count(Math.round(seconds / 60)) + " دقیقه";
  }

  function buildShareText(result) {
    if (!result) return "";
    const config = String(result.config || "");
    if (!result.usageUrl) return config;
    return [
      "اشتراک مدار",
      "مشتری: " + String(result.label || "—"),
      "حجم: " + bytes(result.quotaBytes),
      "مدت: " + duration(result.durationSeconds),
      "سرور: " + String(result.serverName || "—"),
      "مصرف و اعتبار: " + String(result.usageUrl),
      "",
      "کانفیگ:",
      config,
    ].join("\n");
  }

  function clampPercent(value) {
    const n = Number(value) || 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function requestKey(prefix) {
    return String(prefix || "app") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  const errorCopy = {
    AUTH_EXPIRED: ["نشست تلگرام منقضی شده", "پنل را ببندید و دوباره از داخل ربات باز کنید."],
    INVALID_SIGNATURE: ["ورود معتبر نیست", "پنل را دوباره از داخل تلگرام باز کنید."],
    SELLER_DISABLED: ["دسترسی فروش غیرفعال است", "برای فعال‌سازی دوباره با مدیر مدار هماهنگ کنید."],
    SELLER_REQUIRED: ["دسترسی به پنل ممکن نیست", "این حساب اجازه استفاده از پنل فروش را ندارد."],
    ADMIN_REQUIRED: ["دسترسی مدیر لازم است", "این بخش فقط برای مدیر مدار در دسترس است."],
    SELLER_CONFIG_LIMIT: ["سقف کانفیگ فروشنده پر شده", "برای فروش جدید باید ظرفیت حساب آزاد یا سقف افزایش داده شود."],
    SELLER_VOLUME_LIMIT: ["سقف حجم فروشنده پر شده", "حجم قابل فروش این حساب کافی نیست."],
    INSUFFICIENT_NODE_CAPACITY: ["ظرفیت سرور تغییر کرده", "لیست سرورها تازه شد؛ یک سرور دارای ظرفیت انتخاب کنید."],
    NODE_SLOT_LIMIT: ["اسلات سرور پر شده", "لیست سرورها تازه شد؛ سرور دیگری انتخاب کنید."],
    NODE_UNAVAILABLE: ["سرور در دسترس نیست", "لیست سرورها تازه شد؛ سرور دیگری انتخاب کنید."],
    REQUEST_FAILED: ["دریافت اطلاعات ناموفق بود", "اتصال را بررسی کنید و دوباره تلاش کنید."],
  };

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), "X-Telegram-Init-Data": initData };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.error || "REQUEST_FAILED");
      error.code = payload?.error || "REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setBusy(value) {
    state.loading = value;
    if (content?.setAttribute) content.setAttribute("aria-busy", value ? "true" : "false");
  }

  function stateCard(title, detail, icon = "◌") {
    return '<section class="card state-card"><div class="empty-icon" aria-hidden="true">' +
      esc(icon) +
      '</div><h1>' +
      esc(title) +
      '</h1><p>' +
      esc(detail) +
      '</p></section>';
  }

  function renderError(code) {
    const copy = errorCopy[code] || errorCopy.REQUEST_FAILED;
    if (content) content.innerHTML = stateCard(copy[0], copy[1], "!");
    if (nav) {
      nav.innerHTML = "";
      nav.className = "bottom-nav";
    }
    setBusy(false);
  }

  function metric(icon, value, label, note = "") {
    return '<article class="card metric-card"><span class="metric-icon" aria-hidden="true">' +
      icon +
      '</span><div><div class="metric-value">' +
      value +
      '</div><div class="metric-label">' +
      esc(label) +
      '</div>' +
      (note ? '<div class="metric-note">' + esc(note) + '</div>' : "") +
      '</div></article>';
  }

  function nodeState(node) {
    if (!node.healthy || node.eligible === false || Number(node.alertLevel) >= 95) return "is-critical";
    if (Number(node.alertLevel) >= 80 || Number(node.utilizationPercent) >= 80) return "is-warning";
    return "";
  }

  function nodeCard(node) {
    const pct = clampPercent(node.utilizationPercent);
    const klass = nodeState(node);
    const health = !node.healthy ? "خارج از دسترس" : klass === "is-critical" ? "بحرانی" : klass === "is-warning" ? "هشدار" : "سالم";
    const capacity = node.maxAllocatedBytes === null ? "نامحدود" : bytes(node.maxAllocatedBytes);
    const slots = node.remainingSlots === null ? "نامحدود" : count(node.remainingSlots);
    return '<article class="card node-card ' +
      klass +
      '"><div class="node-top"><div class="node-title"><span class="status-dot" aria-hidden="true"></span><div><h3>' +
      esc(node.displayName || node.name || node.id) +
      '</h3><small>ظرفیت کل: ' +
      esc(capacity) +
      '</small></div></div><span class="pill">' +
      esc(health) +
      '</span></div><div class="capacity-line"><span>مصرف تعهدشده</span><strong>' +
      esc(bytes(node.committedBytes || 0)) +
      " / " +
      esc(capacity) +
      '</strong></div><div class="progress" role="progressbar" aria-label="مصرف ظرفیت" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      pct +
      '"><span style="width:' +
      pct +
      '%"></span></div><div class="node-stats"><div class="node-stat"><b>' +
      esc(bytes(node.sellableBytes)) +
      '</b><span>قابل فروش</span></div><div class="node-stat"><b>' +
      esc(bytes(node.finalizedUsedBytes || 0)) +
      '</b><span>مصرف واقعی</span></div><div class="node-stat"><b>' +
      esc(slots) +
      '</b><span>اسلات باقی‌مانده</span></div></div></article>';
  }

  function nodeSection(nodes, title = "سرورها") {
    if (!nodes?.length)
      return '<section><div class="section-head"><div><div class="eyebrow">شبکه</div><h2>' +
        esc(title) +
        '</h2></div></div>' +
        stateCard("سروری برای نمایش نیست", "بعد از اضافه شدن سرور، وضعیت آن اینجا دیده می‌شود.", "○") +
        '</section>';
    return '<section><div class="section-head"><div><div class="eyebrow">شبکه</div><h2>' +
      esc(title) +
      '</h2></div><span class="tag">' +
      count(nodes.length) +
      ' سرور</span></div><div class="node-grid">' +
      nodes.map(nodeCard).join("") +
      '</div></section>';
  }

  function renderAdminHome(dashboard) {
    const s = dashboard.summary || {};
    return '<div class="section-head"><div><div class="eyebrow">ADMIN CONTROL</div><h1>وضعیت کلی مدار</h1><p>نمای زنده فروش، ظرفیت و سلامت شبکه</p></div></div>' +
      '<section class="summary-grid">' +
      metric("◈", count(s.configsInService), "کانفیگ در سرویس") +
      metric("◫", bytes(s.reservedBytes), "حجم رزروشده فعال") +
      metric("◎", bytes(s.finalizedUsedBytes), "مصرف واقعی نهایی") +
      metric("◇", count(s.activeSellers), "فروشنده‌های فعال") +
      '</section>' +
      '<div class="primary-action"><div><strong>ساخت کانفیگ جدید</strong><br><span>فروش با کنترل لحظه‌ای ظرفیت</span></div><button class="action-button" type="button" data-action="new-sale">شروع</button></div>' +
      nodeSection(dashboard.nodes || [], "وضعیت سرورها");
  }

  function renderSellerHome(dashboard) {
    const s = dashboard.summary || {};
    return '<div class="section-head"><div><div class="eyebrow">SELLER</div><h1>پنل فروش</h1><p>فروش، ظرفیت و آمار حساب شما</p></div></div>' +
      '<section class="summary-grid">' +
      metric("◈", count(s.configsInService), "کانفیگ فعال") +
      metric("◫", bytes(s.currentSoldBytes), "فروش این تسویه") +
      metric("◎", bytes(s.usedBytes), "مصرف واقعی مشتریان") +
      metric("◇", bytes(s.allTimeSoldBytes), "فروش کل") +
      '</section>' +
      '<div class="quick-actions"><button class="primary-action quick-action-button" type="button" data-action="new-sale"><div><strong>ساخت کانفیگ</strong><br><span>فروش با ظرفیت واقعی</span></div><b>＋</b></button><button class="primary-action quick-action-button secondary" type="button" data-action="new-trial"><div><strong>ساخت تست</strong><br><span>۱ گیگ · ۳۰ دقیقه</span></div><b>🎁</b></button></div>' +
      nodeSection(dashboard.nodes || [], "ظرفیت قابل فروش");
  }

  const adminNav = [
    ["home", "⌂", "خانه"],
    ["servers", "◉", "سرورها"],
    ["sellers", "♙", "فروشندگان"],
    ["configs", "▤", "کانفیگ‌ها"],
    ["reports", "⌁", "گزارش‌ها"],
  ];
  const sellerNav = [
    ["home", "⌂", "خانه"],
    ["configs", "▤", "کانفیگ‌ها"],
    ["stats", "⌁", "آمار من"],
  ];

  function renderNav() {
    if (!nav || !state.role) return;
    const items = state.role === "admin" ? adminNav : sellerNav;
    nav.className = "bottom-nav " + (state.role === "admin" ? "admin-nav" : "seller-nav");
    nav.innerHTML = items
      .map(([view, icon, label]) =>
        '<button type="button" class="nav-button ' +
        (state.view === view ? "is-active" : "") +
        '" data-view="' +
        view +
        '"><b aria-hidden="true">' +
        icon +
        '</b>' +
        label +
        '</button>',
      )
      .join("");
  }

  function row(title, subtitle, tag = "", recoverId = "") {
    return '<div class="list-row"><div><strong>' +
      esc(title) +
      '</strong><br><span>' +
      esc(subtitle) +
      '</span></div><div class="row-actions">' +
      (tag ? '<span class="tag">' + esc(tag) + '</span>' : "") +
      (recoverId ? '<button class="mini-button" type="button" data-recover-id="' + esc(recoverId) + '">مشاهده</button>' : "") +
      '</div></div>';
  }

  function wizardHeader(step, title, subtitle) {
    const order = ["label", "quota", "duration", "server", "confirm"];
    const at = Math.max(0, order.indexOf(step));
    return '<div class="wizard-head"><button type="button" class="icon-button wizard-back" data-action="wizard-cancel" aria-label="بازگشت">›</button><div><div class="eyebrow">ساخت سرویس · مرحله ' +
      count(at + 1) +
      ' از ' +
      count(order.length) +
      '</div><h1>' +
      esc(title) +
      '</h1><p>' +
      esc(subtitle) +
      '</p></div></div><div class="wizard-steps" aria-label="مراحل ساخت">' +
      order.map((item, i) => '<span class="' + (i <= at ? "is-done" : "") + '"></span>').join("") +
      '</div>';
  }

  function renderWizardStep() {
    const w = state.wizard;
    if (!w || !content) return;
    if (nav) nav.innerHTML = "";
    if (w.step === "label") {
      content.innerHTML = '<section class="wizard" data-wizard-step="label">' +
        wizardHeader("label", "نام مشتری", "یک نام کوتاه برای پیدا کردن این کانفیگ وارد کنید.") +
        '<div class="card form-card"><label class="field-label" for="wizard-label">نام مشتری</label><input id="wizard-label" class="field-input" data-wizard-field="label" maxlength="80" autocomplete="off" value="' +
        esc(w.label || "") +
        '" placeholder="مثلاً نیما" /><button class="action-button wide-button" type="button" data-action="wizard-next">ادامه</button></div></section>';
      return;
    }
    if (w.step === "quota") {
      const choices = [10, 20, 30, 50, 100];
      content.innerHTML = '<section class="wizard" data-wizard-step="quota">' +
        wizardHeader("quota", "حجم سرویس", "حجم فروخته‌شده تا پایان سرویس برای سرور رزرو می‌شود.") +
        '<div class="card form-card"><div class="choice-grid">' +
        choices.map((gb) => '<button type="button" class="choice-button ' + (w.quotaBytes === gb * 1e9 ? "is-selected" : "") + '" data-set-quota="' + gb + '"><b>' + count(gb) + '</b><span>گیگ</span></button>').join("") +
        '</div><label class="field-label" for="wizard-quota">یا حجم دلخواه (گیگ)</label><input id="wizard-quota" class="field-input" inputmode="numeric" data-wizard-field="quotaGb" value="' +
        (w.quotaBytes ? esc(w.quotaBytes / 1e9) : "") +
        '" placeholder="۳۰" /><button class="action-button wide-button" type="button" data-action="wizard-next">ادامه</button></div></section>';
      return;
    }
    if (w.step === "duration") {
      const choices = [7, 15, 30, 60, 90];
      content.innerHTML = '<section class="wizard" data-wizard-step="duration">' +
        wizardHeader("duration", "مدت سرویس", "مدت اعتبار از زمان فعال‌شدن کانفیگ حساب می‌شود.") +
        '<div class="card form-card"><div class="choice-grid">' +
        choices.map((days) => '<button type="button" class="choice-button ' + (w.durationSeconds === days * 86400 ? "is-selected" : "") + '" data-set-duration="' + days + '"><b>' + count(days) + '</b><span>روز</span></button>').join("") +
        '</div><label class="field-label" for="wizard-duration">یا تعداد روز دلخواه</label><input id="wizard-duration" class="field-input" inputmode="numeric" data-wizard-field="durationDays" value="' +
        (w.durationSeconds ? esc(w.durationSeconds / 86400) : "") +
        '" placeholder="۳۰" /><button class="action-button wide-button" type="button" data-action="wizard-next">انتخاب سرور</button></div></section>';
      return;
    }
    if (w.step === "server") {
      const nodes = w.preview?.nodes || [];
      const cards = nodes.length
        ? nodes.map((node) => {
            const disabled = node.eligible === false;
            const reason = node.ineligibleReason === "NODE_SLOT_LIMIT" ? "اسلات کافی نیست" : node.ineligibleReason === "INSUFFICIENT_NODE_CAPACITY" ? "حجم کافی نیست" : node.ineligibleReason === "NODE_UNAVAILABLE" ? "در دسترس نیست" : disabled ? "قابل انتخاب نیست" : "";
            return '<button type="button" class="card server-choice ' + (disabled ? "is-disabled" : "") + '" data-node-id="' + esc(node.id) + '" ' + (disabled ? "disabled" : "") + '><div class="server-choice-head"><div><strong>' + esc(node.displayName || node.id) + '</strong><span>' + (node.recommended ? '<em>پیشنهادی</em>' : "") + '</span></div><b>' + esc(bytes(node.sellableBytes)) + '</b></div><div class="server-choice-meta"><span>قابل فروش</span><span>اسلات: ' + esc(node.remainingSlots === null ? "نامحدود" : count(node.remainingSlots)) + '</span></div>' + (reason ? '<small>' + esc(reason) + '</small>' : "") + '</button>';
          }).join("")
        : stateCard("سرور قابل فروش پیدا نشد", "ظرفیت سرورها را بررسی کنید یا بعداً دوباره تلاش کنید.", "!");
      content.innerHTML = '<section class="wizard" data-wizard-step="server">' +
        wizardHeader("server", "انتخاب سرور", w.kind === "trial" ? "برای تست ۱ گیگ و ۳۰ دقیقه، یک سرور دارای ظرفیت انتخاب کنید." : "سرور پیشنهادی فقط پیشنهاد است؛ انتخاب نهایی با شماست.") +
        '<div class="server-choice-grid">' + cards + '</div></section>';
      return;
    }
    if (w.step === "confirm") {
      const selected = w.preview?.selectedNode;
      const node = (w.preview?.nodes || []).find((item) => item.id === w.nodeId);
      const before = selected?.beforeSellableBytes;
      const after = selected?.afterSellableBytes;
      content.innerHTML = '<section class="wizard" data-wizard-step="confirm">' +
        wizardHeader("confirm", "تأیید نهایی", "قبل از ساخت، مشخصات و ظرفیت لحظه‌ای را بررسی کنید.") +
        '<div class="card confirm-card"><div class="confirm-grid">' +
        '<div><span>مشتری</span><b>' + esc(w.kind === "trial" ? "تست نیم‌ساعته" : w.label) + '</b></div>' +
        '<div><span>حجم</span><b>' + esc(bytes(w.kind === "trial" ? 1e9 : w.quotaBytes)) + '</b></div>' +
        '<div><span>مدت</span><b>' + esc(duration(w.kind === "trial" ? 1800 : w.durationSeconds)) + '</b></div>' +
        '<div><span>سرور</span><b>' + esc(node?.displayName || w.nodeId) + '</b></div>' +
        '</div><div class="capacity-preview"><div><span>قبل از فروش</span><strong>' + esc(bytes(before)) + '</strong></div><span class="capacity-arrow">←</span><div><span>بعد از فروش</span><strong>' + esc(bytes(after)) + '</strong></div></div>' +
        '<button class="action-button wide-button" type="button" data-action="wizard-create" ' + (w.submitting ? "disabled" : "") + '>' + (w.submitting ? "در حال ساخت…" : w.kind === "trial" ? "ساخت تست" : "ساخت کانفیگ") + '</button></div></section>';
    }
  }

  function wizardSaleInput(withNode) {
    const w = state.wizard;
    const input = {
      kind: "sale",
      label: w.kind === "trial" ? "تست نیم‌ساعته" : w.label,
      quotaBytes: w.kind === "trial" ? 1e9 : Number(w.quotaBytes),
      durationSeconds: w.kind === "trial" ? 1800 : Number(w.durationSeconds),
    };
    if (withNode && w.nodeId) input.nodeId = w.nodeId;
    return input;
  }

  async function previewWizard(withNode = false) {
    const preview = await api("/api/app/configs/preview", {
      method: "POST",
      body: JSON.stringify(wizardSaleInput(withNode)),
    });
    state.wizard.preview = preview;
    return preview;
  }

  function beginSale() {
    clearTimeout(state.resultTimer);
    state.result = null;
    state.wizard = {
      kind: "sale",
      step: "label",
      label: "",
      quotaBytes: 0,
      durationSeconds: 0,
      nodeId: "",
      preview: null,
      requestKey: requestKey("sale"),
      submitting: false,
    };
    renderWizardStep();
  }

  async function beginTrial() {
    clearTimeout(state.resultTimer);
    state.result = null;
    state.wizard = {
      kind: "trial",
      step: "server",
      label: "تست نیم‌ساعته",
      quotaBytes: 1e9,
      durationSeconds: 1800,
      nodeId: "",
      preview: null,
      requestKey: requestKey("trial"),
      submitting: false,
    };
    setBusy(true);
    try {
      await previewWizard(false);
      renderWizardStep();
    } catch (error) {
      showToast(errorCopy[error?.code]?.[0] || "دریافت ظرفیت سرورها ناموفق بود");
      await renderView("home");
    } finally {
      setBusy(false);
    }
  }

  function setWizardField(field, value) {
    const w = state.wizard;
    if (!w) return;
    if (field === "label") w.label = String(value || "").trimStart();
    if (field === "quotaBytes") w.quotaBytes = Number(value) || 0;
    if (field === "quotaGb") w.quotaBytes = Math.max(0, Number(String(value).replace(/,/g, "")) || 0) * 1e9;
    if (field === "durationSeconds") w.durationSeconds = Number(value) || 0;
    if (field === "durationDays") w.durationSeconds = Math.max(0, Number(String(value).replace(/,/g, "")) || 0) * 86400;
  }

  async function wizardNext() {
    const w = state.wizard;
    if (!w) return;
    if (w.step === "label") {
      if (!w.label.trim()) return showToast("نام مشتری را وارد کنید.");
      w.step = "quota";
      renderWizardStep();
      return;
    }
    if (w.step === "quota") {
      if (!Number.isSafeInteger(w.quotaBytes) || w.quotaBytes <= 0 || w.quotaBytes > 1e12) return showToast("حجم معتبر وارد کنید.");
      w.step = "duration";
      renderWizardStep();
      return;
    }
    if (w.step === "duration") {
      if (!Number.isSafeInteger(w.durationSeconds) || w.durationSeconds < 1 || w.durationSeconds > 31536000) return showToast("مدت معتبر وارد کنید.");
      setBusy(true);
      try {
        await previewWizard(false);
        w.step = "server";
        renderWizardStep();
      } catch (error) {
        showToast(errorCopy[error?.code]?.[0] || "دریافت ظرفیت سرورها ناموفق بود");
      } finally {
        setBusy(false);
      }
    }
  }

  async function selectWizardNode(nodeId) {
    const w = state.wizard;
    if (!w) return;
    w.nodeId = String(nodeId || "");
    setBusy(true);
    try {
      const preview = await previewWizard(true);
      if (!preview.selectedNode?.eligible) {
        w.nodeId = "";
        w.step = "server";
        renderWizardStep();
        showToast("این سرور دیگر ظرفیت کافی ندارد.");
        return;
      }
      w.step = "confirm";
      renderWizardStep();
    } catch (error) {
      w.nodeId = "";
      w.step = "server";
      try {
        await previewWizard(false);
      } catch {}
      renderWizardStep();
      showToast(errorCopy[error?.code]?.[0] || "ظرفیت سرور تغییر کرده است.");
    } finally {
      setBusy(false);
    }
  }

  function renderPendingResult(accountId, stateName) {
    if (!content) return;
    if (nav) nav.innerHTML = "";
    content.innerHTML = '<section class="card result-card pending-result" data-result-screen="pending"><span class="loading-orbit" aria-hidden="true"></span><div class="eyebrow">CONFIG PREPARING</div><h1>کانفیگ در حال آماده‌سازی است</h1><p>ساخت ثبت شده و حتی اگر پنل را ببندید، نتیجه از مسیر امن ربات هم برای شما ارسال می‌شود.</p><div class="pending-meta"><span>شناسه</span><b dir="ltr">' + esc(accountId) + '</b><span>وضعیت</span><b>' + esc(stateName || "preparing") + '</b></div><button class="action-button wide-button" type="button" data-recover-id="' + esc(accountId) + '">بررسی دوباره</button></section>';
  }

  function drawQr() {
    const r = state.result;
    if (!r?.qrSvg) return;
    const target = document.getElementById("result-qr");
    if (!target) return;
    target.innerHTML = String(r.qrSvg);
  }

  function renderReadyResult(result) {
    state.result = result;
    if (!content) return;
    if (nav) nav.innerHTML = "";
    const isTrial = result.kind === "trial" || Number(result.durationSeconds) === 1800;
    const usage = result.usageUrl
      ? '<div class="result-actions usage-actions"><a class="action-button usage-link" href="' + esc(result.usageUrl) + '" target="_blank" rel="noopener noreferrer">مصرف و اعتبار</a><button class="action-button secondary-button" type="button" data-action="copy-usage">کپی لینک مصرف</button></div><div class="usage-url" dir="ltr">' + esc(result.usageUrl) + '</div>'
      : "";
    content.innerHTML = '<section class="result-screen" data-result-screen="ready"><div class="result-success"><span>✓</span><div><div class="eyebrow">READY</div><h1>کانفیگ آماده است</h1></div></div><div class="card result-card"><div class="result-summary"><div><span>مشتری</span><b>' + esc(result.label || "—") + '</b></div><div><span>حجم</span><b>' + esc(bytes(result.quotaBytes)) + '</b></div><div><span>مدت</span><b>' + esc(duration(result.durationSeconds)) + '</b></div><div><span>سرور</span><b>' + esc(result.serverName || "—") + '</b></div></div>' +
      (isTrial ? '<div class="trial-badge">🎁 تست ۱ گیگ · ۳۰ دقیقه</div>' : "") +
      '<div class="qr-box"><div id="result-qr" aria-label="QR کانفیگ">' + (typeof result.qrSvg === "string" ? result.qrSvg : "") + '</div><small>برای واردکردن سریع در برنامه اتصال اسکن کنید.</small></div><label class="field-label">کانفیگ</label><pre class="config-box" dir="ltr">' + esc(result.config || "") + '</pre>' + usage + '<div class="result-actions"><button class="action-button" type="button" data-action="copy-result">📋 کپی کانفیگ</button><button class="action-button secondary-button" type="button" data-action="share-result">↗ اشتراک‌گذاری</button></div><div class="result-actions"><button class="mini-button grow" type="button" data-action="result-back">بازگشت به کانفیگ‌ها</button><button class="mini-button grow" type="button" data-action="close-result">بستن پنل</button></div></div></section>';
    setTimeout(drawQr, 0);
  }

  async function recoverAccount(accountId, attempt = 0) {
    clearTimeout(state.resultTimer);
    try {
      const result = await api("/api/app/configs/" + encodeURIComponent(accountId) + "/result");
      if (result?.ready) {
        forgetPendingAccount();
        renderReadyResult(result);
        return result;
      }
      renderPendingResult(accountId, result?.state);
      if (attempt < 24) {
        const delay = Math.min(5000, 900 + attempt * 250);
        state.resultTimer = setTimeout(() => recoverAccount(accountId, attempt + 1), delay);
      }
      return result;
    } catch (error) {
      if (error?.code === "ACCOUNT_NOT_FOUND") {
        forgetPendingAccount();
        showToast("این کانفیگ پیدا نشد یا متعلق به این حساب نیست.");
        await renderView("configs");
        return null;
      }
      renderPendingResult(accountId, "در انتظار ارتباط");
      if (attempt < 12) state.resultTimer = setTimeout(() => recoverAccount(accountId, attempt + 1), 1800);
      return null;
    }
  }

  async function createCurrentWizard() {
    const w = state.wizard;
    if (!w || !w.nodeId || w.submitting) return;
    w.submitting = true;
    renderWizardStep();
    try {
      let result;
      if (w.kind === "trial") {
        result = await api("/api/app/configs/test", {
          method: "POST",
          body: JSON.stringify({ nodeId: w.nodeId, requestKey: w.requestKey }),
        });
      } else {
        result = await api("/api/app/configs/create", {
          method: "POST",
          body: JSON.stringify({
            kind: "sale",
            label: w.label.trim(),
            quotaBytes: w.quotaBytes,
            durationSeconds: w.durationSeconds,
            nodeId: w.nodeId,
            requestKey: w.requestKey,
          }),
        });
      }
      rememberPendingAccount(result.accountId);
      renderPendingResult(result.accountId, result.state);
      await recoverAccount(result.accountId, 0);
    } catch (error) {
      w.submitting = false;
      const refreshable = ["INSUFFICIENT_NODE_CAPACITY", "NODE_SLOT_LIMIT", "NODE_UNAVAILABLE", "SELLER_CONFIG_LIMIT", "SELLER_VOLUME_LIMIT"].includes(error?.code);
      if (refreshable) {
        showToast(errorCopy[error.code]?.[0] || "ظرفیت تغییر کرده است.");
        w.nodeId = "";
        w.step = "server";
        try {
          await previewWizard(false);
        } catch {}
        renderWizardStep();
      } else {
        renderWizardStep();
        showToast(errorCopy[error?.code]?.[0] || "ساخت کانفیگ ناموفق بود.");
      }
    }
  }

  async function copyText(value, successMessage) {
    if (!value || !navigator.clipboard?.writeText) {
      showToast("کپی خودکار در این دستگاه ممکن نیست.");
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage);
      return true;
    } catch {
      showToast("کپی خودکار در این دستگاه ممکن نیست.");
      return false;
    }
  }

  async function copyResult() {
    return copyText(state.result?.config, "کانفیگ کپی شد.");
  }

  async function copyUsageUrl() {
    return copyText(state.result?.usageUrl, "لینک مصرف کپی شد.");
  }

  async function qrPngFile(result) {
    if (
      !result?.qrSvg ||
      typeof Blob === "undefined" ||
      typeof File === "undefined" ||
      typeof Image === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      !document.createElement
    )
      return null;
    let objectUrl = "";
    try {
      const svg = new Blob([String(result.qrSvg)], { type: "image/svg+xml" });
      objectUrl = URL.createObjectURL(svg);
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      if (!canvas?.getContext || !canvas?.toBlob) return null;
      const size = 512;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      if (typeof ctx.fillRect === "function") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
      }
      ctx.drawImage(image, 0, 0, size, size);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) return null;
      const id = String(result.accountId || "config")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 40) || "config";
      return new File([png], "madar-" + id + ".png", { type: "image/png" });
    } catch {
      return null;
    } finally {
      if (objectUrl) URL.revokeObjectURL?.(objectUrl);
    }
  }

  async function shareResult() {
    const result = state.result;
    const text = buildShareText(result);
    if (!text) return false;
    if (navigator.share) {
      if (typeof navigator.canShare === "function" && result?.qrSvg) {
        const file = await qrPngFile(result);
        if (file && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ title: "Madar VPN", text, files: [file] });
            return true;
          } catch (error) {
            if (error?.name === "AbortError") return false;
          }
        }
      }
      try {
        await navigator.share({ title: "Madar VPN", text });
        return true;
      } catch (error) {
        if (error?.name === "AbortError") return false;
      }
    }
    return copyText(text, "جزئیات سرویس کپی شد.");
  }

  async function renderView(view) {
    clearTimeout(state.resultTimer);
    state.view = view;
    state.wizard = null;
    renderNav();
    setBusy(true);
    try {
      if (view === "home") {
        if (content) content.innerHTML = state.role === "admin" ? renderAdminHome(state.dashboard) : renderSellerHome(state.dashboard);
      } else if (view === "servers" && state.role === "admin") {
        const nodes = await api("/api/app/admin/nodes");
        if (content) content.innerHTML = '<div class="section-head"><div><div class="eyebrow">ADMIN</div><h1>سرورها</h1><p>ظرفیت، سلامت و وضعیت فروش</p></div></div>' + nodeSection(nodes || [], "همه سرورها");
      } else if (view === "sellers" && state.role === "admin") {
        const sellers = await api("/api/app/admin/sellers");
        const list = sellers?.length
          ? sellers.map((seller) => row(seller.displayName || seller.sellerId, "فروش جاری: " + bytes(seller.current?.soldBytes || 0), seller.enabled === false ? "غیرفعال" : "فعال")).join("")
          : stateCard("فروشنده‌ای ثبت نشده", "پس از اضافه شدن فروشنده، آمار او اینجا نمایش داده می‌شود.", "♙");
        if (content) content.innerHTML = '<div class="section-head"><div><div class="eyebrow">ADMIN</div><h1>فروشندگان</h1><p>تسویه، محدودیت و عملکرد فروش</p></div></div><section class="card">' + list + '</section>';
      } else if (view === "configs") {
        const configs = await api("/api/app/configs");
        const list = configs?.items?.length
          ? configs.items.map((item) => row(item.label || item.id, bytes(item.usedBytes || 0) + " مصرف", item.state || "", item.id)).join("")
          : stateCard("کانفیگی وجود ندارد", "کانفیگ‌های ساخته‌شده در این بخش نمایش داده می‌شوند.", "▤");
        if (content) content.innerHTML = '<div class="section-head"><div><div class="eyebrow">CONFIGS</div><h1>کانفیگ‌ها</h1><p>وضعیت سرویس‌های ساخته‌شده</p></div></div>' + (configs?.items?.length ? '<section class="card">' + list + '</section>' : list);
      } else if (view === "reports" && state.role === "admin") {
        const report = await api("/api/app/admin/reports/overview");
        if (content) content.innerHTML = '<div class="section-head"><div><div class="eyebrow">REPORTS</div><h1>گزارش‌ها</h1><p>نمای تجمیعی ظرفیت و فروش</p></div></div>' + nodeSection(report?.nodes || [], "ظرفیت شبکه");
      } else if (view === "stats" && state.role === "seller") {
        const stats = await api("/api/app/seller/stats");
        if (content) content.innerHTML = '<div class="section-head"><div><div class="eyebrow">SELLER STATS</div><h1>آمار من</h1><p>دوره تسویه جاری و عملکرد کل</p></div></div><section class="summary-grid">' +
          metric("◫", bytes(stats.current?.soldBytes || 0), "فروش این تسویه") +
          metric("◎", bytes(stats.all?.usedBytes || 0), "مصرف واقعی") +
          metric("◇", bytes(stats.all?.soldBytes || 0), "فروش کل") +
          metric("◈", count(stats.limits?.reservedAccounts || 0), "کانفیگ در سرویس") +
          '</section>';
      }
    } catch (error) {
      renderError(error?.code || error?.message || "REQUEST_FAILED");
      return;
    }
    setBusy(false);
  }

  async function refresh(options = {}) {
    if (state.loading && !options.force) return;
    setBusy(true);
    try {
      const dashboard = await api("/api/app/dashboard");
      state.dashboard = dashboard;
      state.role = dashboard?.role;
      if (state.role !== "admin" && state.role !== "seller") throw new Error("SELLER_REQUIRED");
      if (!options.keepView) state.view = "home";
      await renderView(state.view);
      if (!options.keepView) {
        const pendingId = readPendingAccount();
        if (pendingId) await recoverAccount(pendingId, 0);
      }
    } catch (error) {
      renderError(error?.code || error?.message || "REQUEST_FAILED");
    }
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  function closestAction(target, attr) {
    if (!target) return null;
    if (target.closest) return target.closest("[" + attr + "]");
    return null;
  }

  shell?.addEventListener?.("input", (event) => {
    const target = event.target;
    const field = target?.dataset?.wizardField;
    if (field) setWizardField(field, target.value);
  });

  shell?.addEventListener?.("click", (event) => {
    const quota = closestAction(event.target, "data-set-quota");
    if (quota?.dataset?.setQuota) {
      setWizardField("quotaGb", quota.dataset.setQuota);
      renderWizardStep();
      return;
    }
    const days = closestAction(event.target, "data-set-duration");
    if (days?.dataset?.setDuration) {
      setWizardField("durationDays", days.dataset.setDuration);
      renderWizardStep();
      return;
    }
    const node = closestAction(event.target, "data-node-id");
    if (node?.dataset?.nodeId) {
      selectWizardNode(node.dataset.nodeId);
      return;
    }
    const recover = closestAction(event.target, "data-recover-id");
    if (recover?.dataset?.recoverId) {
      recoverAccount(recover.dataset.recoverId);
      return;
    }
    const navTarget = closestAction(event.target, "data-view");
    if (navTarget?.dataset?.view) {
      renderView(navTarget.dataset.view);
      return;
    }
    const actionTarget = closestAction(event.target, "data-action");
    const action = actionTarget?.dataset?.action;
    if (action === "refresh") refresh({ keepView: true, force: true });
    if (action === "new-sale") beginSale();
    if (action === "new-trial") beginTrial();
    if (action === "wizard-next") wizardNext();
    if (action === "wizard-create") createCurrentWizard();
    if (action === "wizard-cancel") renderView("home");
    if (action === "copy-result") copyResult();
    if (action === "copy-usage") copyUsageUrl();
    if (action === "share-result") shareResult();
    if (action === "result-back") renderView("configs");
    if (action === "close-result") tg?.close?.();
  });

  document.addEventListener?.("visibilitychange", () => {
    if (!document.hidden && !state.wizard && !state.result) refresh({ keepView: true, force: true });
  });

  tg?.ready?.();
  tg?.expand?.();
  tg?.setHeaderColor?.("#07111f");
  tg?.setBackgroundColor?.("#07111f");

  const ready = refresh();
  window.MadarApp = {
    initData,
    api,
    refresh,
    renderView,
    ready,
    beginSale,
    beginTrial,
    setWizardField,
    wizardNext,
    selectWizardNode,
    createCurrentWizard,
    recoverAccount,
    buildShareText,
    copyResult,
    copyUsageUrl,
    shareResult,
  };
})();
`;

export default client;