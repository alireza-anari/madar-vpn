const client = String.raw`(() => {
  const tg = window.Telegram?.WebApp;
  const content = document.getElementById("app-content");
  const nav = document.getElementById("app-nav");
  const shell = document.getElementById("app-shell");
  const toast = document.getElementById("app-toast");
  const initData = tg?.initData || "";
  const state = { role: null, dashboard: null, view: "home", loading: false };

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

  function clampPercent(value) {
    const n = Number(value) || 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  const errorCopy = {
    AUTH_EXPIRED: ["نشست تلگرام منقضی شده", "پنل را ببندید و دوباره از داخل ربات باز کنید."],
    INVALID_SIGNATURE: ["ورود معتبر نیست", "پنل را دوباره از داخل تلگرام باز کنید."],
    SELLER_DISABLED: ["دسترسی فروش غیرفعال است", "برای فعال‌سازی دوباره با مدیر مدار هماهنگ کنید."],
    SELLER_REQUIRED: ["دسترسی به پنل ممکن نیست", "این حساب اجازه استفاده از پنل فروش را ندارد."],
    ADMIN_REQUIRED: ["دسترسی مدیر لازم است", "این بخش فقط برای مدیر مدار در دسترس است."],
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
      '<div class="primary-action"><div><strong>ساخت کانفیگ</strong><br><span>سرور مناسب را با ظرفیت واقعی انتخاب کنید</span></div><button class="action-button" type="button" data-action="new-sale">شروع فروش</button></div>' +
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

  function row(title, subtitle, tag = "") {
    return '<div class="list-row"><div><strong>' +
      esc(title) +
      '</strong><br><span>' +
      esc(subtitle) +
      '</span></div>' +
      (tag ? '<span class="tag">' + esc(tag) + '</span>' : "") +
      '</div>';
  }

  async function renderView(view) {
    state.view = view;
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
          ? configs.items.map((item) => row(item.label || item.id, bytes(item.usedBytes || 0) + " مصرف", item.state || "")).join("")
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

  shell?.addEventListener?.("click", (event) => {
    const navTarget = closestAction(event.target, "data-view");
    if (navTarget?.dataset?.view) {
      renderView(navTarget.dataset.view);
      return;
    }
    const actionTarget = closestAction(event.target, "data-action");
    const action = actionTarget?.dataset?.action;
    if (action === "refresh") refresh({ keepView: true, force: true });
    if (action === "new-sale") showToast("ساخت کانفیگ در مرحله بعدی این پنل فعال می‌شود.");
  });

  document.addEventListener?.("visibilitychange", () => {
    if (!document.hidden) refresh({ keepView: true, force: true });
  });

  tg?.ready?.();
  tg?.expand?.();
  tg?.setHeaderColor?.("#07111f");
  tg?.setBackgroundColor?.("#07111f");

  const ready = refresh();
  window.MadarApp = { initData, api, refresh, renderView, ready };
})();
`;

export default client;
