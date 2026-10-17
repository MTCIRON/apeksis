// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The product wordmark — "Apeksis", set in the app's own display font.
//
// The old wordmark was a PNG. A picture cannot follow the theme, cannot scale
// with the toolbar and had to be re-exported for every tweak, and it forced a
// second asset for phones. This draws the name in the display font the app
// already bundles (Google Sans Flex, the first caption font), registered under
// its own family so it never disturbs the UI font.

import { useEffect, useState } from "react";
import { captionStack, loadCaptionFont } from "../studio/captions/fonts";

export function Wordmark({ className = "" }: { className?: string }) {
  // The webfont is a fetch: draw nothing until it is in rather than flash the
  // fallback metrics. The box is reserved either way, so nothing jumps.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    loadCaptionFont("gsflex", document.fonts)
      .catch(() => {})
      .then(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <span
      className={className}
      style={{
        fontFamily: captionStack("gsflex"),
        fontWeight: 760,
        letterSpacing: "-0.035em",
        lineHeight: 1,
        visibility: ready ? undefined : "hidden",
      }}
    >
      Apeksis
    </span>
  );
}
