(() => {
  const APP_VERSION = "1.1.0";

  // Update dynamic version links and text elements
  document.querySelectorAll("[data-version-href]").forEach((el) => {
    const template = el.getAttribute("data-version-href");
    if (template) {
      el.href = template.replaceAll("{version}", APP_VERSION);
    }
  });

  document.querySelectorAll("[data-version-template]").forEach((el) => {
    const template = el.getAttribute("data-version-template");
    if (template) {
      el.textContent = template.replaceAll("{version}", APP_VERSION);
    }
  });

  const toggle = document.querySelector(".nav-toggle");
  const mobileNav = document.getElementById("mobile-nav");

  if (!toggle || !mobileNav) return;

  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    mobileNav.hidden = !open;
  };

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    setOpen(open);
  });

  mobileNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });
})();

