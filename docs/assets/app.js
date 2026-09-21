/* Vermont high school football video archive.
 *
 * Everything renders from docs/data/games.json, which scripts/fetch_games.py
 * builds from NSN's broadcast API. Routing is hash-based so the whole thing
 * works as flat files on GitHub Pages with no server and no build step.
 *
 * Routes:  #/timeline  #/schools  #/school/<slug>  #/game/<id>
 */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var data = null;          // { games: [...] }
  var bySlug = null;        // slug -> { name, slug, games }

  /* ---- backend ---------------------------------------------------------
   * The same files are served from GitHub Pages, which has no functions. Every
   * call here resolves to null there, and the UI hides the features that need
   * them rather than showing errors. */

  var API_ALIVE = null;   // null = not yet probed, then true/false

  async function api(path, opts) {
    try {
      var res = await fetch('/api/' + path, Object.assign({
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      }, opts || {}));
      // Pages serves its 404 page for these; anything non-JSON means no backend.
      var type = res.headers.get('content-type') || '';
      if (res.status === 404 && type.indexOf('json') === -1) { API_ALIVE = false; return null; }
      API_ALIVE = true;
      var body = type.indexOf('json') !== -1 ? await res.json() : null;
      return { ok: res.ok, status: res.status, body: body };
    } catch (_) {
      API_ALIVE = false;
      return null;
    }
  }

  function secsToClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  /** "1:02:03" / "12:34" / "754" -> seconds, or null. */
  function clockToSecs(text) {
    var t = String(text).trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    var parts = t.split(':').map(Number);
    if (parts.some(function (n) { return !Number.isFinite(n) || n < 0; })) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  /* ---- helpers ------------------------------------------------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Broadcast times are stored in UTC; NSN schedules them in Eastern time, so
  // format in that zone to keep a 7pm Friday kickoff on Friday.
  var DATE_FMT = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York'
  });
  var TIME_FMT = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
  });

  function fmtDate(iso) { return DATE_FMT.format(new Date(iso)); }
  function fmtTime(iso) { return TIME_FMT.format(new Date(iso)) + ' ET'; }

  function matchupText(g) {
    return g.teams.length === 2 ? g.away + ' at ' + g.home : g.title;
  }

  function isUpcoming(g) { return new Date(g.date).getTime() > Date.now(); }

  function badges(g) {
    var out = [];
    if (isUpcoming(g)) out.push(el('span', { class: 'badge upcoming', text: 'Upcoming' }));
    if (g.round) out.push(el('span', { class: 'badge playoff', text: g.round }));
    if (g.part) out.push(el('span', { class: 'badge part', text: 'Part ' + g.part }));
    return out;
  }

  /* ---- reusable pieces ----------------------------------------------- */

  function gameCard(g, opts) {
    opts = opts || {};
    var matchup = el('p', { class: 'matchup' }, [document.createTextNode(matchupText(g))]);
    badges(g).forEach(function (b) { matchup.appendChild(b); });

    var subParts = [fmtDate(g.date), fmtTime(g.date)];
    if (opts.showOpponentOf) {
      var other = g.teams.filter(function (t) { return t !== opts.showOpponentOf; })[0];
      if (other) subParts.unshift((g.home === opts.showOpponentOf ? 'vs ' : 'at ') + other);
    }

    var thumb = g.thumbnail
      ? el('img', {
          class: 'thumb', src: g.thumbnail, alt: '', loading: 'lazy', decoding: 'async'
        })
      : el('div', { class: 'thumb' });

    // The card is a <li>, not an <a>: it holds two links, and an <a> cannot be
    // nested inside another. The matchup link is "stretched" over the whole card
    // via ::after so the card still clicks through to the game page, and the NSN
    // link sits above it.
    var title = el('a', { class: 'game-link', href: '#/game/' + g.id }, [matchup]);

    return el('li', { class: 'game' }, [
      thumb,
      el('span', { class: 'meta' }, [title, el('p', { class: 'sub', text: subParts.join(' · ') })]),
      nsnLink(g, 'NSN ↗', 'card-nsn')
    ]);
  }

  /* An outbound link to NSN's own page for a broadcast.
   *
   * Deliberately rel="noopener" and NOT "noreferrer": NSN should be able to see
   * that the visit came from here and attribute it. Their page is also where
   * their display advertising runs, which this site does not reproduce, so
   * sending real traffic there is the point of the link. */
  function nsnLink(g, label, cls) {
    var a = el('a', {
      class: cls, href: g.nsnUrl, target: '_blank', rel: 'noopener',
      title: 'Open this broadcast on nsnsports.net'
    }, [document.createTextNode(label)]);
    // The card behind it navigates to the local game page; this must not.
    a.addEventListener('click', function (ev) { ev.stopPropagation(); });
    return a;
  }

  /** Render games grouped into season sections, newest season first. */
  function seasonSections(games, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();
    if (!games.length) {
      frag.appendChild(el('p', { class: 'empty', text: opts.emptyText || 'No games match that search.' }));
      return frag;
    }
    var seasons = [];
    var groups = {};
    games.forEach(function (g) {
      if (!groups[g.season]) { groups[g.season] = []; seasons.push(g.season); }
      groups[g.season].push(g);
    });
    seasons.sort(function (a, b) { return b - a; });

    seasons.forEach(function (s) {
      var list = el('ul', { class: 'game-list' });
      groups[s].forEach(function (g) { list.appendChild(gameCard(g, opts)); });
      frag.appendChild(el('section', { class: 'season' }, [
        el('h2', { html: s + ' season <span>' + groups[s].length + ' game' + (groups[s].length === 1 ? '' : 's') + '</span>' }),
        list
      ]));
    });
    return frag;
  }

  /* ---- views ---------------------------------------------------------- */

  function timelineView() {
    // Default to games that have actually aired: an upcoming fixture has no
    // video to watch yet, so it does not belong at the top of an archive.
    var state = { q: '', season: 'all', when: 'past' };

    var search = el('input', {
      type: 'search', placeholder: 'Search team, matchup or round…', 'aria-label': 'Search games'
    });

    var whenSel = el('select', { 'aria-label': 'Filter by whether the game has aired' });
    [['past', 'Past games'], ['upcoming', 'Upcoming games'], ['all', 'Past + upcoming']]
      .forEach(function (o) {
        whenSel.appendChild(el('option', { value: o[0], text: o[1] }));
      });
    whenSel.value = state.when;

    var seasonSel = el('select', { 'aria-label': 'Filter by season' });
    seasonSel.appendChild(el('option', { value: 'all', text: 'All seasons' }));
    uniqueSeasons().forEach(function (s) {
      seasonSel.appendChild(el('option', { value: String(s), text: s + ' season' }));
    });

    var count = el('span', { class: 'count' });
    var results = el('div');

    function apply() {
      var q = state.q.trim().toLowerCase();
      var games = data.games.filter(function (g) {
        if (state.when === 'past' && isUpcoming(g)) return false;
        if (state.when === 'upcoming' && !isUpcoming(g)) return false;
        if (state.season !== 'all' && String(g.season) !== state.season) return false;
        if (!q) return true;
        return (g.title + ' ' + g.teams.join(' ') + ' ' + g.round).toLowerCase().indexOf(q) !== -1;
      });
      count.textContent = games.length + ' of ' + data.games.length + ' games';
      results.innerHTML = '';
      results.appendChild(seasonSections(games, { emptyText: emptyTextFor(state) }));
    }

    search.addEventListener('input', function () { state.q = search.value; apply(); });
    whenSel.addEventListener('change', function () { state.when = whenSel.value; apply(); });
    seasonSel.addEventListener('change', function () { state.season = seasonSel.value; apply(); });

    render([
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Game timeline' }),
        el('p', { text: 'Vermont high school football broadcasts from NSN, newest first.' })
      ]),
      el('div', { class: 'controls' }, [search, whenSel, seasonSel, count]),
      results
    ]);
    apply();
  }

  /** Say why the list is empty, rather than always blaming the search box. */
  function emptyTextFor(state) {
    if (state.q.trim()) return 'No games match that search.';
    if (state.when === 'upcoming') return 'No upcoming games are scheduled right now.';
    return 'No games to show.';
  }

  function schoolsView() {
    var schools = Object.keys(bySlug).map(function (s) { return bySlug[s]; });
    schools.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var search = el('input', {
      type: 'search', placeholder: 'Find a school…', 'aria-label': 'Search schools'
    });
    var count = el('span', { class: 'count' });
    var grid = el('ul', { class: 'school-grid' });

    function apply() {
      var q = search.value.trim().toLowerCase();
      var shown = schools.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; });
      count.textContent = shown.length + ' school' + (shown.length === 1 ? '' : 's');
      grid.innerHTML = '';
      if (!shown.length) {
        grid.appendChild(el('li', { class: 'empty', text: 'No schools match that search.' }));
        return;
      }
      shown.forEach(function (s) {
        grid.appendChild(el('li', {}, [
          el('a', { class: 'school-card', href: '#/school/' + s.slug }, [
            el('span', { class: 'name', text: s.name }),
            el('span', { class: 'n', text: s.games.length + ' game' + (s.games.length === 1 ? '' : 's') })
          ])
        ]));
      });
    }

    search.addEventListener('input', apply);

    render([
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Browse by school' }),
        el('p', { text: 'Pick a program to see every one of its broadcasts, season by season.' })
      ]),
      el('div', { class: 'controls' }, [search, count]),
      grid
    ]);
    apply();
  }

  function schoolView(slug) {
    var school = bySlug[slug];
    if (!school) return notFound('No school with that name is in the archive.');

    var seasons = {};
    school.games.forEach(function (g) { seasons[g.season] = true; });
    var spanText = Object.keys(seasons).sort();
    var opponents = {};
    school.games.forEach(function (g) {
      g.teams.forEach(function (t) { if (t !== school.name) opponents[t] = (opponents[t] || 0) + 1; });
    });
    var topOpp = Object.keys(opponents).sort(function (a, b) { return opponents[b] - opponents[a]; }).slice(0, 3);

    var bits = [school.games.length + ' broadcast' + (school.games.length === 1 ? '' : 's')];
    if (spanText.length === 1) bits.push(spanText[0] + ' season');
    else if (spanText.length > 1) bits.push(spanText[0] + '–' + spanText[spanText.length - 1]);
    // A "most often vs" line only says anything once there are a few games.
    if (school.games.length >= 4 && topOpp.length) bits.push('most often vs ' + topOpp.join(', '));

    var head = el('div', { class: 'page-head' }, [
      el('h1', { text: school.name }),
      el('p', { text: bits.join(' · ') })
    ]);

    render([
      el('a', { class: 'back-link', href: '#/schools', text: '← All schools' }),
      head,
      seasonSections(school.games, { showOpponentOf: school.name })
    ]);
  }

  function gameView(id) {
    var g = data.games.filter(function (x) { return x.id === id; })[0];
    if (!g) return notFound('That game is not in the archive.');

    var facts = el('ul', { class: 'detail-facts' }, [
      el('li', { html: '<b>Date</b> ' + fmtDate(g.date) + ', ' + fmtTime(g.date) }),
      el('li', { html: '<b>Season</b> ' + g.season }),
      g.round ? el('li', { html: '<b>Round</b> ' + g.round }) : null,
      g.source ? el('li', { html: '<b>Broadcast by</b> ' + g.source }) : null
    ]);

    var teamLinks = el('p', {}, []);
    g.teams.forEach(function (t, i) {
      if (i) teamLinks.appendChild(document.createTextNode(' · '));
      teamLinks.appendChild(el('a', { href: '#/school/' + slugify(t), text: 'All ' + t + ' games' }));
    });

    // Left column: the player and everything about the broadcast itself.
    var playerSlot = el('div', { class: 'player-slot' });
    var primary = el('div', { class: 'game-primary' }, [
      playerSlot,
      facts,
      g.requiresLogin
        ? el('p', { class: 'note', text: 'NSN requires a subscription or access pass to watch this broadcast.' })
        : null,
      el('p', {}, [nsnLink(g, 'Watch on NSN Sports ↗', 'btn')]),
      teamLinks,
    ]);

    // Right column: marked plays, for signed-in people only. Stays empty (and
    // the grid stays one column) until we know there is something to put in it.
    var side = el('div', { class: 'game-side' });
    var grid = el('div', { class: 'game-grid' }, [primary, side]);

    var kids = [
      el('a', { class: 'back-link', href: backTarget(), text: '← Back' }),
      el('div', { class: 'page-head' }, [
        el('h1', { text: matchupText(g) }),
        el('p', { text: g.title })
      ])
    ];
    if (isUpcoming(g)) {
      kids.push(el('p', { class: 'note', text: 'This game has not aired yet. The player opens once NSN starts the broadcast.' }));
    }
    kids.push(grid);

    markTarget = null;
    player = null;
    if (!isUpcoming(g)) kids.push(transcriptPanel(g));

    render(kids);

    // The embed goes up straight away so nobody waits on an auth round-trip;
    // a signed-in marker is then upgraded to the readable player in place.
    attachPlayer(g, playerSlot, side);
  }


  /* ---- the player -------------------------------------------------------
   *
   * Two of them, and which you get depends on whether you are signed in.
   *
   * Anonymous visitors -- nearly everyone -- get NSN's own embed, so NSN's
   * pre-roll and mid-roll ads run and NSN gets paid for the view. That embed is
   * cross-origin and sealed: we can seek into it with ?t=, but we can never
   * read where it is.
   *
   * Signed-in markers get a plain <video> fed by hls.js from NSN's CloudFront
   * CDN, because marking a play needs a readable currentTime and the embed
   * cannot give one. It carries no ads. That is a deliberate trade the site
   * owner made, kept as narrow as possible: it is the marking tool, not the
   * way the public watches. The "Watch on NSN Sports" link stays on the page
   * either way.
   */

  var HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
  var player = null;    // { seek(sec), now() -> seconds|null }
  var hlsPromise = null;

  function loadHls() {
    if (!hlsPromise) {
      hlsPromise = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = HLS_URL;
        s.onload = function () { resolve(window.Hls || null); };
        s.onerror = function () { resolve(null); };
        document.head.appendChild(s);
      });
    }
    return hlsPromise;
  }

  /** NSN's embed: seekable, never readable. */
  function embedPlayer(g, slot) {
    if (!g.embedUrl) return null;
    var frame = el('iframe', {
      class: 'player', src: g.embedUrl, title: matchupText(g),
      allow: 'fullscreen', allowfullscreen: 'true', loading: 'lazy',
      referrerpolicy: 'no-referrer-when-downgrade'
    });
    slot.appendChild(frame);
    return {
      node: frame,
      readable: false,
      now: function () { return null; },
      seek: function (sec) {
        var base = g.embedUrl.split('#')[0].replace(/[?&]t=\d+/, '');
        var join = base.indexOf('?') === -1 ? '?' : '&';
        frame.src = base + join + 't=' + Math.max(0, Math.round(sec));
        frame.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    };
  }

  /** Our own player, over the manifest the server resolved for us. */
  async function streamPlayer(g, slot, master) {
    var video = el('video', {
      class: 'player', controls: 'controls', playsinline: 'playsinline',
      preload: 'metadata', title: matchupText(g),
    });

    // hls.js wants a URL. The manifest is already absolute throughout, so a
    // blob of it works and keeps quality switching and the caption track.
    var blobUrl = URL.createObjectURL(new Blob([master], { type: 'application/vnd.apple.mpegurl' }));

    var native = video.canPlayType('application/vnd.apple.mpegurl');
    if (native) {
      video.src = blobUrl;
    } else {
      var Hls = await loadHls();
      if (!Hls || !Hls.isSupported()) { URL.revokeObjectURL(blobUrl); return null; }
      var hls = new Hls({ enableWorker: true });
      hls.loadSource(blobUrl);
      hls.attachMedia(video);
    }

    slot.appendChild(video);
    slot.appendChild(el('p', { class: 'muted small player-note' }, [
      document.createTextNode('Marking player — no ads. '),
      nsnLink(g, 'Watch on NSN ↗', 'linkish'),
      document.createTextNode(' to support the people covering these games.'),
    ]));

    return {
      node: video,
      readable: true,
      now: function () {
        return Number.isFinite(video.currentTime) ? video.currentTime : null;
      },
      seek: function (sec) {
        try { video.currentTime = Math.max(0, sec); } catch (_) { /* not ready yet */ }
        video.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    };
  }

  /** Put a player in the slot, and the plays panel beside it when signed in. */
  async function attachPlayer(g, slot, side) {
    player = embedPlayer(g, slot);

    var user = await NSNAuth.user();
    if (!user || isUpcoming(g)) return;

    // Plays are part of the marking tool, so they appear with it.
    side.appendChild(playsPanel(g, user));
    side.closest('.game-grid').classList.add('has-side');
    // Two columns earn the full display; route() clears this on the way out.
    document.body.classList.add('wide');

    var res = await api('stream?game=' + encodeURIComponent(g.id));
    if (!res || !res.ok || !res.body || !res.body.master) return;   // keep the embed

    slot.innerHTML = '';
    var streamed = await streamPlayer(g, slot, res.body.master);
    // No hls.js and no native HLS: put NSN's embed back rather than nothing.
    player = streamed || (slot.innerHTML = '', embedPlayer(g, slot));
  }

  function seekPlayer(g, sec) { if (player) player.seek(sec); }


  /* ---- marked plays ----------------------------------------------------- */

  /** Panel listing approved markers for this broadcast. Signed-in only. */
  function playsPanel(g, user) {
    var list = el('ul', { class: 'play-list' });
    var status = el('p', { class: 'muted small' });
    var actions = el('div', { class: 'play-actions' });
    var wrap = el('section', { class: 'panel' }, [
      el('h2', { text: 'Marked plays' }), status, list, actions
    ]);

    function refresh() {
      api('markers?game=' + encodeURIComponent(g.id)).then(function (r) {
        if (r && r.body) draw(r.body.markers || []);
      });
    }

    function draw(markers) {
      list.innerHTML = '';
      if (!markers.length) {
        status.textContent = 'No plays marked yet.';
        return;
      }
      status.textContent = markers.length + ' play' + (markers.length === 1 ? '' : 's') + ' marked';
      markers.forEach(function (m) {
        list.appendChild(el('li', {}, [playRow(g, m, user, refresh)]));
      });
    }

    api('markers?game=' + encodeURIComponent(g.id)).then(function (res) {
      if (!res) { wrap.remove(); return; }     // no backend: this is the Pages mirror
      draw((res.body && res.body.markers) || []);
      var open = el('button', { type: 'button', class: 'btn secondary', text: '+ Mark a play' });
      open.addEventListener('click', function () {
        open.remove();
        actions.appendChild(markForm(g, user, function (marker) {
          // Published markers appear at once; queued ones must not, or the
          // submitter will think everyone can see them.
          if (marker.status === 'approved') refresh();
        }));
      });
      actions.appendChild(open);
    });

    return wrap;
  }

  /** Whoever marked a play can take it down again; so can a moderator. */
  function canRemovePlay(user, m) {
    if (!user || !m) return false;
    return NSNAuth.is('moderator', user) || m.createdBy === user.id;
  }

  function playRow(g, m, user, onRemoved) {
    // Who marked a play is useful but not what you scan the list for, so it
    // lives in the tooltip -- which is also the button's description for a
    // screen reader -- rather than taking room on every row.
    var by = m.createdByName || 'someone';
    var go = el('button', {
      type: 'button', class: 'play-row',
      title: 'Marked by ' + by + (m.note ? ' — ' + m.note : ''),
    }, [
      el('span', { class: 'play-time', text: secsToClock(m.startSec) }),
      el('span', { class: 'play-label', text: m.label }),
      el('span', { class: 'play-meta', text: Math.round(m.endSec - m.startSec) + 's' })
    ]);
    go.addEventListener('click', function () { seekPlayer(g, m.startSec); });

    var row = el('div', { class: 'play-row-wrap' }, [go]);
    if (!canRemovePlay(user, m)) return row;

    // Removing is destructive and the rows are small, so it takes two presses:
    // the second one is the confirmation, and it is easy to back out of.
    var remove = el('button', {
      type: 'button', class: 'chip danger', text: 'Remove',
      'aria-label': 'Remove the play "' + m.label + '"',
    });
    var confirm = el('span', { class: 'confirm' });
    row.appendChild(remove);
    row.appendChild(confirm);

    remove.addEventListener('click', function () {
      remove.style.display = 'none';
      var yes = el('button', { type: 'button', class: 'chip danger', text: 'Yes, remove' });
      var no = el('button', { type: 'button', class: 'chip', text: 'Keep' });
      confirm.appendChild(el('span', { class: 'small', text: 'Remove this play?' }));
      confirm.appendChild(yes);
      confirm.appendChild(no);

      no.addEventListener('click', function () {
        confirm.innerHTML = '';
        remove.style.display = '';
      });

      yes.addEventListener('click', async function () {
        yes.disabled = no.disabled = true;
        confirm.innerHTML = '';
        confirm.appendChild(el('span', { class: 'small', text: 'Removing…' }));
        var res = await api('markers?game=' + encodeURIComponent(g.id) + '&id=' + encodeURIComponent(m.id),
          { method: 'DELETE' });
        if (!res || !res.ok) {
          confirm.innerHTML = '';
          confirm.appendChild(el('span', { class: 'small', text: (res && res.body && res.body.error) || 'Could not remove that.' }));
          remove.style.display = '';
          return;
        }
        onRemoved();
      });
    });

    return row;
  }

  var markTarget = null;   // {set: fn} while the form is capturing a transcript line

  function markForm(g, user, onSaved) {
    var startIn = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'm:ss', 'aria-label': 'Start time' });
    var endIn = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'm:ss', 'aria-label': 'End time' });
    var labelIn = el('input', { type: 'text', maxlength: '80', placeholder: 'e.g. Touchdown, Spaulding', 'aria-label': 'Label' });
    var noteIn = el('input', { type: 'text', maxlength: '280', placeholder: 'Optional note', 'aria-label': 'Note' });
    var msg = el('p', { class: 'small' });

    function nudge(input, delta) {
      var cur = clockToSecs(input.value);
      input.value = secsToClock(Math.max(0, (cur === null ? 0 : cur) + delta));
    }

    function timeRow(labelText, input, which) {
      var row = el('div', { class: 'time-row' }, [
        el('label', { class: 'time-label', text: labelText }), input,
      ]);

      // Only our own player can say where it is; NSN's embed cannot, so the
      // button is simply absent rather than present and wrong.
      var fromVideo = el('button', { type: 'button', class: 'chip primary', text: 'from video' });
      fromVideo.addEventListener('click', function () {
        var at = player && player.now();
        if (at === null || at === undefined) { msg.textContent = 'The video has not started yet.'; return; }
        input.value = secsToClock(at);
        msg.textContent = 'Set ' + which + ' to ' + input.value + ' from the video.';
      });
      if (player && player.readable) row.appendChild(fromVideo);

      var pick = el('button', { type: 'button', class: 'chip', text: 'from transcript' });
      pick.addEventListener('click', function () {
        markTarget = { which: which, set: function (sec) { input.value = secsToClock(sec); } };
        msg.textContent = 'Now click a commentary line below to set the ' + which + ' time.';
        var panel = document.getElementById('transcript-panel');
        if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      row.appendChild(pick);

      [['-5', -5], ['-1', -1], ['+1', 1], ['+5', 5]].forEach(function (n) {
        var b = el('button', { type: 'button', class: 'chip', text: n[0] });
        b.addEventListener('click', function () { nudge(input, n[1]); });
        row.appendChild(b);
      });

      var check = el('button', { type: 'button', class: 'chip', text: '▶ check' });
      check.addEventListener('click', function () {
        var sec = clockToSecs(input.value);
        if (sec === null) { msg.textContent = 'Enter a time like 12:34 first.'; return; }
        seekPlayer(g, sec);
      });
      row.appendChild(check);
      return row;
    }

    var save = el('button', { type: 'submit', class: 'btn', text: 'Save play' });
    var form = el('form', { class: 'mark-form' }, [
      timeRow('Start', startIn, 'start'),
      timeRow('End', endIn, 'end'),
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Label' }), labelIn]),
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Note' }), noteIn]),
      el('div', { class: 'time-row' }, [save]),
      msg,
    ]);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var startSec = clockToSecs(startIn.value), endSec = clockToSecs(endIn.value);
      if (startSec === null || endSec === null) { msg.textContent = 'Both times are needed, as m:ss.'; return; }
      if (!labelIn.value.trim()) { msg.textContent = 'Give the play a label.'; return; }

      save.disabled = true;
      msg.textContent = 'Saving…';
      var res = await api('markers', {
        method: 'POST',
        body: JSON.stringify({
          gameId: g.id, startSec: startSec, endSec: endSec,
          label: labelIn.value, note: noteIn.value,
          durationSec: g.durationSec,
        }),
      });
      save.disabled = false;

      if (!res) { msg.textContent = 'Could not reach the server.'; return; }
      if (!res.ok) { msg.textContent = (res.body && res.body.error) || 'Could not save that.'; return; }

      markTarget = null;
      if (res.body.status === 'published') {
        msg.textContent = 'Published — everyone can see it.';
      } else {
        msg.textContent = 'Sent for review. It appears once a moderator approves it.';
      }
      form.reset();
      onSaved(res.body.marker);
    });

    return form;
  }

  /** Commentary transcript: searchable, click to seek, doubles as the picker. */
  function transcriptPanel(g) {
    var search = el('input', { type: 'search', placeholder: 'Search the commentary…', 'aria-label': 'Search commentary' });
    var status = el('p', { class: 'muted small', text: 'Loading commentary…' });
    var list = el('ol', { class: 'cue-list' });
    var wrap = el('section', { class: 'panel', id: 'transcript-panel' }, [
      el('h2', { text: 'Commentary' }),
      el('p', { class: 'muted small', text: 'Auto-generated captions from the broadcast. Names come through garbled; useful for finding a moment, not for facts.' }),
      search, status, list,
    ]);

    var cues = [];
    function draw() {
      var q = search.value.trim().toLowerCase();
      var shown = q ? cues.filter(function (c) { return c.text.toLowerCase().indexOf(q) !== -1; }) : cues;
      list.innerHTML = '';
      status.textContent = q
        ? shown.length + ' of ' + cues.length + ' lines'
        : cues.length + ' lines';
      shown.slice(0, 400).forEach(function (c) {
        var btn = el('button', { type: 'button', class: 'cue' }, [
          el('span', { class: 'cue-time', text: secsToClock(c.start) }),
          el('span', { class: 'cue-text', text: c.text }),
        ]);
        btn.addEventListener('click', function () {
          if (markTarget) {
            markTarget.set(markTarget.which === 'end' ? c.end : c.start);
            status.textContent = 'Set ' + markTarget.which + ' to ' + secsToClock(markTarget.which === 'end' ? c.end : c.start) + '.';
            markTarget = null;
            return;
          }
          seekPlayer(g, c.start);
        });
        list.appendChild(el('li', {}, [btn]));
      });
      if (shown.length > 400) {
        list.appendChild(el('li', { class: 'muted small', text: 'Showing the first 400 lines — narrow the search to see more.' }));
      }
    }
    search.addEventListener('input', draw);

    var tries = 0;
    (function poll() {
      api('transcript?game=' + encodeURIComponent(g.id)).then(function (res) {
        if (!res) { wrap.remove(); return; }             // Pages mirror
        var b = res.body || {};
        if (b.status === 'ready') { cues = b.cues || []; draw(); return; }
        if (b.status === 'unavailable') {
          status.textContent = 'This broadcast has no caption track, so times have to be typed in by hand.';
          search.remove();
          return;
        }
        if (++tries > 60) { status.textContent = 'The commentary is taking unusually long to prepare.'; return; }
        status.textContent = 'Preparing the commentary from the broadcast — this takes a minute the first time.';
        setTimeout(poll, b.retryAfterMs || 4000);
      });
    })();

    return wrap;
  }


  /* ---- account --------------------------------------------------------- */

  function accountView() {
    var wrap = el('div', {});
    render([
      el('a', { class: 'back-link', href: backTarget(), text: '← Back' }),
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Your account' }),
        el('p', { text: 'Sign in to mark plays. New accounts can submit plays for review; trusted contributors publish directly.' }),
      ]),
      wrap,
    ]);

    NSNAuth.user().then(function (user) {
      wrap.innerHTML = '';
      if (API_ALIVE === false) {
        wrap.appendChild(el('p', { class: 'note', text: 'This copy of the site is the read-only mirror, so there is nothing to sign in to here.' }));
        return;
      }
      if (user) {
        var roles = NSNAuth.roles(user);
        wrap.appendChild(el('ul', { class: 'detail-facts' }, [
          el('li', { html: '<b>Signed in as</b> ' + (user.email || user.name || 'you') }),
          el('li', { html: '<b>Status</b> ' + (NSNAuth.canPublish(user)
            ? 'plays you mark are published immediately'
            : 'plays you mark go to a moderator for review') }),
          roles.length ? el('li', { html: '<b>Roles</b> ' + roles.join(', ') }) : null,
        ]));
        var out = el('button', { type: 'button', class: 'btn secondary', text: 'Sign out' });
        out.addEventListener('click', function () { NSNAuth.logout().then(function () { route(); }); });
        wrap.appendChild(el('p', {}, [out]));
        if (NSNAuth.is('moderator', user)) {
          wrap.appendChild(el('p', {}, [el('a', { class: 'btn', href: '#/review', text: 'Review queue' })]));
        }
        return;
      }
      wrap.appendChild(authForm());
    });
  }

  function authForm() {
    var mode = 'login';
    var email = el('input', { type: 'email', required: 'required', placeholder: 'you@example.com', 'aria-label': 'Email' });
    var pass = el('input', { type: 'password', required: 'required', minlength: '8', placeholder: 'Password', 'aria-label': 'Password' });
    var name = el('input', { type: 'text', placeholder: 'Display name (optional)', 'aria-label': 'Display name' });
    var msg = el('p', { class: 'small' });
    var submit = el('button', { type: 'submit', class: 'btn', text: 'Sign in' });
    var toggle = el('button', { type: 'button', class: 'linkish', text: 'Create an account instead' });
    var forgot = el('button', { type: 'button', class: 'linkish', text: 'Forgot password?' });
    var inviteNote = el('p', { class: 'small muted' });

    name.style.display = 'none';

    // An invite-only instance rejects signup outright, so do not offer a door
    // that is locked. Settings are unavailable on the mirror; leave it as-is.
    NSNAuth.settings().then(function (s) {
      if (s && s.disableSignup) {
        mode = 'login';
        toggle.style.display = 'none';
        name.style.display = 'none';
        submit.textContent = 'Sign in';
        inviteNote.textContent = 'This site is invite-only — ask a moderator for an invite.';
      }
    });
    toggle.addEventListener('click', function () {
      mode = mode === 'login' ? 'signup' : 'login';
      submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      toggle.textContent = mode === 'login' ? 'Create an account instead' : 'I already have an account';
      name.style.display = mode === 'signup' ? '' : 'none';
      msg.textContent = '';
    });

    forgot.addEventListener('click', async function () {
      if (!email.value) { msg.textContent = 'Enter your email address first.'; return; }
      try {
        await NSNAuth.recover(email.value);
        msg.textContent = 'If that address has an account, a reset link is on its way.';
      } catch (err) { msg.textContent = err.message; }
    });

    var form = el('form', { class: 'mark-form' }, [
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Email' }), email]),
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Password' }), pass]),
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Name' }), name]),
      el('div', { class: 'time-row' }, [submit, toggle, forgot]),
      msg,
      inviteNote,
    ]);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      submit.disabled = true;
      msg.textContent = 'Working…';
      try {
        if (mode === 'login') {
          await NSNAuth.login(email.value, pass.value);
          route();
        } else {
          var user = await NSNAuth.signup(email.value, pass.value, name.value);
          msg.textContent = user
            ? 'Account created — you are signed in.'
            : 'Account created. Check your email for the confirmation link before signing in.';
          if (user) route();
        }
      } catch (err) {
        msg.textContent = err && err.message ? err.message : 'That did not work.';
      } finally {
        submit.disabled = false;
      }
    });

    return form;
  }

  /* ---- invite / reset links ---------------------------------------------
   *
   * Identity mails people here with a token in the URL fragment. auth.js has
   * already captured and stripped it by the time this runs; this view spends it.
   * It renders before the game data arrives, so an invite still works when
   * games.json is slow or missing. */

  var callbackShowing = false;

  function goToAccount() {
    callbackShowing = false;
    NSNAuth.clearPending();
    if (location.hash === '#/account') route();
    else location.hash = '#/account';   // fires hashchange, which routes
  }

  /** Shared by the invite and the password-reset flows; `submit` spends the token. */
  function passwordForm(opts) {
    var pass = el('input', { type: 'password', required: 'required', minlength: '8', autocomplete: 'new-password', 'aria-label': 'New password' });
    var again = el('input', { type: 'password', required: 'required', minlength: '8', autocomplete: 'new-password', 'aria-label': 'Repeat password' });
    var name = opts.askName ? el('input', { type: 'text', placeholder: 'Display name (optional)', 'aria-label': 'Display name' }) : null;
    var msg = el('p', { class: 'small' });
    var submit = el('button', { type: 'submit', class: 'btn', text: opts.submitText });

    var rows = [
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Password' }), pass]),
      el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Repeat' }), again]),
    ];
    if (name) rows.push(el('div', { class: 'time-row' }, [el('label', { class: 'time-label', text: 'Name' }), name]));
    rows.push(el('div', { class: 'time-row' }, [submit]));
    rows.push(msg);

    var form = el('form', { class: 'mark-form' }, rows);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (pass.value.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      if (pass.value !== again.value) { msg.textContent = 'Those two passwords do not match.'; return; }
      submit.disabled = true;
      msg.textContent = 'Working…';
      try {
        var result = await opts.submit(pass.value, name ? name.value.trim() : '');
        // The password stuck but the session did not; let them in by hand.
        if (result && result.needsSignIn) {
          msg.textContent = 'Your password is saved, but signing in did not finish. Sign in below with '
            + ((result.user && result.user.email) || 'your email address') + '.';
          form.appendChild(authForm());
          return;
        }
        goToAccount();
      } catch (err) {
        msg.textContent = explainTokenError(err);
        submit.disabled = false;
      }
    });

    return form;
  }

  /** Identity answers a stale invite with a bare "User not found", which reads
   *  like a site fault rather than an expired link. Say what it means. */
  function explainTokenError(err) {
    var raw = (err && err.message) || '';
    if (/user not found|invalid|expired|not_found/i.test(raw)) {
      return 'This link is no longer valid — it has already been used, or it has expired. '
        + 'Ask a moderator to send a fresh invite.';
    }
    return raw || 'That did not work.';
  }

  function authCallbackView(pending) {
    callbackShowing = true;

    if (pending.kind === 'error') {
      render([
        el('div', { class: 'page-head' }, [
          el('h1', { text: 'That link did not work' }),
          el('p', { text: pending.message }),
        ]),
        el('p', { class: 'note', text: 'Invite and password-reset links can only be used once, and they expire. Ask a moderator for a fresh invite, or use "Forgot password?" on the sign-in page.' }),
        el('p', {}, [el('a', { class: 'btn', href: '#/account', text: 'Go to sign in' })]),
      ]);
      NSNAuth.clearPending();
      return;
    }

    if (pending.kind === 'confirmation' || pending.kind === 'email_change') {
      var note = el('p', { class: 'loading', text: 'Confirming…' });
      render([
        el('div', { class: 'page-head' }, [el('h1', { text: 'Confirming your email' })]),
        note,
      ]);
      NSNAuth.confirmEmail(pending.token).then(goToAccount).catch(function (err) {
        note.className = 'empty';
        note.textContent = explainTokenError(err);
      });
      return;
    }

    var invite = pending.kind === 'invite';
    render([
      el('div', { class: 'page-head' }, [
        el('h1', { text: invite ? 'Set your password' : 'Choose a new password' }),
        el('p', {
          text: invite
            ? 'You have been invited to help mark plays. Pick a password to finish setting up your account.'
            : 'Pick a new password for your account.',
        }),
      ]),
      passwordForm({
        askName: invite,
        submitText: invite ? 'Create my account' : 'Save new password',
        submit: function (password, name) {
          return invite
            ? NSNAuth.acceptInvite(pending.token, password, name)
            : NSNAuth.resetPassword(pending.token, password);
        },
      }),
    ]);
  }

  /* ---- moderation ------------------------------------------------------ */

  function reviewView() {
    var body = el('div', {});
    render([
      el('a', { class: 'back-link', href: '#/account', text: '← Account' }),
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Review queue' }),
        el('p', { text: 'Plays submitted by people who cannot publish directly.' }),
      ]),
      body,
    ]);

    NSNAuth.user().then(async function (user) {
      if (!user || !NSNAuth.is('moderator', user)) {
        body.appendChild(el('p', { class: 'note', text: 'This page is for moderators.' }));
        return;
      }
      body.textContent = 'Loading…';
      var res = await api('review/queue');
      body.innerHTML = '';
      if (!res || !res.ok) {
        body.appendChild(el('p', { class: 'note', text: (res && res.body && res.body.error) || 'Could not load the queue.' }));
        return;
      }
      var markers = res.body.markers || [];
      if (!markers.length) {
        body.appendChild(el('p', { class: 'empty', text: 'Nothing waiting for review.' }));
      }
      var list = el('ul', { class: 'play-list' });
      markers.forEach(function (m) { list.appendChild(reviewRow(m)); });
      body.appendChild(list);
      body.appendChild(el('p', {}, [el('a', { class: 'btn secondary', href: '#/contributors', text: 'Manage contributors' })]));
    });
  }

  function reviewRow(m) {
    var game = data.games.filter(function (x) { return x.id === m.gameId; })[0];
    var msg = el('span', { class: 'play-meta' });
    var li = el('li', {});

    function act(action) {
      return async function () {
        msg.textContent = '…';
        var res = await api('review', {
          method: 'POST',
          body: JSON.stringify({ markerId: m.id, submittedBy: m.createdBy, action: action }),
        });
        if (!res || !res.ok) { msg.textContent = (res && res.body && res.body.error) || 'failed'; return; }
        li.classList.add('done');
        msg.textContent = res.body.status;
      };
    }
    var ok = el('button', { type: 'button', class: 'chip', text: 'Approve' });
    var no = el('button', { type: 'button', class: 'chip', text: 'Reject' });
    ok.addEventListener('click', act('approve'));
    no.addEventListener('click', act('reject'));

    li.appendChild(el('div', { class: 'review-row' }, [
      el('span', { class: 'play-label', text: m.label }),
      el('span', { class: 'play-meta', text:
        (game ? matchupText(game) : 'game ' + m.gameId) + ' · ' +
        secsToClock(m.startSec) + '–' + secsToClock(m.endSec) + ' · by ' + (m.createdByName || 'someone') }),
      m.note ? el('span', { class: 'play-meta', text: '“' + m.note + '”' }) : null,
      el('span', { class: 'review-actions' }, [
        game ? el('a', { class: 'chip', href: '#/game/' + m.gameId, text: 'Open game' }) : null,
        ok, no, msg,
      ]),
    ]));
    return li;
  }

  function contributorsView() {
    var body = el('div', {});
    render([
      el('a', { class: 'back-link', href: '#/review', text: '← Review queue' }),
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Contributors' }),
        el('p', { text: 'Contributors publish plays without review. Role changes take effect the next time that person signs in.' }),
      ]),
      body,
    ]);

    NSNAuth.user().then(async function (user) {
      if (!user || !NSNAuth.is('moderator', user)) {
        body.appendChild(el('p', { class: 'note', text: 'This page is for moderators.' }));
        return;
      }
      body.textContent = 'Loading…';
      var res = await api('review/users');
      body.innerHTML = '';
      if (!res || !res.ok) {
        body.appendChild(el('p', { class: 'note', text: (res && res.body && res.body.error) || 'Could not load the user list.' }));
        return;
      }
      var list = el('ul', { class: 'play-list' });
      (res.body.users || []).forEach(function (u) { list.appendChild(contributorRow(u)); });
      body.appendChild(list);
    });
  }

  function contributorRow(u) {
    var msg = el('span', { class: 'play-meta' });
    var isContrib = (u.roles || []).indexOf('contributor') !== -1;
    var btn = el('button', { type: 'button', class: 'chip', text: isContrib ? 'Remove contributor' : 'Make contributor' });
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      msg.textContent = '…';
      var res = await api('review/users', {
        method: 'POST',
        body: JSON.stringify({ userId: u.id, role: 'contributor', grant: !isContrib }),
      });
      btn.disabled = false;
      if (!res || !res.ok) { msg.textContent = (res && res.body && res.body.error) || 'failed'; return; }
      isContrib = !isContrib;
      btn.textContent = isContrib ? 'Remove contributor' : 'Make contributor';
      msg.textContent = 'saved — applies on their next sign-in';
    });
    return el('li', {}, [
      el('div', { class: 'review-row' }, [
        el('span', { class: 'play-label', text: u.email || u.name || u.id }),
        el('span', { class: 'play-meta', text: (u.roles || []).join(', ') || 'no roles' }),
        el('span', { class: 'review-actions' }, [btn, msg]),
      ]),
    ]);
  }

  function notFound(msg) {
    render([
      el('div', { class: 'page-head' }, [el('h1', { text: 'Not found' }), el('p', { text: msg })]),
      el('a', { class: 'btn', href: '#/timeline', text: 'Back to the timeline' })
    ]);
  }

  /* ---- plumbing ------------------------------------------------------- */

  var lastListRoute = '#/timeline';

  function backTarget() { return lastListRoute; }

  function uniqueSeasons() {
    var seen = {};
    data.games.forEach(function (g) { seen[g.season] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  function render(nodes) {
    view.innerHTML = '';
    nodes.forEach(function (n) { if (n) view.appendChild(n); });
  }

  function indexSchools() {
    bySlug = {};
    data.games.forEach(function (g) {
      g.teams.forEach(function (name, i) {
        var slug = g.teamSlugs[i] || slugify(name);
        if (!bySlug[slug]) bySlug[slug] = { name: name, slug: slug, games: [] };
        bySlug[slug].games.push(g);
      });
    });
  }

  /** Header link doubles as the sign-in state indicator. */
  function refreshAccountLink() {
    var link = document.getElementById('account-link');
    if (!link) return;
    NSNAuth.user().then(function (user) {
      if (API_ALIVE === false) { link.style.display = 'none'; return; }
      link.textContent = user ? (user.name || (user.email || '').split('@')[0] || 'Account') : 'Sign in';
    });
  }

  function setTab(name) {
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function route() {
    callbackShowing = false;   // navigating away retires the callback view
    document.body.classList.remove('wide');
    var hash = location.hash || '#/timeline';
    var parts = hash.replace(/^#\/?/, '').split('/');

    // Every view but the account page reads the game data. Until it lands,
    // leave whatever is on screen -- the loading note, or an invite form.
    if (!data && parts[0] !== 'account') { refreshAccountLink(); return; }

    if (parts[0] === 'school' && parts[1]) {
      setTab('schools');
      schoolView(decodeURIComponent(parts[1]));
    } else if (parts[0] === 'schools') {
      lastListRoute = hash;
      setTab('schools');
      schoolsView();
    } else if (parts[0] === 'game' && parts[1]) {
      setTab(null);
      gameView(decodeURIComponent(parts[1]));
    } else if (parts[0] === 'account') {
      setTab(null);
      accountView();
    } else if (parts[0] === 'review') {
      setTab(null);
      reviewView();
    } else if (parts[0] === 'contributors') {
      setTab(null);
      contributorsView();
    } else {
      lastListRoute = '#/timeline';
      setTab('timeline');
      timelineView();
    }
    refreshAccountLink();
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);

  // An invite or password-reset link has to work even if the game data is slow
  // or missing, so this renders without waiting on the fetch below.
  var startupCallback = NSNAuth.pending();
  if (startupCallback) authCallbackView(startupCallback);

  fetch('data/games.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      data = json;
      indexSchools();
      var stamp = document.getElementById('data-stamp');
      if (stamp && json.generated) {
        stamp.textContent = json.count + ' broadcasts indexed · data refreshed ' +
          new Date(json.generated).toLocaleDateString('en-US', { dateStyle: 'medium' });
      }
      if (!callbackShowing) route();
    })
    .catch(function (err) {
      if (callbackShowing) return;
      view.innerHTML = '';
      view.appendChild(el('p', { class: 'empty', text: 'Could not load the game data (' + err.message + ').' }));
    });
})();
