(() => {
  const tg = window.Telegram?.WebApp;
  tg?.ready();
  tg?.expand?.();
  window.MadarApp = {
    initData: tg?.initData || "",
  };
})();
