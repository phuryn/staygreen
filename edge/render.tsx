import { renderToStaticMarkup } from "react-dom/server";
import { StatusPageView } from "../src/components/status/StatusPageView";
import type { PublicView } from "../src/lib/public-page";
import { faviconOf } from "../src/lib/page-assets";

export function renderPage(view: PublicView): string {
  return "<!doctype html>" + renderToStaticMarkup(
    <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{view.page.name}</title>
      {view.page.noindex && <meta name="robots" content="noindex, nofollow" />}
      <link rel="icon" href={faviconOf(view.page)} />
      <link rel="stylesheet" href="/_edge/status.css" />
    </head><body><StatusPageView view={view} notice={<div className="edge-freshness" role="status">__STAYGREEN_FRESHNESS__</div>} /></body></html>,
  ).replaceAll('href="/"', 'href="https://staygreen.io/"');
}
