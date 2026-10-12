"use client";

import { useEffect } from "react";

const EASE = "cubic-bezier(.2,.8,.2,1)";
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

type Flagged = HTMLElement & { _init?: boolean; _played?: boolean };

function playIntro(hero: HTMLElement) {
  let ci = 0;
  hero.querySelectorAll<HTMLElement>("[data-w] > span").forEach((s) => {
    const dx = (Math.random() - 0.5) * 160;
    const dy = -40 - Math.random() * 60;
    const r = (Math.random() - 0.5) * 50;
    s.animate(
      [
        { opacity: 0, transform: `translate(${dx}px,${dy}px) rotate(${r}deg)`, filter: "blur(6px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 900, delay: 80 + ci * 28, easing: EASE, fill: "backwards" },
    );
    ci++;
  });
  hero.querySelectorAll<HTMLElement>("[data-card]").forEach((el, i) =>
    el.animate(
      [{ opacity: 0, transform: "translateY(-60px) scale(0.9)" }, { opacity: 1, transform: "none" }],
      { duration: 900, delay: 2000 + i * 120, easing: EASE, fill: "backwards" },
    ),
  );
  hero.querySelectorAll<HTMLElement>("[data-fade]").forEach((el, i) =>
    el.animate(
      [{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }],
      { duration: 800, delay: 800 + i * 150, easing: EASE, fill: "backwards" },
    ),
  );
  hero.querySelector<HTMLElement>("[data-phone]")?.animate(
    [
      { opacity: 0, transform: "translateX(-50%) translateY(-720px)" },
      { opacity: 1, offset: 0.25 },
      { opacity: 1, transform: "translateX(-50%) translateY(0)" },
    ],
    { duration: 1400, delay: 900, easing: "cubic-bezier(.3,.9,.25,1)", fill: "backwards" },
  );
  // Animations above hold their "from" frame via fill: backwards, so it's safe
  // to drop the CSS that kept these elements hidden until hydration.
  hero.dataset.intro = "done";
}

function setupScroll(page: HTMLElement, hero: HTMLElement) {
  const scrollEls = [...page.querySelectorAll<Flagged>("[data-scroll]")];
  const sides = [...hero.querySelectorAll<HTMLElement>("[data-side]")];

  const onScroll = () => {
    const vh = window.innerHeight;
    const p = clamp(-hero.getBoundingClientRect().top / 700);
    sides.forEach((el) => {
      const dir = el.dataset.side === "l" ? 1 : -1;
      el.style.translate = `${dir * p * 260}px ${-p * 90}px`;
    });

    scrollEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      const k = el.dataset.scroll;
      if (k === "tilt") {
        const c = (r.top + r.height / 2 - vh / 2) / (vh / 2);
        const m = Math.max(0, Math.abs(c) - 0.25) / 0.75;
        const a = Math.sign(c) * Math.min(1, m) * (c < 0 ? 60 : 40);
        el.style.transform = `rotateX(${a}deg)`;
        const pop = el.querySelector<HTMLElement>("[data-pop]");
        if (pop) pop.style.rotate = `${-8 * clamp((0.55 - r.top / vh) / 0.45)}deg`;
      } else if (k === "tile") {
        const i = Number(el.dataset.i) || 0;
        const col = i % 3;
        const lin = clamp((r.top / vh - 0.45) / 0.35);
        const q = lin * lin * (3 - 2 * lin);
        const ry = [4, 2, -10][col] ?? 0;
        const rz = [4, 7, 6, -3, -4, -5][i] || 0;
        const c = el.firstElementChild as HTMLElement;
        c.style.transform = `perspective(1000px) rotateY(${ry * q}deg) rotateZ(${rz * q}deg) scale(${1 - q * 0.26})`;
        c.style.borderColor = q > 0.02 ? "#e4e2f0" : "#d1cee4";
        c.style.boxShadow = q > 0.02 ? `0 ${12 * q}px ${30 * q}px rgba(26,12,48,${0.1 * q})` : "none";
      } else if (k === "phone") {
        const pr = (el.parentNode as HTMLElement).getBoundingClientRect();
        if (!el._init) {
          el._init = true;
          el.style.transform = "perspective(1400px) translateX(430px) rotateY(-90deg)";
          el.style.opacity = "0";
        }
        if (!el._played && pr.top < vh * 0.58) {
          el._played = true;
          el.animate(
            [
              { transform: "perspective(1400px) translateX(430px) rotateY(-90deg)", opacity: 0 },
              { transform: "perspective(1400px) translateX(240px) rotateY(-60deg)", opacity: 1, offset: 0.3 },
              { transform: "perspective(1400px) translateX(-20px) rotateY(8deg)", opacity: 1, offset: 0.8 },
              { transform: "perspective(1400px) translateX(0px) rotateY(0deg)", opacity: 1 },
            ],
            { duration: 900, easing: "cubic-bezier(.25,.8,.3,1)", fill: "forwards" },
          );
        }
      } else {
        const d = k === "left" ? -1 : 1;
        const lag = k === "right" ? vh * 0.12 : 0;
        const q = 1 - easeOut(clamp((vh - r.top - lag) / (vh * 0.7)));
        el.style.transform = `translateX(${d * q * 280}px) translateY(${q * 80}px) rotateY(${-d * q * 10}deg) rotateZ(${d * q * 8}deg) scale(${1 + q * 0.05})`;
        el.style.opacity = String(1 - q * 0.95);
      }
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  const observers: IntersectionObserver[] = [];
  const anims: Animation[] = [];

  // Fire `fn` the first time `el` crosses `threshold`.
  const once = (el: Element, fn: () => void, threshold = 0.4) => {
    const o = new IntersectionObserver(
      (es) => {
        if (es[0]?.isIntersecting) {
          o.disconnect();
          fn();
        }
      },
      { threshold },
    );
    o.observe(el);
    observers.push(o);
  };

  // Fire `fn` every time `el` re-enters past `th` after fully leaving.
  const replay = (el: Element, fn: () => void, th = 0.5) => {
    let armed = true;
    const o = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.intersectionRatio >= th && armed) {
            armed = false;
            fn();
          } else if (!e.isIntersecting) armed = true;
        }),
      { threshold: [0, th] },
    );
    o.observe(el);
    observers.push(o);
  };

  page.querySelectorAll<HTMLElement>("[data-type]").forEach((h2) => {
    const chars = [...h2.querySelectorAll<HTMLElement>("[data-ch]")];
    const para = h2.parentNode?.querySelector<HTMLElement>("[data-tp]");
    once(h2, () => {
      chars.forEach((s, i) =>
        s.animate(
          [{ opacity: 0, color: "#c4c4c4" }, { opacity: 1, color: "#c4c4c4", offset: 0.3 }, { opacity: 1, color: "#0e100f" }],
          { duration: 420, delay: i * 55, fill: "forwards", easing: "ease-out" },
        ),
      );
      para?.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], {
        duration: 800,
        delay: 200,
        fill: "forwards",
        easing: "ease-out",
      });
    });
  });

  page.querySelectorAll<SVGPathElement>("[data-draw]").forEach((path) => {
    const L = path.getTotalLength();
    path.style.strokeDasharray = String(L);
    path.style.strokeDashoffset = String(L);
    once(
      path.closest("[data-scroll]") || path,
      () =>
        path.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], {
          duration: 1600,
          delay: 300,
          fill: "forwards",
          easing: "cubic-bezier(.3,.7,.2,1)",
        }),
      0.5,
    );
  });

  page.querySelectorAll<HTMLElement>("[data-bar]").forEach((b, i) =>
    once(
      b,
      () =>
        b.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
          duration: 1100,
          delay: 300 + i * 150,
          fill: "backwards",
          easing: "cubic-bezier(.3,.8,.2,1)",
        }),
      0.3,
    ),
  );

  page.querySelectorAll<HTMLElement>("[data-bar-x]").forEach((b) =>
    once(
      b,
      () =>
        b.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
          duration: 1200,
          delay: 400,
          fill: "backwards",
          easing: "cubic-bezier(.3,.8,.2,1)",
        }),
      0.3,
    ),
  );

  page.querySelectorAll<HTMLElement>("[data-pop]").forEach((b) =>
    once(
      b,
      () =>
        b.animate([{ opacity: 0, transform: "translateY(30px) scale(0.92)" }, { opacity: 1, transform: "none" }], {
          duration: 900,
          delay: 250,
          fill: "backwards",
          easing: EASE,
        }),
      0.3,
    ),
  );

  page.querySelectorAll<HTMLElement>("[data-up]").forEach((c) => {
    once(c, () =>
      c.animate([{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], {
        duration: 900,
        delay: Number(c.dataset.d || 0),
        fill: "forwards",
        easing: EASE,
      }),
    );
  });

  const prism = page.querySelector<HTMLElement>("[data-prism]");
  if (prism) {
    anims.push(
      prism.animate(
        [
          { transform: "rotateX(0deg)" },
          { transform: "rotateX(0deg)", offset: 0.15 },
          { transform: "rotateX(90deg)", offset: 0.25 },
          { transform: "rotateX(90deg)", offset: 0.4 },
          { transform: "rotateX(180deg)", offset: 0.5 },
          { transform: "rotateX(180deg)", offset: 0.65 },
          { transform: "rotateX(270deg)", offset: 0.75 },
          { transform: "rotateX(270deg)", offset: 0.9 },
          { transform: "rotateX(360deg)" },
        ],
        { duration: 12000, iterations: Infinity, easing: "linear" },
      ),
    );
  }

  page.querySelectorAll<HTMLElement>("[data-rise]").forEach((c, i) => {
    once(
      c,
      () =>
        c.animate([{ opacity: 0, transform: "translateY(50px)" }, { opacity: 1, transform: "none" }], {
          duration: 900,
          delay: i * 120,
          fill: "forwards",
          easing: EASE,
        }),
      0.25,
    );
  });

  page.querySelectorAll<HTMLElement>("[data-roll]").forEach((el) => {
    const cols = [...el.querySelectorAll<HTMLElement>("[data-roll-col]")];
    replay(
      el.closest("[data-stat-card]") || el,
      () =>
        cols.forEach((col) => {
          const n = Number(col.dataset.rollCol);
          const di = Number(col.dataset.di);
          col.animate([{ transform: "translateY(0)" }, { transform: `translateY(-${n}em)` }], {
            duration: 2000 + di * 300,
            easing: "cubic-bezier(.2,.65,.15,1)",
            fill: "both",
          });
        }),
      0.35,
    );
  });

  page.querySelectorAll<HTMLElement>("[data-pill]").forEach((p) =>
    replay(
      p,
      () => {
        p.animate([{ clipPath: "inset(0 100% 0 0 round 999px)" }, { clipPath: "inset(0 0 0 0 round 999px)" }], {
          duration: 900,
          easing: "cubic-bezier(.3,.7,.2,1)",
          fill: "both",
        });
        p.firstElementChild?.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], {
          duration: 500,
          delay: 300,
          fill: "both",
        });
      },
      0.3,
    ),
  );

  page.querySelectorAll<HTMLElement>("[data-fade]").forEach((d) =>
    replay(
      d,
      () =>
        d.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
          duration: 700,
          delay: 600,
          easing: "ease-out",
          fill: "both",
        }),
      0.3,
    ),
  );

  let rafs: number[] = [];
  page.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count!);
    const dec = Number(el.dataset.dec || 0);
    once(
      el,
      () => {
        const t0 = performance.now();
        const dur = 1600;
        const tick = (now: number) => {
          const t = clamp((now - t0) / dur);
          el.textContent = (target * easeOut(t)).toFixed(dec);
          if (t < 1) rafs.push(requestAnimationFrame(tick));
        };
        rafs.push(requestAnimationFrame(tick));
      },
      0.5,
    );
  });

  const mq = page.querySelector<HTMLElement>("[data-marquee]");
  if (mq) {
    anims.push(mq.animate([{ transform: "translateX(0)" }, { transform: "translateX(-50%)" }], { duration: 40000, iterations: Infinity }));
  }

  return () => {
    anims.forEach((a) => a.cancel());
    rafs.forEach(cancelAnimationFrame);
    rafs = [];
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    observers.forEach((o) => o.disconnect());
  };
}

/** Wires up the intro and scroll-driven animations for the landing page under `#landing`. */
export default function LandingAnimations() {
  useEffect(() => {
    const page = document.getElementById("landing");
    const hero = page?.querySelector<HTMLElement>("[data-intro]");
    if (!page || !hero) return;
    const cleanup = setupScroll(page, hero);
    if (hero.dataset.intro === "pending") playIntro(hero);
    return cleanup;
  }, []);

  return null;
}
