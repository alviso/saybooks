// saybooks.io public pages: a signed-in visitor sees their own books instead of the demo.
// Only buttons change; links in text and cards keep their meaning.
(function () {
  fetch('/api/whoami', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.user) return;
    var sp = d.spaces || [];
    var by = function (k) { return sp.find(function (s) { return (s.kind || null) === k; }); };
    var full = by(null), solo = by('solo'), hunt = by('hunt'), first = sp[0];
    var open = function (s) { return '/app?ws=' + encodeURIComponent(s.ws); };
    document.querySelectorAll('a.btn[href="/auth/google"]').forEach(function (a) {
      a.textContent = 'Open my books'; a.href = first ? open(first) : '/app';
    });
    document.querySelectorAll('a.btn.solid[href="/app?demo=1"]').forEach(function (a) {
      a.textContent = 'Open my books'; a.href = first ? open(first) : '/app';
    });
    document.querySelectorAll('a.btn.line[href="/app?demo=1"]').forEach(function (a) { a.textContent = 'Try the demo'; });
    document.querySelectorAll('a.start[href="/app?demo=1"]').forEach(function (a) {
      if (!full) return; a.href = open(full); var g = a.querySelector('.go'); if (g) g.textContent = 'Open my books →';
    });
    document.querySelectorAll('a[href="/auth/google?next=solo"],a.start[href="/solo"]').forEach(function (a) {
      if (!solo) return; a.href = open(solo); var g = a.querySelector('.go'); if (g) g.textContent = 'Open my invoices →'; else a.textContent = 'Open my invoices';
    });
    document.querySelectorAll('a[href="/auth/google?next=hunt"],a.start[href="/hunt"]').forEach(function (a) {
      if (!hunt) return; a.href = open(hunt); var g = a.querySelector('.go'); if (g) g.textContent = 'Open my hunt →'; else a.textContent = 'Open my hunt';
    });
    document.querySelectorAll('.fine[data-who]').forEach(function (f) {
      f.innerHTML = 'Signed in as ' + String(d.user.email).replace(/[<>&]/g, '') + ' · <a href="/auth/logout" style="color:inherit">sign out</a>';
    });
  }).catch(function () {});
})();
