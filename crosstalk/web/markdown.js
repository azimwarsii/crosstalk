// Minimal, safe markdown. Everything is HTML-escaped first; only these come back as markup:
// ```code blocks```, `code`, **bold**, *italic*, ~~strike~~, > quotes, - lists, # headings,
// [text](https://link), bare https:// links, and @mentions.
(function () {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inlineText(t) {
    let h = esc(t);
    // Links become placeholders first so later rules can't touch the URL inside href="…".
    const links = [];
    const hold = (html) => `\u0000${links.push(html) - 1}\u0000`;
    h = h.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_, text, url) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`));
    h = h.replace(/\bhttps?:\/\/[^\s<\u0000]+[^\s<.,;:!?)\]'"\u0000]/g, (match) => {
      // Escaped quotes/brackets right after a URL are not part of it.
      const [, u, tail = ''] = match.match(/^(.*?)((?:&quot|&#39|&gt|&lt)+)?$/);
      return hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`) + tail;
    });
    h = h.replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^(\s*)[-*] /gm, '$1• ');
    h = h.replace(/^&gt; ?(.*)$/gm, '<div class="quote">$1</div>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    h = h.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    h = h.replace(/(^|[^\w@./&;#])@([a-z0-9][a-z0-9_-]{1,31})/gi, '$1<span class="mention" data-handle="$2">@$2</span>');
    h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
    return h.replace(/\n/g, '<br>').replace(/<\/div><br>/g, '</div>');
  }

  function inline(t) {
    return t
      .split(/(`[^`\n]+`)/)
      .map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : inlineText(part)))
      .join('');
  }

  window.renderMarkdown = function (src) {
    return String(src ?? '')
      .replace(/\u0000/g, '')
      .split('```')
      .map((part, i) => {
        if (i % 2 === 0) return inline(part.replace(/^\n/, '').replace(/\n$/, ''));
        const nl = part.indexOf('\n');
        const first = nl >= 0 ? part.slice(0, nl).trim() : '';
        const code = nl >= 0 && /^[\w+#.-]*$/.test(first) ? part.slice(nl + 1) : part;
        return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      })
      .join('');
  };
  window.escapeHtml = esc;
})();
