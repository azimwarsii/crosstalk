// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var t = 'light';
  try {
    t = localStorage.getItem('crosstalk.theme') || 'light';
  } catch (e) { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', t);
})();
