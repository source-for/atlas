// Source For Atlas home page (CLA-269): filters and re-sorts the server-rendered directory in place.
// Plain ES, no build step, no dependencies; loaded with `defer` from the edge-rendered home
// (apps/web/src/homePage.ts), so the CSP's `script-src 'self'` covers it. Without it the GET form still
// works: the server renders every card in the chosen order and marks non-matches `hidden`, so this script
// only ever shows/hides and reorders cards that are already in the page (and can widen a filtered view).
//
// The matching rule mirrors homePage.ts (normalizeHomeQuery + homeCardMatches): control characters become
// spaces, bidi/invisible characters are dropped (U+200C/U+200D are kept: they hold emoji sequences together),
// trimmed, at most 100 code points; then, case-insensitively, a substring of a line of the card's `data-search`
// (its names) or a word start in a line of its `data-search-words` (description, language). Ranks for each sort
// come from the server (`data-rank-recent`, `data-rank-az`), so the order rules live in one place.
// Written with \u escapes only: the file holds no raw bidi or zero-width characters.
// It also asks /api/auth/me once and, only when sign-in is configured, fills the header's sign-in slot and
// shows the cookie notice unless it was dismissed (CLA-316; initAuth and initCookieNotice below).
(function (root) {
  'use strict';

  var QUERY_MAX = 100;
  var SORTS = ['recent', 'az'];

  var INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
  // A letter, combining mark or digit (a match right after one is inside a word). Built at run time so an engine
  // without Unicode property escapes gets null (and init bails) instead of a syntax error.
  var WORD_CHAR = (function () {
    try { return new RegExp('[\\p{L}\\p{M}\\p{N}]', 'u'); } catch (_) { return null; }
  })();

  function codePoints(text) {
    var out = [];
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out.push(text.charAt(i) + text.charAt(i + 1));
          i += 1;
          continue;
        }
      }
      out.push(text.charAt(i));
    }
    return out;
  }

  function normalizeQuery(value) {
    if (typeof value !== 'string') return '';
    var text = value
      .replace(INVISIBLE, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();
    return codePoints(text).slice(0, QUERY_MAX).join('').trim();
  }

  function sortFrom(value) {
    return value === 'az' ? 'az' : 'recent';
  }

  // `needle` at the start of `field` or right after a character that is not a letter or digit (camelCase inside
  // a word is not a boundary).
  function matchesAtWordStart(field, needle) {
    for (var at = field.indexOf(needle); at !== -1; at = field.indexOf(needle, at + 1)) {
      if (at === 0 || !WORD_CHAR || !WORD_CHAR.test(field.charAt(at - 1))) return true;
    }
    return false;
  }

  // `search`: the card's names, one per line (substring); `words`: its description and language (word start).
  function matches(search, words, query) {
    var needle = query.toLowerCase();
    if (!needle) return true;
    var names = String(search || '').split('\n');
    for (var i = 0; i < names.length; i += 1) {
      if (names[i].indexOf(needle) !== -1) return true;
    }
    var text = words ? String(words).split('\n') : [];
    for (var j = 0; j < text.length; j += 1) {
      if (matchesAtWordStart(text[j], needle)) return true;
    }
    return false;
  }

  function countText(shown, total, filtered) {
    var noun = total === 1 ? 'atlas' : 'atlases';
    return filtered ? shown + ' of ' + total + ' ' + noun : total + ' ' + noun;
  }

  // `search` with q and sort set, in that order after any other params (defaults dropped: no q when empty,
  // no sort when `recent`).
  function searchFor(search, query, sort) {
    var params = new URLSearchParams(search);
    params.delete('q');
    params.delete('sort');
    if (query) params.append('q', query);
    if (sort !== 'recent') params.append('sort', sort);
    var text = params.toString();
    return text ? '?' + text : '';
  }

  // The view for a list of card records ({ search, recent, az }): which are shown, in what order.
  function view(cards, query, sort) {
    var key = sort === 'az' ? 'az' : 'recent';
    var order = cards.slice().sort(function (a, b) { return a[key] - b[key]; });
    var shown = 0;
    var visible = order.map(function (card) {
      var hit = matches(card.search, card.words, query);
      if (hit) shown += 1;
      return hit;
    });
    return { order: order, visible: visible, shown: shown };
  }

  // Everything init and the helpers use. An older engine missing any of it keeps the plain GET form: init bails
  // before it attaches a listener, so no submit is ever prevented.
  function supported(doc) {
    return Boolean(
      doc && typeof doc.querySelector === 'function' && typeof doc.querySelectorAll === 'function' &&
      typeof Array.prototype.forEach === 'function' && typeof Array.prototype.map === 'function' &&
      typeof Array.prototype.slice === 'function' && typeof String.prototype.trim === 'function' &&
      typeof URLSearchParams === 'function' && WORD_CHAR
    );
  }

  // The URL follows the view after typing pauses this long (one history entry rewrite, not one per keystroke).
  var URL_DELAY_MS = 250;

  function init(doc, win) {
    if (!supported(doc)) return undefined;
    var form = doc.querySelector('[data-home-search]');
    var list = doc.querySelector('.atlases');
    if (!form || !list || typeof form.addEventListener !== 'function' || typeof list.querySelectorAll !== 'function') return undefined;
    var input = form.querySelector('input[name="q"]');
    var select = form.querySelector('select[name="sort"]');
    var count = doc.querySelector('[data-home-count]');
    var empty = doc.querySelector('[data-home-no-match]');
    var echo = doc.querySelector('[data-home-query]');
    var items = Array.prototype.slice.call(list.querySelectorAll('.atlas'));
    var cards = items.map(function (item) {
      return {
        item: item,
        search: item.getAttribute('data-search') || '',
        words: item.getAttribute('data-search-words') || '',
        recent: Number(item.getAttribute('data-rank-recent')),
        az: Number(item.getAttribute('data-rank-az')),
      };
    });
    var lastSort;
    var canReplace = Boolean(win && win.history && typeof win.history.replaceState === 'function' && win.location);
    var canTime = Boolean(win && typeof win.setTimeout === 'function' && typeof win.clearTimeout === 'function');
    var timer;
    var wanted;

    function writeUrl() {
      timer = undefined;
      if (!canReplace || !wanted) return;
      var location = win.location;
      var target = location.pathname + searchFor(location.search, wanted.query, wanted.sort) + location.hash;
      if (target !== location.pathname + location.search + location.hash) {
        try { win.history.replaceState(win.history.state, '', target); } catch (_) { /* sandboxed frames */ }
      }
    }

    function syncUrl(query, sort, now) {
      wanted = { query: query, sort: sort };
      if (timer !== undefined) win.clearTimeout(timer);
      if (now || !canTime) writeUrl();
      else timer = win.setTimeout(writeUrl, URL_DELAY_MS);
    }

    function update(now) {
      var query = normalizeQuery(input ? input.value : '');
      var sort = sortFrom(select ? select.value : 'recent');
      var next = view(cards, query, sort);
      if (sort !== lastSort) {
        for (var i = 0; i < next.order.length; i += 1) list.appendChild(next.order[i].item);
        lastSort = sort;
      }
      for (var j = 0; j < next.order.length; j += 1) next.order[j].item.hidden = !next.visible[j];
      if (count) count.textContent = countText(next.shown, cards.length, query !== '');
      if (empty) empty.hidden = next.shown !== 0;
      if (echo) echo.textContent = query;
      syncUrl(query, sort, now === true);
      return next;
    }

    if (input) input.addEventListener('input', function () { update(false); });
    if (select) select.addEventListener('change', function () { update(false); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      update(true);
    });
    // Once up front: the browser may have restored a different select value (back/forward), and the URL
    // drops defaults and unknown sorts.
    update(false);
    return { update: update };
  }

  // ---- Sign-in slot (CLA-316) ----
  // The header's `[data-auth-slot]` is hidden and empty in the (shared-cached) HTML. When /api/auth/me says
  // sign-in is configured (`oauthConfigured: true`), it shows "Sign in with GitHub", or "@login · Account ·
  // Sign out" when signed in. Accounts off, a failed request or no fetch: the slot stays hidden. The same answer
  // gates the cookie notice (no second request).
  var AUTH_ME_PATH = '/api/auth/me';

  // A same-origin path from /api/auth/me, else the fallback (never `//host` or a scheme).
  function localPath(value, fallback) {
    return typeof value === 'string' && /^\/(?![\/\\])[^\s]*$/.test(value) ? value : fallback;
  }

  // The links for an /api/auth/me answer ({ text, href? } in order), or null when there is nothing to show.
  function authLinks(me) {
    if (!me || typeof me !== 'object' || me.oauthConfigured !== true) return null;
    if (me.authenticated === true && typeof me.login === 'string' && me.login) {
      return [
        { text: '@' + me.login },
        { text: 'Account', href: localPath(me.accountPath, '/account') },
        { text: 'Sign out', href: localPath(me.logoutPath, '/api/auth/logout') + '?return=/' },
      ];
    }
    return [{ text: 'Sign in with GitHub', href: localPath(me.loginPath, '/api/auth/github') + '?return=/' }];
  }

  function renderAuth(doc, slot, links) {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    for (var i = 0; i < links.length; i += 1) {
      if (i > 0) {
        var separator = doc.createElement('span');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '\u00b7';
        slot.appendChild(separator);
      }
      var link = links[i];
      var node = doc.createElement(link.href ? 'a' : 'span');
      if (link.href) node.setAttribute('href', link.href);
      else node.setAttribute('class', 'login');
      node.textContent = link.text;
      slot.appendChild(node);
    }
    slot.hidden = false;
  }

  // Resolves to the links shown (or null). Asks only when the page has a slot or a notice to fill.
  function initAuth(doc, win) {
    if (!doc || typeof doc.querySelector !== 'function' || typeof doc.createElement !== 'function') return undefined;
    var slot = doc.querySelector('[data-auth-slot]');
    var notice = doc.querySelector('[data-cookie-notice]');
    if ((!slot && !notice) || !win || typeof win.fetch !== 'function') return undefined;
    var request;
    try {
      request = win.fetch(AUTH_ME_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    } catch (_) {
      return undefined;
    }
    return Promise.resolve(request)
      .then(function (response) { return response && response.ok ? response.json() : null; })
      .then(function (me) {
        var links = slot ? authLinks(me) : null;
        if (links) renderAuth(doc, slot, links);
        initCookieNotice(doc, win, me);
        return links;
      })
      .catch(function () { return null; });
  }

  // ---- Cookie notice (CLA-316) ----
  // `[data-cookie-notice]` ships `hidden`: shown only when the /api/auth/me answer says sign-in is configured
  // (the cookies it describes can then be set; anything else, including no answer, keeps it hidden), and
  // unless localStorage says it was dismissed. OK hides it and
  // remembers that (`sf.cookieNotice.dismissed=1`). Storage that throws (blocked, private mode) = show it, and
  // OK still hides it for this page.
  var COOKIE_NOTICE_KEY = 'sf.cookieNotice.dismissed';
  // CLA-610: inline copy of src/browserStorage.ts's contract (home.js is not bundled, so it cannot import it);
  // homeScript.test.ts runs the same parity cases against both. A dismissal that storage refused is remembered
  // for this window only (gone on reload); a later successful write hands back to real storage.
  var dismissedThisPage = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function noticeDismissed(win) {
    if (win && dismissedThisPage && dismissedThisPage.get(win)) return true;
    try { return Boolean(win && win.localStorage && win.localStorage.getItem(COOKIE_NOTICE_KEY) === '1'); } catch (_) { return false; }
  }

  function rememberNoticeDismissed(win) {
    try { if (win && win.localStorage) { win.localStorage.setItem(COOKIE_NOTICE_KEY, '1'); if (dismissedThisPage) dismissedThisPage.delete(win); return; } } catch (_) { /* this page only */ }
    if (win && dismissedThisPage) dismissedThisPage.set(win, true);
  }

  // Whether an /api/auth/me answer allows the notice: only `oauthConfigured: true` (fail closed).
  function cookieNoticeAllowed(me) {
    return Boolean(me && typeof me === 'object' && me.oauthConfigured === true);
  }

  function initCookieNotice(doc, win, me) {
    if (!cookieNoticeAllowed(me) || !doc || typeof doc.querySelector !== 'function') return undefined;
    var notice = doc.querySelector('[data-cookie-notice]');
    if (!notice || typeof notice.querySelector !== 'function' || noticeDismissed(win)) return undefined;
    var button = notice.querySelector('[data-cookie-notice-dismiss]');
    if (!button || typeof button.addEventListener !== 'function') return undefined;
    notice.hidden = false;
    if (doc.body && doc.body.classList) doc.body.classList.add('has-cookie-notice');
    button.addEventListener('click', function () {
      notice.hidden = true;
      if (doc.body && doc.body.classList) doc.body.classList.remove('has-cookie-notice');
      rememberNoticeDismissed(win);
    });
    return notice;
  }

  var api = { COOKIE_NOTICE_KEY: COOKIE_NOTICE_KEY, noticeDismissed: noticeDismissed, rememberNoticeDismissed: rememberNoticeDismissed, cookieNoticeAllowed: cookieNoticeAllowed, initCookieNotice: initCookieNotice, AUTH_ME_PATH: AUTH_ME_PATH, authLinks: authLinks, initAuth: initAuth, QUERY_MAX: QUERY_MAX, SORTS: SORTS, URL_DELAY_MS: URL_DELAY_MS, supported: supported, matchesAtWordStart: matchesAtWordStart, normalizeQuery: normalizeQuery, sortFrom: sortFrom, matches: matches, countText: countText, searchFor: searchFor, view: view, init: init };
  // Tests evaluate this file with a `module` in scope; the browser has none and just runs it.
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root.document) {
    init(root.document, root);
    initAuth(root.document, root);
  }
})(typeof window !== 'undefined' ? window : this);
