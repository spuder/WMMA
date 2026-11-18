// Scroll reveals, nav hairline, copy buttons, and the self-swiping review card in the hero.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

(() => {
  const els = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
  );
  els.forEach((el) => {
    // Stagger siblings (hero lines, cards) slightly.
    const i = [...el.parentElement.children].filter((c) => c.classList.contains('reveal')).indexOf(el);
    el.style.transitionDelay = `${Math.min(i, 5) * 70}ms`;
    io.observe(el);
  });
})();

(() => {
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
})();

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy)?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = label), 1500);
  });
});

// Hero phone: accept a card every few seconds, the way the Review screen works.
(() => {
  const card = document.querySelector('[data-card]');
  if (!card || reduceMotion) return;
  const q = (s) => card.querySelector(s);
  const left = document.querySelector('[data-left]');
  const progress = document.querySelector('[data-progress]');
  const queue = [
    { payee: 'Trader Joe’s', meta: 'Oct 14 · Rewards Card', amount: '−$64.82', cat: 'Food › Groceries', stamp: 'Groceries', conf: 86 },
    { payee: 'Adobe', meta: 'Oct 13 · Studio Checking', amount: '−$59.99', cat: 'Studio LLC › Software', stamp: 'Software', conf: 82 },
    { payee: 'Delta Air Lines', meta: 'Oct 12 · Rewards Card', amount: '−$318.40', cat: 'Studio LLC › Travel', stamp: 'Travel', conf: 74 },
    { payee: 'City Water', meta: 'Oct 11 · Everyday Checking', amount: '−$71.16', cat: 'Housing › Utilities', stamp: 'Utilities', conf: 88 },
    { payee: 'Blue Bottle', meta: 'Oct 10 · Rewards Card', amount: '−$6.50', cat: 'Food › Coffee', stamp: 'Coffee', conf: 79 },
    { payee: 'Tenant · Unit B', meta: 'Oct 9 · Rental Checking', amount: '+$1,450.00', cat: 'Rental › Rents received', stamp: 'Rent', conf: 85 },
    { payee: 'Home Depot', meta: 'Oct 8 · Rewards Card', amount: '−$112.37', cat: 'Rental › Repairs', stamp: 'Repairs', conf: 71 },
  ];
  const total = 10;
  let i = 0;
  let visible = true;

  const show = (t, n) => {
    q('[data-payee]').textContent = t.payee;
    q('[data-meta]').textContent = t.meta;
    q('[data-amount]').textContent = t.amount;
    q('[data-cat]').textContent = t.cat;
    q('[data-stamp]').textContent = t.stamp;
    q('[data-conf]').style.width = `${t.conf}%`;
    left.textContent = String(n);
    progress.style.width = `${((total - n) / total) * 100}%`;
  };

  const step = () => {
    if (!visible || document.hidden) return;
    card.classList.add('stamped');
    setTimeout(() => card.classList.add('swipe'), 420);
    setTimeout(() => {
      i = (i + 1) % queue.length;
      show(queue[i], queue.length - i);
      card.classList.remove('stamped', 'swipe');
      card.classList.add('enter');
      void card.offsetWidth; // restart the transition from the stacked position
      card.classList.remove('enter');
    }, 980);
  };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(card);
  }
  show(queue[0], queue.length);
  setInterval(step, 3200);
})();
