const adminClient = String.raw`(() => {
  const app = window.MadarApp;
  if (!app) return;
  const content = document.getElementById("app-content");
  const shell = document.getElementById("app-shell");
  const nav = document.getElementById("app-nav");
  const adminState = {
    node: null,
    seller: null,
    settlements: [],
    settlementSellerId: "",
    enrollment: null,
    pollTimer: null,
  };
  const fa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });
  const intFa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

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
    return intFa.format(n) + " بایت";
  }
  function count(value) {
    return intFa.format(Number(value) || 0);
  }
  function showToast(message) {
    const toast = document.getElementById("app-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2200);
  }
  function adminHead(kicker, title, subtitle, backView) {
    return '<div class="admin-page-head">' +
      (backView ? '<button class="icon-button" type="button" data-admin-back="' + esc(backView) + '" aria-label="بازگشت">›</button>' : "") +
      '<div><div class="eyebrow">' + esc(kicker) + '</div><h1>' + esc(title) + '</h1><p>' + esc(subtitle) + '</p></div></div>';
  }
  function statCard(label, value, note) {
    return '<div class="admin-stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b>' + (note ? '<small>' + esc(note) + '</small>' : "") + '</div>';
  }
  function statusPill(ok, yes, no) {
    return '<span class="pill ' + (ok ? "" : "danger-pill") + '">' + esc(ok ? yes : no) + '</span>';
  }
  function relatedConfigs(items, nodeId) {
    const filtered = (items || []).filter((item) => item.nodeId === nodeId);
    if (!filtered.length) return '<div class="empty-inline">کانفیگ مرتبطی ثبت نشده است.</div>';
    return '<div class="admin-list">' + filtered.map((item) =>
      '<div class="admin-list-row"><div><strong>' + esc(item.label || item.id) + '</strong><span>' + esc(item.state || "") + '</span></div><b>' + esc(bytes(item.usedBytes || 0)) + '</b></div>',
    ).join("") + '</div>';
  }

  async function renderAdminServers() {
    const nodes = await app.api("/api/app/admin/nodes");
    if (nav) nav.className = "bottom-nav admin-nav";
    const cards = (nodes || []).map((node) => {
      const healthy = node.healthy !== false;
      return '<button type="button" class="card admin-entity-card" data-admin-node-id="' + esc(node.id) + '"><div class="admin-entity-top"><div><strong>' + esc(node.displayName || node.id) + '</strong><span>ظرفیت قابل فروش ' + esc(bytes(node.sellableBytes)) + '</span></div>' + statusPill(healthy, "سالم", "قطع") + '</div><div class="admin-card-grid">' +
        statCard("رزرو فعال", bytes(node.committedBytes || 0)) +
        statCard("مصرف واقعی", bytes(node.finalizedUsedBytes || 0)) +
        statCard("اسلات باقی", node.remainingSlots === null ? "نامحدود" : count(node.remainingSlots)) +
        statCard("استفاده", node.utilizationPercent === null ? "—" : count(node.utilizationPercent) + "٪") +
        '</div></button>';
    }).join("");
    content.innerHTML = adminHead("ADMIN · SERVERS", "سرورها", "مدیریت ظرفیت، سقف‌ها و افزودن VPS", "home") +
      '<button class="primary-action admin-add-vps" type="button" data-admin-action="begin-enrollment"><div><strong>افزودن VPS جدید</strong><br><span>بررسی SSH و نصب خودکار امن</span></div><b>＋</b></button>' +
      '<div class="admin-entity-grid">' + (cards || '<div class="card empty-inline">سروری ثبت نشده است.</div>') + '</div>';
  }

  function renderNodeDetail(detail, configs) {
    adminState.node = detail;
    const bandwidthMode = detail.maxAllocatedBytes === null ? "نامحدود" : bytes(detail.maxAllocatedBytes);
    const slotsMode = detail.accountSlotsUnlimited || detail.maxAccounts === null ? "نامحدود" : count(detail.maxAccounts);
    content.innerHTML = '<section class="admin-detail">' +
      adminHead("SERVER DETAIL", detail.displayName || detail.id, "اطلاعات عملیاتی و سقف‌های فروش", "servers") +
      '<div class="card technical-card"><div class="technical-row"><span>IP</span><b dir="ltr">' + esc(detail.targetIp) + '</b></div><div class="technical-row"><span>VPN Port</span><b dir="ltr">' + esc(detail.vpnPort) + '</b></div><div class="technical-row"><span>Revision / ACK</span><b dir="ltr">' + esc(detail.revision) + ' / ' + esc(detail.ackedRevision) + '</b></div><div class="technical-row"><span>SNI</span><b dir="ltr">' + esc(detail.sni || "—") + '</b></div><div class="technical-row"><span>قابلیت Agent</span><b dir="ltr">' + esc((detail.agentCapabilities || []).join(", ") || "—") + '</b></div></div>' +
      '<div class="admin-card-grid detail-stats">' +
      statCard("سقف حجم", bandwidthMode) + statCard("رزرو فعال", bytes(detail.committedBytes || 0)) + statCard("مصرف واقعی", bytes(detail.finalizedUsedBytes || 0)) + statCard("قابل فروش", bytes(detail.sellableBytes)) +
      statCard("سقف کانفیگ", slotsMode) + statCard("اشغال", count(detail.reservedAccounts || 0)) + statCard("باقی‌مانده", detail.remainingSlots === null ? "نامحدود" : count(detail.remainingSlots)) + statCard("Alert", count(detail.alertLevel || 0) + "٪") + '</div>' +
      '<section class="card admin-control-card"><h2>سقف حجم سرور</h2><p>عدد گیگابایت یا حالت نامحدود را انتخاب کنید.</p><div class="inline-form"><input id="admin-node-bandwidth" class="field-input" inputmode="numeric" value="' + (detail.maxAllocatedBytes === null ? "" : esc(detail.maxAllocatedBytes / 1e9)) + '" placeholder="1000"/><button class="mini-button" data-admin-action="save-bandwidth">ذخیره سقف حجم</button><button class="mini-button" data-admin-action="unlimited-bandwidth">نامحدود</button></div></section>' +
      '<section class="card admin-control-card"><h2>سقف کانفیگ همزمان</h2><p>حالت محدود یا نامحدود فقط روی تعداد اسلات اثر دارد.</p><div class="inline-form"><input id="admin-node-slots" class="field-input" inputmode="numeric" value="' + (detail.maxAccounts === null ? "" : esc(detail.maxAccounts)) + '" placeholder="20"/><button class="mini-button" data-admin-action="save-slots">ذخیره سقف کانفیگ</button><button class="mini-button" data-admin-action="unlimited-slots">نامحدود</button></div></section>' +
      '<section class="card admin-control-card"><h2>کانفیگ‌های مرتبط</h2>' + relatedConfigs(configs?.items || [], detail.id) + '</section></section>';
  }

  async function openAdminNode(nodeId) {
    const [detail, configs] = await Promise.all([
      app.api("/api/app/admin/nodes/" + encodeURIComponent(nodeId)),
      app.api("/api/app/configs"),
    ]);
    renderNodeDetail(detail, configs);
    return detail;
  }
  async function saveNodeBandwidth(nodeId, maxAllocatedBytes) {
    const detail = await app.api("/api/app/admin/nodes/" + encodeURIComponent(nodeId) + "/bandwidth", {
      method: "POST",
      body: JSON.stringify({ maxAllocatedBytes }),
    });
    const configs = await app.api("/api/app/configs");
    renderNodeDetail(detail, configs);
    showToast("سقف حجم سرور ذخیره شد.");
    return detail;
  }
  async function saveNodeSlots(nodeId, value) {
    const body = value?.mode === "unlimited" ? { mode: "unlimited" } : { mode: "finite", maxAccounts: Number(value?.maxAccounts) };
    const detail = await app.api("/api/app/admin/nodes/" + encodeURIComponent(nodeId) + "/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const configs = await app.api("/api/app/configs");
    renderNodeDetail(detail, configs);
    showToast("سقف کانفیگ سرور ذخیره شد.");
    return detail;
  }

  async function renderAdminSellers() {
    const sellers = await app.api("/api/app/admin/sellers");
    const cards = (sellers || []).map((seller) =>
      '<button type="button" class="card admin-entity-card" data-admin-seller-id="' + esc(seller.sellerId) + '"><div class="admin-entity-top"><div><strong dir="ltr">' + esc(seller.sellerId) + '</strong><span>فروش دوره جاری ' + esc(bytes(seller.current?.soldBytes || 0)) + '</span></div>' + statusPill(seller.enabled !== false, "فعال", "غیرفعال") + '</div><div class="admin-card-grid">' + statCard("کانفیگ جاری", count(seller.current?.configCount || 0)) + statCard("فروش جاری", bytes(seller.current?.soldBytes || 0)) + statCard("مصرف واقعی", bytes(seller.all?.usedBytes || 0)) + statCard("کل فروش", bytes(seller.all?.soldBytes || 0)) + '</div></button>',
    ).join("");
    content.innerHTML = adminHead("ADMIN · SELLERS", "فروشندگان", "محدودیت، دسترسی و تسویه حساب", "home") + '<div class="admin-entity-grid">' + (cards || '<div class="card empty-inline">فروشنده‌ای ثبت نشده است.</div>') + '</div>';
  }

  function settlementCards(rows) {
    if (!rows?.length) return '<div class="empty-inline">هنوز تسویه‌ای ثبت نشده است.</div>';
    return '<div class="settlement-list">' + rows.map((row) => '<div class="settlement-card"><div><strong>دوره ' + count(row.epoch) + '</strong><span>' + count(row.configCount) + ' کانفیگ</span></div><div><b>' + esc(bytes(row.soldBytes)) + '</b><span>فروش</span></div><div><b>' + esc(bytes(row.usedBytes)) + '</b><span>مصرف واقعی</span></div></div>').join("") + '</div>';
  }
  function renderSellerDetail(detail, settlements) {
    adminState.seller = detail;
    adminState.settlements = settlements || [];
    const l = detail.limits || {};
    content.innerHTML = '<section class="admin-detail">' + adminHead("SELLER DETAIL", "فروشنده " + detail.sellerId, "آمار دوره جاری، سابقه و کنترل دسترسی", "sellers") +
      '<div class="seller-period-grid"><section class="card"><div class="eyebrow">دوره جاری</div><div class="admin-card-grid">' + statCard("کانفیگ", count(detail.current?.configCount || 0)) + statCard("فروش", bytes(detail.current?.soldBytes || 0)) + statCard("مصرف واقعی", bytes(detail.current?.usedBytes || 0)) + statCard("فعال", count(detail.current?.liveCount || 0)) + '</div></section><section class="card"><div class="eyebrow">کل سابقه</div><div class="admin-card-grid">' + statCard("کانفیگ", count(detail.all?.configCount || 0)) + statCard("فروش", bytes(detail.all?.soldBytes || 0)) + statCard("مصرف واقعی", bytes(detail.all?.usedBytes || 0)) + statCard("پایان‌یافته", count((detail.all?.expiredCount || 0) + (detail.all?.revokedCount || 0) + (detail.all?.exhaustedCount || 0))) + '</div></section></div>' +
      '<section class="card admin-control-card"><h2>محدودیت فروشنده</h2><div class="inline-form"><label>سقف کانفیگ<input id="admin-seller-limit-count" class="field-input" inputmode="numeric" value="' + (l.maxReservedAccounts === null ? "" : esc(l.maxReservedAccounts)) + '" placeholder="نامحدود"/></label><label>سقف حجم (GB)<input id="admin-seller-limit-gb" class="field-input" inputmode="numeric" value="' + (l.maxCommittedBytes === null ? "" : esc(l.maxCommittedBytes / 1e9)) + '" placeholder="نامحدود"/></label><button class="action-button" type="button" data-admin-action="save-seller-limits">ذخیره محدودیت</button></div><div class="control-note">اکنون ' + count(l.reservedAccounts || 0) + ' کانفیگ و ' + esc(bytes(l.committedBytes || 0)) + ' رزرو فعال دارد.</div></section>' +
      '<section class="card admin-control-card"><div class="control-title-row"><div><h2>دسترسی فروش</h2><p>' + (detail.enabled ? "حساب فعال است." : "حساب غیرفعال است.") + '</p></div>' + statusPill(detail.enabled, "فعال", "غیرفعال") + '</div><button class="mini-button" data-admin-action="toggle-seller-access">' + (detail.enabled ? "غیرفعال کردن فروشنده" : "فعال کردن فروشنده") + '</button></section>' +
      '<section class="card admin-control-card"><div class="control-title-row"><div><h2>تسویه حساب</h2><p>دوره جاری بسته و دوره حسابداری جدید شروع می‌شود.</p></div></div><button class="mini-button warning-button" data-admin-action="ask-settlement">ثبت تسویه و شروع حساب جدید</button></section>' +
      '<section class="card admin-control-card"><h2>تاریخچه تسویه</h2>' + settlementCards(settlements) + '</section></section>';
  }
  async function openAdminSeller(sellerId) {
    const [detail, settlements] = await Promise.all([
      app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId)),
      app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/settlements"),
    ]);
    renderSellerDetail(detail, settlements);
    return detail;
  }
  async function saveSellerLimits(sellerId, maxReservedAccounts, maxCommittedBytes) {
    const detail = await app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/limits", {
      method: "POST",
      body: JSON.stringify({
        maxReservedAccounts: maxReservedAccounts === null ? null : Number(maxReservedAccounts),
        maxCommittedBytes: maxCommittedBytes === null ? null : Number(maxCommittedBytes),
      }),
    });
    const settlements = await app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/settlements");
    renderSellerDetail(detail, settlements);
    showToast("محدودیت فروشنده ذخیره شد.");
    return detail;
  }
  async function setSellerAccess(sellerId, enabled) {
    const detail = await app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/access", {
      method: "POST",
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    });
    const settlements = await app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/settlements");
    renderSellerDetail(detail, settlements);
    showToast(enabled ? "فروشنده فعال شد." : "فروشنده غیرفعال شد.");
    return detail;
  }
  function askSellerSettlement(sellerId) {
    adminState.settlementSellerId = String(sellerId);
    content.innerHTML = '<section class="card settlement-confirm"><div class="empty-icon">!</div><div class="eyebrow">SETTLEMENT CONFIRM</div><h1>تأیید تسویه</h1><p>این کار آمار دوره جاری فروشنده را در تاریخچه ثبت می‌کند و دوره جدید می‌سازد. کانفیگ‌های فعال متوقف نمی‌شوند و ظرفیت سرویس‌ها تغییر نمی‌کند.</p><div class="result-actions"><button class="action-button" data-admin-action="confirm-settlement">تأیید و ثبت تسویه</button><button class="mini-button" data-admin-action="cancel-settlement">انصراف</button></div></section>';
  }
  async function confirmSellerSettlement() {
    const sellerId = adminState.settlementSellerId;
    if (!sellerId) return;
    await app.api("/api/app/admin/sellers/" + encodeURIComponent(sellerId) + "/settle", { method: "POST", body: "{}" });
    adminState.settlementSellerId = "";
    showToast("تسویه ثبت شد و دوره جدید آغاز شد.");
    return openAdminSeller(sellerId);
  }

  async function renderAdminReports() {
    const report = await app.api("/api/app/admin/reports/overview");
    const s = report.summary || {};
    content.innerHTML = adminHead("ADMIN · REPORTS", "گزارش‌ها", "نمای کل شبکه و فروشندگان", "home") +
      '<div class="admin-card-grid report-summary">' + statCard("کانفیگ در سرویس", count(s.configsInService || 0)) + statCard("رزرو فعال", bytes(s.reservedBytes || 0)) + statCard("مصرف نهایی", bytes(s.finalizedUsedBytes || 0)) + statCard("فروشنده فعال", count(s.activeSellers || 0)) + '</div>' +
      '<section class="card admin-control-card"><h2>ظرفیت سرورها</h2><div class="admin-list">' + (report.nodes || []).map((node) => '<div class="admin-list-row"><div><strong>' + esc(node.displayName || node.id) + '</strong><span>' + (node.healthy ? "سالم" : "خارج از دسترس") + '</span></div><b>' + esc(bytes(node.sellableBytes)) + '</b></div>').join("") + '</div></section>' +
      '<section class="card admin-control-card"><h2>فروشندگان</h2><div class="admin-list">' + (report.sellers || []).map((seller) => '<div class="admin-list-row"><div><strong dir="ltr">' + esc(seller.sellerId) + '</strong><span>' + count(seller.current?.configCount || 0) + ' کانفیگ جاری</span></div><b>' + esc(bytes(seller.current?.soldBytes || 0)) + '</b></div>').join("") + '</div></section>';
  }

  const enrollmentSteps = ["identity", "target", "probe", "fingerprint", "credentials", "progress", "result"];
  function enrollmentHead(step, title, detail) {
    const at = Math.max(0, enrollmentSteps.indexOf(step));
    return adminHead("ADD VPS · " + count(at + 1) + "/" + count(enrollmentSteps.length), title, detail, "servers") + '<div class="wizard-steps enrollment-steps">' + enrollmentSteps.map((_, i) => '<span class="' + (i <= at ? "is-done" : "") + '"></span>').join("") + '</div>';
  }
  function beginEnrollment() {
    clearTimeout(adminState.pollTimer);
    adminState.enrollment = {
      step: "identity",
      name: "",
      maxAllocatedGb: 1000,
      maxAccounts: 100,
      targetIp: "",
      port: 22,
      username: "ubuntu",
      probeId: "",
      fingerprint: "",
      fingerprintConfirmed: false,
      credentialMode: "key",
      password: "",
      keyFile: null,
      keyText: "",
      passphrase: "",
      encryptedCredentials: "",
      jobId: "",
      jobKind: "",
      jobState: "",
      safeCode: "",
    };
    renderEnrollment();
  }
  function setEnrollmentField(field, value) {
    const e = adminState.enrollment;
    if (!e) return;
    if (["maxAllocatedGb", "maxAccounts", "port"].includes(field)) e[field] = Number(value);
    else e[field] = value;
  }
  function enrollmentNext() {
    const e = adminState.enrollment;
    if (!e) return;
    if (e.step === "identity") {
      if (!String(e.name || "").trim() || !Number.isSafeInteger(e.maxAllocatedGb) || e.maxAllocatedGb < 1 || !Number.isSafeInteger(e.maxAccounts) || e.maxAccounts < 1) return showToast("نام و سقف‌های معتبر وارد کنید.");
      e.step = "target";
      renderEnrollment();
    }
  }
  function renderEnrollment() {
    const e = adminState.enrollment;
    if (!e) return;
    if (nav) nav.innerHTML = "";
    if (e.step === "identity") {
      content.innerHTML = '<section data-enrollment-step="identity">' + enrollmentHead("identity", "مشخصات و سقف‌ها", "نام سرور و ظرفیت قابل فروش را تعیین کنید.") + '<div class="card form-card"><label class="field-label">نام سرور<input class="field-input" data-enrollment-field="name" value="' + esc(e.name) + '" placeholder="Europe 2"/></label><label class="field-label">سقف حجم (GB)<input class="field-input" inputmode="numeric" data-enrollment-field="maxAllocatedGb" value="' + esc(e.maxAllocatedGb) + '"/></label><label class="field-label">سقف کانفیگ<input class="field-input" inputmode="numeric" data-enrollment-field="maxAccounts" value="' + esc(e.maxAccounts) + '"/></label><button class="action-button wide-button" data-admin-action="enrollment-next">ادامه</button></div></section>';
      return;
    }
    if (e.step === "target") {
      content.innerHTML = '<section data-enrollment-step="target">' + enrollmentHead("target", "اتصال SSH", "IP عمومی، پورت و نام کاربر سرور را وارد کنید.") + '<div class="card form-card"><label class="field-label">IP عمومی<input class="field-input" dir="ltr" data-enrollment-field="targetIp" value="' + esc(e.targetIp) + '" placeholder="51.21.199.245"/></label><label class="field-label">پورت SSH<input class="field-input" inputmode="numeric" data-enrollment-field="port" value="' + esc(e.port) + '"/></label><label class="field-label">نام کاربر<input class="field-input" dir="ltr" data-enrollment-field="username" value="' + esc(e.username) + '"/></label><button class="action-button wide-button" data-admin-action="start-probe">بررسی اتصال سرور</button></div></section>';
      return;
    }
    if (e.step === "probe") {
      content.innerHTML = '<section data-enrollment-step="probe">' + enrollmentHead("probe", "در حال بررسی اتصال", "Runner فقط هویت SSH و امکان دسترسی را بررسی می‌کند.") + '<div class="card enrollment-progress"><span class="loading-orbit"></span><h2>در حال بررسی اتصال</h2><p>وضعیت: ' + esc(e.jobState || "در صف") + '</p><button class="mini-button" data-admin-action="poll-enrollment">بررسی حالا</button></div></section>';
      return;
    }
    if (e.step === "fingerprint") {
      content.innerHTML = '<section data-enrollment-step="fingerprint">' + enrollmentHead("fingerprint", "تأیید اثر انگشت", "اثر انگشت را با پنل ارائه‌دهنده VPS مقایسه کنید.") + '<div class="card fingerprint-card"><span>SSH HOST FINGERPRINT</span><code dir="ltr">' + esc(e.fingerprint) + '</code><p>فقط اگر مقدار دقیقاً با سرور شما یکسان است ادامه دهید.</p><button class="action-button wide-button" data-admin-action="confirm-fingerprint">اثر انگشت را تأیید می‌کنم</button></div></section>';
      return;
    }
    if (e.step === "credentials") {
      const credentialInput = e.credentialMode === "password"
        ? '<label class="field-label">رمز VPS<input class="field-input" type="password" autocomplete="off" data-enrollment-field="password" value=""/></label>'
        : '<label class="field-label">فایل کلید خصوصی<input class="field-input" type="file" data-enrollment-file="key"/></label><label class="field-label">رمز محافظ کلید (اختیاری)<input class="field-input" type="password" autocomplete="off" data-enrollment-field="passphrase" value=""/></label>';
      content.innerHTML = '<section data-enrollment-step="credentials">' + enrollmentHead("credentials", "اطلاعات ورود", "اطلاعات ورود قبل از ارسال در همین دستگاه رمزنگاری می‌شود.") + '<div class="card form-card"><div class="credential-mode"><button class="choice-button ' + (e.credentialMode === "key" ? "is-selected" : "") + '" data-credential-mode="key">کلید خصوصی</button><button class="choice-button ' + (e.credentialMode === "password" ? "is-selected" : "") + '" data-credential-mode="password">رمز VPS</button></div>' + credentialInput + '<button class="action-button wide-button" data-admin-action="submit-enrollment">شروع نصب خودکار</button></div></section>';
      return;
    }
    if (e.step === "progress") {
      const labels = { pending: "در صف نصب", queued: "در صف نصب", leased: "در حال اتصال", running: "در حال نصب", preflight: "بررسی پیش‌نیازها", installing: "در حال نصب", verifying: "در انتظار سلامت و ACK" };
      content.innerHTML = '<section data-enrollment-step="progress">' + enrollmentHead("progress", "نصب خودکار", "نصب روی VPS در حال اجراست؛ اطلاعات ورود در UI نگهداری نمی‌شود.") + '<div class="card enrollment-progress"><span class="loading-orbit"></span><h2>' + esc(labels[e.jobState] || "در حال نصب") + '</h2><p>می‌توانید پنل را باز نگه دارید یا بعداً وضعیت را دوباره بررسی کنید.</p><button class="mini-button" data-admin-action="poll-enrollment">بررسی حالا</button></div></section>';
      return;
    }
    if (e.step === "result") {
      const failed = e.jobState === "failed";
      content.innerHTML = '<section data-enrollment-step="result">' + enrollmentHead("result", failed ? "نصب کامل نشد" : "سرور آماده است", failed ? "اطلاعات ورود از این صفحه پاک شده و فقط کد پیگیری نمایش داده می‌شود." : "سرور سلامت خود را گزارش کرده و تنظیمات را ACK کرده است.") + '<div class="card enrollment-result ' + (failed ? "is-critical" : "") + '"><div class="result-success"><span>' + (failed ? "!" : "✓") + '</span><div><h2>' + (failed ? "نصب کامل نشد" : "سرور آماده است") + '</h2><p>' + (failed ? "کد پیگیری: " + esc(e.safeCode || "UNKNOWN") : "اکنون می‌توانید از صفحه سرورها ظرفیت و کاربرد آن را مدیریت کنید.") + '</p></div></div><button class="action-button wide-button" data-admin-back="servers">بازگشت به سرورها</button></div></section>';
    }
  }

  async function startEnrollmentProbe() {
    const e = adminState.enrollment;
    if (!e || e.step !== "target") return;
    if (!String(e.targetIp || "").trim() || !Number.isSafeInteger(e.port) || e.port < 1 || e.port > 65535 || !String(e.username || "").trim()) return showToast("اطلاعات SSH معتبر وارد کنید.");
    try {
      const session = await app.api("/api/app/admin/enrollment/session");
      const result = await app.api("/api/app/admin/enrollment/probe", { method: "POST", body: JSON.stringify({ targetIp: String(e.targetIp).trim(), port: e.port, nonce: session.nonce }) });
      e.probeId = result.jobId;
      e.jobId = result.jobId;
      e.jobKind = "probe";
      e.jobState = "queued";
      e.step = "probe";
      renderEnrollment();
      window.sessionStorage?.setItem("madar.enrollmentJobId", e.jobId);
    } catch (error) {
      showToast(error?.message || "بررسی اتصال شروع نشد.");
    }
  }
  async function pollEnrollmentJob() {
    const e = adminState.enrollment;
    if (!e?.jobId) return;
    try {
      const job = await app.api("/api/app/admin/enrollment/jobs/" + encodeURIComponent(e.jobId));
      e.jobState = job.state || "pending";
      if (e.jobKind === "probe" || job.kind === "probe") {
        e.jobKind = "probe";
        if (job.state === "ready") {
          e.fingerprint = job.fingerprint || "";
          e.step = "fingerprint";
        } else if (job.state === "failed") {
          e.safeCode = job.safe_code || "PROBE_FAILED";
          e.step = "result";
        } else e.step = "probe";
      } else {
        e.jobKind = "install";
        if (job.state === "ready") e.step = "result";
        else if (job.state === "failed") {
          e.safeCode = job.safe_code || "INSTALL_FAILED";
          e.step = "result";
        } else e.step = "progress";
      }
      renderEnrollment();
      if (["ready", "failed"].includes(job.state)) window.sessionStorage?.removeItem("madar.enrollmentJobId");
      return job;
    } catch {
      showToast("دریافت وضعیت نصب ناموفق بود؛ دوباره تلاش کنید.");
      return null;
    }
  }
  function confirmEnrollmentFingerprint() {
    const e = adminState.enrollment;
    if (!e || e.step !== "fingerprint" || !e.fingerprint) return;
    e.fingerprintConfirmed = true;
    e.step = "credentials";
    renderEnrollment();
  }
  function setEnrollmentCredentialMode(mode) {
    const e = adminState.enrollment;
    if (!e || !["key", "password"].includes(mode)) return;
    e.credentialMode = mode;
    e.password = "";
    e.passphrase = "";
    e.keyFile = null;
    e.keyText = "";
    renderEnrollment();
  }
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  async function encryptCredentials(value, jwk) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    const rsa = await crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const wrapped = await crypto.subtle.encrypt("RSA-OAEP", rsa, await crypto.subtle.exportKey("raw", key));
    return JSON.stringify({ v: 1, key: b64(wrapped), iv: b64(iv), data: b64(data) });
  }
  async function submitEnrollment() {
    const e = adminState.enrollment;
    if (!e?.fingerprintConfirmed) return showToast("ابتدا اثر انگشت سرور را تأیید کنید.");
    try {
      const session = await app.api("/api/app/admin/enrollment/session");
      let encryptedCredentials = e.encryptedCredentials;
      if (!encryptedCredentials) {
        let credentials;
        if (e.credentialMode === "password") {
          if (!e.password) return showToast("رمز VPS را وارد کنید.");
          credentials = { method: "password", password: e.password };
        } else {
          let keyText = e.keyText;
          if (!keyText && e.keyFile) {
            if (e.keyFile.size > 14000) return showToast("فایل کلید بیش از حد بزرگ است.");
            keyText = await e.keyFile.text();
          }
          if (!keyText) return showToast("فایل کلید خصوصی را انتخاب کنید.");
          credentials = { method: "key", key: keyText, passphrase: e.passphrase || "" };
        }
        if (!session.publicKey) return showToast("کلید نصب‌کننده در دسترس نیست.");
        encryptedCredentials = await encryptCredentials(credentials, session.publicKey);
        credentials = null;
      }
      const result = await app.api("/api/app/admin/enrollment/enroll", {
        method: "POST",
        body: JSON.stringify({
          name: String(e.name).trim(),
          maxAccounts: e.maxAccounts,
          maxAllocatedGb: e.maxAllocatedGb,
          targetIp: String(e.targetIp).trim(),
          port: e.port,
          username: String(e.username).trim(),
          hostFingerprint: e.fingerprint,
          probeId: e.probeId,
          nonce: session.nonce,
          encryptedCredentials,
        }),
      });
      e.password = "";
      e.passphrase = "";
      e.keyText = "";
      e.keyFile = null;
      e.encryptedCredentials = "";
      e.jobId = result.jobId;
      e.jobKind = "install";
      e.jobState = "queued";
      e.step = "progress";
      renderEnrollment();
      window.sessionStorage?.setItem("madar.enrollmentJobId", e.jobId);
      return result;
    } catch (error) {
      e.password = "";
      e.passphrase = "";
      e.keyText = "";
      e.keyFile = null;
      e.encryptedCredentials = "";
      showToast(error?.message || "شروع نصب ناموفق بود.");
      return null;
    }
  }
  function setEnrollmentJobForRecovery(jobId, step) {
    if (!adminState.enrollment) beginEnrollment();
    const e = adminState.enrollment;
    e.jobId = String(jobId || "");
    e.jobKind = "install";
    e.jobState = "pending";
    e.step = step === "progress" ? "progress" : "progress";
    renderEnrollment();
  }

  const baseRenderView = app.renderView.bind(app);
  app.renderView = async function(view) {
    if (view === "servers") return renderAdminServers();
    if (view === "sellers") return renderAdminSellers();
    if (view === "reports") return renderAdminReports();
    return baseRenderView(view);
  };

  shell?.addEventListener?.("input", (event) => {
    const target = event.target;
    const field = target?.dataset?.enrollmentField;
    if (field) setEnrollmentField(field, target.value);
  }, true);
  shell?.addEventListener?.("change", (event) => {
    const target = event.target;
    if (target?.dataset?.enrollmentFile === "key") setEnrollmentField("keyFile", target.files?.[0] || null);
  }, true);
  shell?.addEventListener?.("click", (event) => {
    const target = event.target;
    const closest = (selector) => target?.closest ? target.closest(selector) : null;
    const navTarget = closest("[data-view]");
    if (navTarget && ["servers", "sellers", "reports"].includes(navTarget.dataset.view)) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      app.renderView(navTarget.dataset.view);
      return;
    }
    const node = closest("[data-admin-node-id]");
    if (node?.dataset?.adminNodeId) {
      event.preventDefault?.(); event.stopImmediatePropagation?.(); openAdminNode(node.dataset.adminNodeId); return;
    }
    const seller = closest("[data-admin-seller-id]");
    if (seller?.dataset?.adminSellerId) {
      event.preventDefault?.(); event.stopImmediatePropagation?.(); openAdminSeller(seller.dataset.adminSellerId); return;
    }
    const back = closest("[data-admin-back]");
    if (back?.dataset?.adminBack) {
      event.preventDefault?.(); event.stopImmediatePropagation?.(); app.renderView(back.dataset.adminBack); return;
    }
    const mode = closest("[data-credential-mode]");
    if (mode?.dataset?.credentialMode) {
      event.preventDefault?.(); event.stopImmediatePropagation?.(); setEnrollmentCredentialMode(mode.dataset.credentialMode); return;
    }
    const actionTarget = closest("[data-admin-action]");
    const action = actionTarget?.dataset?.adminAction;
    if (!action) return;
    event.preventDefault?.(); event.stopImmediatePropagation?.();
    const nodeId = adminState.node?.id;
    const sellerId = adminState.seller?.sellerId;
    if (action === "begin-enrollment") beginEnrollment();
    if (action === "save-bandwidth" && nodeId) {
      const gb = Number(document.getElementById("admin-node-bandwidth")?.value);
      if (gb > 0) saveNodeBandwidth(nodeId, gb * 1e9); else showToast("سقف حجم معتبر وارد کنید.");
    }
    if (action === "unlimited-bandwidth" && nodeId) saveNodeBandwidth(nodeId, null);
    if (action === "save-slots" && nodeId) {
      const maxAccounts = Number(document.getElementById("admin-node-slots")?.value);
      if (Number.isSafeInteger(maxAccounts) && maxAccounts > 0) saveNodeSlots(nodeId, { mode: "finite", maxAccounts }); else showToast("سقف کانفیگ معتبر وارد کنید.");
    }
    if (action === "unlimited-slots" && nodeId) saveNodeSlots(nodeId, { mode: "unlimited" });
    if (action === "save-seller-limits" && sellerId) {
      const countRaw = document.getElementById("admin-seller-limit-count")?.value || "";
      const gbRaw = document.getElementById("admin-seller-limit-gb")?.value || "";
      saveSellerLimits(sellerId, countRaw ? Number(countRaw) : null, gbRaw ? Number(gbRaw) * 1e9 : null);
    }
    if (action === "toggle-seller-access" && sellerId) setSellerAccess(sellerId, !adminState.seller.enabled);
    if (action === "ask-settlement" && sellerId) askSellerSettlement(sellerId);
    if (action === "confirm-settlement") confirmSellerSettlement();
    if (action === "cancel-settlement" && adminState.settlementSellerId) openAdminSeller(adminState.settlementSellerId);
    if (action === "enrollment-next") enrollmentNext();
    if (action === "start-probe") startEnrollmentProbe();
    if (action === "poll-enrollment") pollEnrollmentJob();
    if (action === "confirm-fingerprint") confirmEnrollmentFingerprint();
    if (action === "submit-enrollment") submitEnrollment();
  }, true);

  Object.assign(app, {
    openAdminNode,
    saveNodeBandwidth,
    saveNodeSlots,
    openAdminSeller,
    saveSellerLimits,
    setSellerAccess,
    askSellerSettlement,
    confirmSellerSettlement,
    beginEnrollment,
    setEnrollmentField,
    enrollmentNext,
    startEnrollmentProbe,
    pollEnrollmentJob,
    confirmEnrollmentFingerprint,
    setEnrollmentCredentialMode,
    submitEnrollment,
    setEnrollmentJobForRecovery,
  });
})();
`;

export default adminClient;
