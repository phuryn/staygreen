"use client";

import { useEffect } from "react";

// Sets the browser tab's title from a client page. Client pages can't export metadata, and Next
// writes its own <title> after hydration, so the title is set again whenever <head> changes.
export function DocTitle({ title }: { title: string }) {
  useEffect(() => {
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [title]);
  return null;
}
