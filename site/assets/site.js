/* QA-Pilot site script. Plain modern JS, no dependencies, deferred.
   Every feature is a progressive enhancement and runs inside its own guard,
   so a failure in one never stops the others. */
(() => {
  "use strict";

  const root = document.documentElement;
  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  const features = [];
  const feature = (fn) => features.push(fn);

  root.classList.add("js");

  /* Shared polite live region ------------------------------------------ */
  let status = null;
  const announce = (text) => {
    if (!status) {
      status = document.createElement("div");
      status.className = "visually-hidden";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      document.body.appendChild(status);
    }
    status.textContent = "";
    // A changed node is what screen readers announce; the timeout forces the change.
    setTimeout(() => {
      status.textContent = text;
    }, 30);
  };

  /* Italic face, loaded after the page ---------------------------------- */
  // Emphasis is a word or two per page, so the 24 KB italic face is fetched after `load`
  // instead of competing with the fonts the first paint needs, and only where italics exist.
  // Until it arrives (or without JS) emphasised words show upright; nothing is ever faked.
  feature(() => {
    if (!("fonts" in document) || typeof FontFace !== "function" || !$("em, i, cite")) return;
    const base = (root.getAttribute("data-base") || "/").replace(/\/?$/, "/");
    const add = () => {
      const face = new FontFace("IBM Plex Sans", `url("${base}assets/fonts/plex-sans-400-italic.woff2") format("woff2")`, {
        style: "italic",
        weight: "400",
        display: "swap",
      });
      document.fonts.add(face);
      face.load().catch(() => {});
    };
    // A second after load: `load` and even the first idle period can come before the first
    // paint has settled, and emphasis is almost always below the fold anyway.
    const later = () => setTimeout(add, 1000);
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
  });

  /* Theme -------------------------------------------------------------- */
  feature(() => {
    const KEY = "qp-theme";
    const btn = $("[data-theme-toggle]");
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    const stored = () => {
      try {
        const v = localStorage.getItem(KEY);
        return v === "light" || v === "dark" ? v : null;
      } catch {
        return null;
      }
    };
    const effective = () => root.getAttribute("data-theme") || (mq.matches ? "dark" : "light");

    const svg = (inner) =>
      `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${inner}</svg>`;
    const SUN = svg(
      '<circle cx="8" cy="8" r="2.75"/>' +
        '<path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.23 3.23l1.06 1.06M11.71 11.71l1.06 1.06M3.23 12.77l1.06-1.06M11.71 4.29l1.06-1.06"/>'
    );
    const MOON = svg('<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z"/>');

    const render = () => {
      if (!btn) return;
      const next = effective() === "dark" ? "light" : "dark";
      // The glyph shows where the button will take you.
      btn.innerHTML = next === "dark" ? MOON : SUN;
      btn.setAttribute("aria-label", `Switch to ${next} theme`);
    };

    const saved = stored();
    if (saved) root.setAttribute("data-theme", saved);
    render();

    if (btn) {
      btn.addEventListener("click", () => {
        const next = effective() === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try {
          localStorage.setItem(KEY, next);
        } catch {}
        render();
      });
    }
    mq.addEventListener?.("change", render);
  });

  /* Header hairline once scrolled -------------------------------------- */
  feature(() => {
    const header = $(".site-header");
    if (!header) return;
    const update = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
  });

  /* Copy buttons ------------------------------------------------------- */
  feature(() => {
    const copyText = async (text) => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand("copy")) throw new Error("copy failed");
      } finally {
        ta.remove();
      }
    };

    const sourceFor = (btn) => {
      const scope = btn.closest(".cmd, .code");
      if (!scope) return "";
      const el = scope.matches(".cmd") ? $("code", scope) : $("pre", scope);
      return el ? el.textContent.replace(/\n$/, "") : "";
    };

    $$(".cmd__copy, .code__copy").forEach((btn) => {
      const label = btn.textContent;
      // Specific names: the visible word stays "Copy", so the name still contains it.
      if (btn.matches(".cmd__copy")) btn.setAttribute("aria-label", "Copy command");
      else {
        const lang = $(".code__lang", btn.closest(".code") || document);
        btn.setAttribute("aria-label", lang && lang.textContent.trim() ? `Copy ${lang.textContent.trim()} code` : "Copy code");
      }
      let timer = 0;
      btn.addEventListener("click", async () => {
        try {
          await copyText(sourceFor(btn));
        } catch {
          announce("Copy failed");
          return;
        }
        btn.textContent = "Copied";
        announce("Copied to clipboard");
        clearTimeout(timer);
        timer = setTimeout(() => {
          btn.textContent = label;
        }, 1600);
      });
    });
  });

  /* Keyboard access to anything that scrolls --------------------------- */
  feature(() => {
    const targets = $$(".table-wrap, .artifact pre, .code > pre, .cmd code");
    const check = () => {
      targets.forEach((el) => {
        const overflows = el.scrollWidth > el.clientWidth + 1;
        if (overflows && !el.hasAttribute("tabindex")) {
          el.setAttribute("tabindex", "0");
          el.dataset.qpFocusable = "";
          el.setAttribute("role", "region");
          el.setAttribute("aria-label", el.matches(".table-wrap") ? "Scrollable table" : "Code, scrollable");
        } else if (!overflows && "qpFocusable" in el.dataset) {
          el.removeAttribute("tabindex");
          el.removeAttribute("role");
          el.removeAttribute("aria-label");
          delete el.dataset.qpFocusable;
        }
      });
    };
    check();
    let t = 0;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(check, 150);
    });
  });

  /* Docs drawer -------------------------------------------------------- */
  feature(() => {
    const toggle = $("[data-menu-toggle]");
    const sidebar = $(".doc-sidebar");
    if (!toggle || !sidebar) return;

    // A close button and a copy of the primary nav, for the narrow drawer.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "doc-sidebar__close";
    close.textContent = "Close menu";
    sidebar.prepend(close);

    const nav = $(".site-nav");
    if (nav) {
      const frag = document.createElement("div");
      frag.className = "doc-sidebar__site";
      const label = document.createElement("p");
      label.className = "doc-sidebar__group";
      label.textContent = "Site";
      const list = document.createElement("ul");
      $$("a", nav).forEach((a) => {
        const li = document.createElement("li");
        const link = a.cloneNode(true);
        link.removeAttribute("aria-current");
        li.appendChild(link);
        list.appendChild(li);
      });
      frag.append(label, list);
      close.after(frag);
    }

    const backdrop = document.createElement("div");
    backdrop.className = "drawer-backdrop";
    backdrop.hidden = true;
    document.body.appendChild(backdrop);

    const focusables = () =>
      $$("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])", sidebar).filter(
        (el) => el.offsetParent !== null
      );

    const isOpen = () => sidebar.classList.contains("is-open");

    // The sidebar sits inside <main>, so main itself cannot be inert. Instead every
    // sibling on the path from the sidebar up to <body> is, which covers the header,
    // the article, the table of contents, the footer and the skip link.
    const navLabel = sidebar.getAttribute("aria-label");
    let inerted = [];
    const lockPage = () => {
      for (let node = sidebar; node && node !== document.body; node = node.parentElement) {
        for (const sib of node.parentElement.children) {
          if (sib === node || sib === backdrop || sib.matches("script, style, [role='status']")) continue;
          if (!sib.inert) {
            sib.inert = true;
            inerted.push(sib);
          }
        }
      }
    };
    const unlockPage = () => {
      inerted.forEach((el) => (el.inert = false));
      inerted = [];
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        shut();
      } else if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (!sidebar.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    function open() {
      sidebar.classList.add("is-open");
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      sidebar.setAttribute("aria-label", "Documentation menu");
      lockPage();
      backdrop.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      root.classList.add("drawer-open");
      document.addEventListener("keydown", onKey);
      const current = $("[aria-current='page']", sidebar) || focusables()[0];
      if (current) current.focus();
    }
    function shut() {
      if (!isOpen()) return;
      sidebar.classList.remove("is-open");
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
      if (navLabel) sidebar.setAttribute("aria-label", navLabel);
      else sidebar.removeAttribute("aria-label");
      unlockPage();
      backdrop.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      root.classList.remove("drawer-open");
      document.removeEventListener("keydown", onKey);
      toggle.focus();
    }

    toggle.addEventListener("click", () => (isOpen() ? shut() : open()));
    close.addEventListener("click", shut);
    backdrop.addEventListener("click", shut);
    // Following a link in the drawer is a navigation; the page unloads, but close anyway for in-page anchors.
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest("a")) shut();
    });
    window.matchMedia("(min-width: 960px)").addEventListener?.("change", (e) => {
      if (e.matches && isOpen()) shut();
    });
  });

  /* Table of contents scrollspy ---------------------------------------- */
  feature(() => {
    if (!("IntersectionObserver" in window)) return;
    const links = $$(".toc a[href^='#']");
    if (!links.length) return;
    const pairs = links
      .map((a) => {
        let id = a.getAttribute("href").slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {}
        return [a, document.getElementById(id)];
      })
      .filter(([, h]) => h);
    if (!pairs.length) return;

    let current = null;
    const set = (link) => {
      if (link === current) return;
      if (current) current.removeAttribute("aria-current");
      current = link;
      if (link) link.setAttribute("aria-current", "true");
    };
    const update = () => {
      const line = window.innerHeight * 0.3;
      let active = pairs[0][0];
      for (const [a, h] of pairs) {
        if (h.getBoundingClientRect().top <= line) active = a;
        else break;
      }
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atEnd && window.scrollY > 0) active = pairs[pairs.length - 1][0];
      set(active);
    };

    const io = new IntersectionObserver(update, { rootMargin: "0px 0px -70% 0px" });
    pairs.forEach(([, h]) => io.observe(h));
    update();
  });

  /* Search ------------------------------------------------------------- */
  feature(() => {
    const dialog = $("dialog.search");
    if (!dialog || typeof dialog.showModal !== "function") return;
    const input = $(".search__input", dialog);
    const list = $(".search__results", dialog);
    if (!input || !list) return;

    const baseOf = () => {
      const attr = root.getAttribute("data-base");
      if (attr) return attr;
      const css = $("link[rel~='stylesheet'][href*='site.css']");
      if (css) {
        try {
          return new URL("../", css.href).pathname;
        } catch {}
      }
      return "/";
    };
    const base = baseOf();

    let pf = null;
    let loading = null;
    const load = () => {
      if (!loading) {
        loading = import(`${base}pagefind/pagefind.js`)
          .then(async (mod) => {
            if (typeof mod.options === "function") await mod.options({ baseUrl: base });
            pf = mod;
            return mod;
          })
          .catch((err) => {
            loading = null;
            throw err;
          });
      }
      return loading;
    };

    const message = (text) => {
      list.replaceChildren();
      const li = document.createElement("li");
      li.className = "search__empty";
      li.textContent = text;
      list.appendChild(li);
    };

    const statusEl = $("[data-search-status]", dialog);
    const say = (text) => {
      if (statusEl) statusEl.textContent = text;
    };
    const links = () => $$("a", list);

    const render = (query, items) => {
      list.replaceChildren();
      if (!items.length) {
        const text = `No results for "${query}"`;
        message(text);
        say(text);
        return;
      }
      items.forEach((d) => {
        // Land on the section that matched when Pagefind found one.
        const sub = d.sub_results && d.sub_results[0];
        let url = (sub && sub.url) || d.url || "#";
        if (base !== "/" && url.startsWith("/") && !url.startsWith(base)) url = base + url.slice(1);
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = url;
        const group = d.meta && d.meta.group;
        if (group) {
          const g = document.createElement("span");
          g.className = "search__group";
          g.textContent = group;
          a.appendChild(g);
        }
        const title = document.createElement("span");
        title.className = "search__title";
        title.textContent = (d.meta && d.meta.title) || url;
        const excerpt = document.createElement("span");
        excerpt.className = "search__excerpt";
        excerpt.innerHTML = (sub && sub.excerpt) || d.excerpt || ""; // Pagefind escapes the text and adds <mark>.
        a.append(title, excerpt);
        li.appendChild(a);
        list.appendChild(li);
      });
      say(`${items.length} ${items.length === 1 ? "result" : "results"}`);
    };

    let ticket = 0;
    const run = async (query) => {
      const mine = ++ticket;
      if (!query.trim()) {
        list.replaceChildren();
        say("");
        return;
      }
      try {
        const mod = pf || (await load());
        const res = await mod.search(query);
        const data = await Promise.all(res.results.slice(0, 8).map((r) => r.data()));
        if (mine === ticket) render(query.trim(), data);
      } catch {
        if (mine === ticket) {
          const text = "Search is not available here. It works on the built site.";
          message(text);
          say(text);
        }
      }
    };

    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        run(input.value);
      }, 120);
    });

    // Real focus moves through the result links: Down from the input enters the list,
    // Up from the first result returns to the input, Enter follows a link natively.
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        const first = links()[0];
        if (first) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "Enter") {
        // Stop the dialog form from submitting; follow the top result instead.
        e.preventDefault();
        (async () => {
          if (timer) {
            clearTimeout(timer);
            timer = 0;
            await run(input.value);
          }
          const a = links()[0];
          if (a) window.location.href = a.href;
        })();
      }
    });
    list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = links();
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === "ArrowDown") items[Math.min(i + 1, items.length - 1)].focus();
      else if (i === 0) input.focus();
      else items[i - 1].focus();
    });

    dialog.addEventListener("click", (e) => {
      const r = dialog.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (outside) dialog.close();
    });

    let opener = null;
    const open = () => {
      if (dialog.open) return;
      opener = document.activeElement;
      dialog.showModal();
      input.focus();
      input.select();
      load().catch(() => {});
    };
    dialog.addEventListener("close", () => {
      if (opener && typeof opener.focus === "function") opener.focus();
    });

    $$("[data-search-open]").forEach((b) => b.addEventListener("click", open));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const typing =
        t instanceof Element && (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable);
      if (typing || dialog.open) return;
      e.preventDefault();
      open();
    });
  });

  /* Run every feature in its own guard --------------------------------- */
  const start = () => {
    features.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error("site.js feature failed:", err);
      }
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
