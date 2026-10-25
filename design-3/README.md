# VFTech website, design 3 ("Signal")

The third design, published at the site root. Design 1 (`../site`) is at `/design-1/` and design 2 (`../design-2`) is at `/design-2/`. Every page has a switcher in the bottom-left corner that opens the same page in any of the three designs. The same switcher holds the light/dark theme button.

- **Concept:** International Typographic Style. A twelve-column grid shows faintly behind every page. Type is set flush left at poster scale, rules are heavy and black, and corners are square. One signal colour, International Klein blue, is used as a field.
- **Type:** Bricolage Grotesque, condensed, for headings and numerals; Schibsted Grotesk for body text; DM Mono for labels and navigation.
- **Hero:** a flat blue poster with the silver mark turning in the right-hand columns, over the column grid laid flat as a floor. Parallax, the intro and the depth layers carry over.
- **Layout:**
  - each section's number is set huge in the margin, with the heading across eight columns;
  - lists are ruled tables, and rows fill with blue or black on hover;
  - the four lines of work sit in shared-border cells;
  - the closing band turns fully blue;
  - blocks wipe up into place as you scroll.
- **Rebuild the silver hero** from the repo root: `npm run build:d3`.

---

The notes below are carried over from design 1 and still describe the shared structure.

# VFTech website

A seven-page static site: plain HTML and CSS plus shared behaviour (`site.js`) and a self-hosted Three.js chrome hero. The compiled hero asset is committed, so deployment needs no build step or platform. It runs on any static host (GitHub Pages, Netlify, Cloudflare Pages, S3) by uploading this folder.

| Page | File |
|---|---|
| Home | `index.html` |
| Website rebuilds (tiers, monthly plans) | `websites.html` |
| AI integration | `ai.html` |
| Advisory | `advisory.html` |
| How we work | `process.html` |
| About | `about.html` |
| Contact | `contact.html` |

## Design system

All in `styles.css`:

- **Concept**: the site reads as an engineering drawing set. Each page is a "sheet", and the footer is the title block ("Owner of record: You").
- **The 60° equilateral triangle** from the monogram sets the angles and motifs: parallelogram buttons and tabs, 60° chamfers, the lattice figure and dimension lines.
- **The golden ratio** sets proportion and rhythm:
  - type scale in steps of √φ (17 → 72 px);
  - Fibonacci spacing (5–144 px);
  - 61.8 / 38.2 column splits;
  - body line-height 1.618.
- **Type**: Archivo for headings, Source Serif 4 for body text, IBM Plex Mono for annotation, all from Google Fonts.
- **Logo**: inline outlined SVG. No font file is embedded.
- **Themes**: light and dark. The visitor's choice is remembered.

## Before launch

- **Contact details**: email is `kevinvf@vftech.io`; the phone `(000) 000-0000` is still a placeholder. Both appear on every page (in the footer) and three times in `contact.html`.
- **Booking form**: connect it to delivery. Today it composes the request and offers to copy it, and says plainly that nothing has been sent. The form handler is in `site.js` (`#book-form`).
- **Wordmark**: the lockup uses the TT Norms Pro version of the wordmark, built from an evaluation-only trial font. Buy a TypeType license before publishing, or switch to the Montserrat lockup in `/logo`.
- **Copy to confirm**:
  - the firm name (the source doc says "VF Associates"; the site says "VFTech");
  - the line "faster turnaround than a traditional agency at a comparable price" on `websites.html`.

## Chrome hero and schematic motion

The home hero uses the exact two contours from `logo/vftech-icon.svg`, extruded
0.24 world units with small bevels. Its local studio environment supplies the
mirror-polished chrome reflections; there are no remote HDR or model requests.
The sequence draws the SVG construction, grows the extrusion over 3.2 seconds,
then rotates clockwise around the vertical axis once every eight seconds (viewed
from above). The construction lattice tilts and breathes independently. The AI
workflow diagram also reveals its steps in order when scrolled into view.

- **Intro** (`hero-intro.js`, on a canvas behind the hero content). Three rays of light run along the hero's borders, turn at 60° and meet at the triangle's three corners at 1.25 s. Lattice triangles sweep in from the side edges behind them, aligned exactly to the lattice behind the mark, then fade by 2.5 s. At the meet, the construction lines and outline draw and the chrome mark starts its extrusion; `chrome-hero.js` waits for the `vftech:intro-arrived` event, with a 3 s failsafe. The hero's type rises in reading order from 1.45 s to 3 s. That reveal is pure CSS on a fixed schedule (`.hero-intro-pending`), so the text appears even without JavaScript. A visitor who has paused motion sees the finished hero at once.
- The hero is a dark, lit "studio" in both page themes (`.hero--studio` in `styles.css`). It has a key light behind the mark (layered gaussian falloffs with a fine grain to stop banding, kept centred on the mark at every width by `site.js`) and the 60° lattice laid flat as a stage floor, so the chrome always reads against a dark backdrop. Its tokens are re-pointed locally, so the components inside it adapt. The stage sets `data-backdrop="dark"`, so the renderer always uses its dark-studio exposure.
- **Depth** (`hero-depth.js`, with the layers in `.hero-backdrop`). The hero is built as layered space. From back to front: the lit backdrop, a 60° cone of soft light rays that sways slowly, the lattice floor gliding toward the viewer, dust motes on three depth planes drifting up through the key light, the light the chrome throws on the floor (widest when its face turns to camera), the chrome mark on a soft drop shadow, and the type. On devices with a mouse, the pointer moves each layer by its depth, and the chrome mark leans toward it in 3D. On every device, scrolling away lets the mark and backdrop trail behind the type, which lifts and fades. These layers come up with the mark after the intro.
- **Across the site** (`site.js`, `styles.css`): sheet content rises into place as it scrolls into view, with list rows staggered in reading order. The heavy rule over each list or table draws across. Nav links draw the dimension underline on hover. Buttons sweep a 60° highlight, linked cells run a blueline rule across their top, and the header lifts on a soft shadow once the page scrolls. Content is visible without JavaScript, and Pause motion shows everything at once.
- Motion plays on every device, including those with the system Reduce Motion setting on. Both Pause motion buttons stay visible and stop the hero, diagrams and footer together (WCAG 2.2.2). A pause lasts for the current visit.
- Without WebGL, the drawn mark turns on its vertical axis in CSS instead. Without JavaScript, the original SVG construction stays visible.
- The render loop stops offscreen or in a hidden tab. Rendering is capped at 30 FPS and device pixel ratio at 1.75.
- Context loss returns to the SVG fallback. Light/dark themes use the same scene with adjusted exposure.
- Source: `site/src/chrome-hero.js`. Built output: `site/assets/chrome-hero.js`.
- To edit/rebuild, from the repo root: `npm ci`, `npm run check`, `npm run build`.
- The production output and `THREE-LICENSE.txt` must ship with the site.

## Sharing and hosting

- **GitHub Pages**: `.github/workflows/pages.yml` publishes `site/` to https://dogecoin87.github.io/VFTECH/ on every push to `main`. One-time setup: Settings → Pages → Source: **GitHub Actions**.
- **Share cards**: every page carries Open Graph and Twitter tags.
  - `social/vftech-card.jpg` is the desktop still (1200×630, about 80 KB, under WhatsApp's limit).
  - `social/vftech-card.mp4` is a seamless 8-second loop of the chrome mark, offered as `og:video`.
  - `social/vftech-card.gif` is the same loop as an animated GIF, for posting directly.
  - Whether a link preview animates is up to each app. Most show the still.
