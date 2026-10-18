#!/usr/bin/env bash
# Builds the published site in _site/, exactly as GitHub Pages serves it:
#   design 1 (source: site/) at the root; designs 2 to 10 in design-N/ as noindexed alternates.
# Usage: scripts/assemble.sh [stamp]
#   The stamp (the Pages run number in CI) is appended as ?v=<stamp> to every local stylesheet and
#   script URL, so browsers never mix a new page with the previous deploy's CSS or JS.
# Optional environment, set by the live deploy (CI checks leave them unset):
#   SITE_URL   public URL of the site, no trailing slash (e.g. https://vftech.io); replaces the
#              placeholder https://dogecoin87.github.io/VFTECH in canonical, social and sitemap URLs.
#   BASE_PATH  path the site is served under, with slashes (e.g. / or /vftech.io/); used by 404.html.
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP="${1:-dev}"

rm -rf _site
mkdir -p _site
cp -r site/. _site/
rm -rf _site/src _site/README.md _site/preview-*.png _site/social/*.mp4 _site/social/*.gif
for n in 2 3 4 5 6 7 8 9 10; do
  mkdir -p "_site/design-$n"
  cp -r "design-$n/." "_site/design-$n/"
  rm -rf "_site/design-$n/src" "_site/design-$n/README.md" _site/design-$n/preview-*.png \
         _site/design-$n/social/*.mp4 _site/design-$n/social/*.gif \
         "_site/design-$n/404.html" "_site/design-$n/robots.txt" "_site/design-$n/sitemap.xml"
done

# design 1 used to live at /design-1/; keep old links working by forwarding each page to the root.
mkdir -p _site/design-1
for f in site/*.html; do
  page=$(basename "$f"); [ "$page" = 404.html ] && continue
  target="../$page"; [ "$page" = index.html ] && target="../"
  cat > "_site/design-1/$page" <<HTML
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>VFTech</title>
<meta name="robots" content="noindex"><link rel="canonical" href="$target">
<meta http-equiv="refresh" content="0; url=$target">
<script>location.replace("$target"+location.search+location.hash)</script></head>
<body><p>This page has moved: <a href="$target">continue to VFTech</a>.</p></body></html>
HTML
done

find _site -name '*.html' -exec sed -i -E \
  's#(href|src)="((\.\./)?(styles\.css|site\.js|motion-loader\.js|motion\.css|assets/motion-suite\.js|guide-engine\.js|guide-knowledge\.js|guide-widget\.js|guide-widget\.css|services-config\.js|service-catalog\.js|services\.css|services\.js|feature-showcase\.js|hero-intro\.js|hero-depth\.js|schematic\.js|compare\.css|compare\.js|remix\.css|fonts\.css|typography\.css|layout\.css|hero-ref\.css|chrome-loader\.js|extras\.js|extras\.css|saas\.css|ledger\.css|console\.css|pulse\.css|mono\.css|switcher\.css|switcher\.js|signature\.css|signature\.js|showcase\.js|ledger\.js|console\.js|pulse\.js|mono\.js|logo-motion\.js|assets/chrome-hero\.js))"#\1="\2?v='"$STAMP"'"#g' {} +

if [ -n "${SITE_URL:-}" ]; then
  grep -rlF 'https://dogecoin87.github.io/VFTECH' _site | xargs -r sed -i "s#https://dogecoin87.github.io/VFTECH#${SITE_URL%/}#g"
fi
if [ -n "${BASE_PATH:-}" ]; then
  sed -i "s#<base href=\"/VFTECH/\">#<base href=\"${BASE_PATH}\">#" _site/404.html
fi

echo "assembled _site/ (stamp $STAMP)"
