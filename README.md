# Vermont Football Video Archive

A small static site that indexes the Vermont high school football broadcasts
published on [NSN Sports](https://www.nsnsports.net/high-schools/vermont/) and
makes them browsable two ways:

- **Timeline** — every broadcast, newest first, grouped by season, with a search
  box and a season filter.
- **By school** — all 40 programs in the archive, each with its own page listing
  that team's games season by season.

Each game has a detail page with the NSN player embedded, the kickoff time, the
playoff round where there is one, and links through to both schools.

The video itself is hosted and owned by NSN. This site stores no video — only
titles, dates, schools and the links needed to play a broadcast on NSN.

## How it works

NSN runs on WordPress and renders its broadcast lists client-side from
`ajax.php?action=nsn_schedule`, scoped to a site slug (`nsnvermont` for the
Vermont hub). `scripts/fetch_games.py` pages through that endpoint, keeps the
football broadcasts, parses the two schools out of each title, and writes
`docs/data/games.json`. The site is plain HTML, CSS and JavaScript reading that
one file — no framework, no build step, no server.

```
docs/               the site (publish this directory)
  index.html
  assets/app.js     hash routing + rendering
  assets/styles.css
  data/games.json   generated — do not hand-edit
data/
  raw_broadcasts.json  cached API response, so parsing can be reworked offline
scripts/fetch_games.py
```

## Running it

Any static file server works; the site fetches `data/games.json`, so opening
`index.html` straight off the filesystem will not work.

```sh
python3 -m http.server 8000 --directory docs
# then open http://localhost:8000
```

## Refreshing the data

```sh
python3 scripts/fetch_games.py                # fetch from NSN, rewrite games.json
python3 scripts/fetch_games.py --from-cache   # re-parse the cached response only
python3 scripts/fetch_games.py --all-sports   # keep soccer etc. as well as football
```

The fetch takes about a minute and is deliberately unhurried — it sleeps between
pages rather than hammering someone else's server. `.github/workflows/refresh-data.yml`
runs it weekly during the season and commits the result.

## Title parsing

NSN's titles are free text, so `fetch_games.py` normalises them:

| In the title | Handled as |
| --- | --- |
| `#3 Colchester vs #2 Lyndon` | seeds stripped, two schools |
| `... - VPA DIV II Semifinal` | a `round` field, not part of the school name |
| `St. Johnsbury vs Colchester 2` | `part: 2` — the second recording of one game |
| `FB - St. Johnsbury vs ...` | leading section tag stripped |
| `Lyndon` / `Lyndon Institute` | merged via the alias table in the script |

Four titles are intentionally left without a school split: the Shrine Maple
Sugar Bowl all-star games, which are Vermont-vs-New-Hampshire rather than two
schools.

When NSN starts using a new format, add a case to `SCHOOL_ALIASES` or
`ROUND_SUFFIX` and re-run with `--from-cache` to check the result without
re-fetching.

## Publishing

`.github/workflows/deploy-pages.yml` publishes `docs/` to GitHub Pages on every
push to `main`, and `refresh-data.yml` calls it after a data refresh that
actually changed something. The first run turns Pages on by itself, so the
repository settings do not need to be touched.

The site lands at `https://jamesjnadeau.github.io/nsn-football-videos/`.
