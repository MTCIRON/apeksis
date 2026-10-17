// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Word } from "../engine";
import { findMatches, replaceMatches, squash, type Match } from "../lib/find";
import { IconChevron, IconClose } from "./icons";
import { Button, IconButton } from "./ui";

export type Find = ReturnType<typeof useFind>;

/** Find and replace state for the transcript. */
export function useFind(words: Word[], lang: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  // The current hit is the first one at or after this offset (wrapping).
  // An offset rather than an index, so it survives edits and new queries.
  const [anchor, setAnchor] = useState(0);
  // Bumped to focus the search field again.
  const [focusTick, setFocusTick] = useState(0);

  const matches = useMemo(
    () => (open ? findMatches(words, query, wholeWord, lang) : []),
    [open, words, query, wholeWord, lang],
  );
  const current = matches.length ? Math.max(0, matches.findIndex((m) => m.from >= anchor)) : -1;

  const show = useCallback(() => {
    // Selected transcript text becomes the query.
    const picked = squash(window.getSelection()?.toString() ?? "");
    if (picked && picked.length <= 60) setQuery(picked);
    setOpen(true);
    setFocusTick((n) => n + 1);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return {
    open, show, close, focusTick,
    query, setQuery, replacement, setReplacement, wholeWord, setWholeWord,
    matches, current, setAnchor, lang,
  };
}

const FIELD =
  "h-[26px] min-w-0 flex-1 rounded-ui-sm border border-line bg-bg px-2 text-[12.5px] text-fg outline-none placeholder:text-fg-3 focus:border-cini";

export function FindBar({
  find,
  words,
  onReplace,
  onGo,
}: {
  find: Find;
  words: Word[];
  /** Commit replaced words (one undo step). */
  onReplace: (next: Word[]) => void;
  /** A hit was chosen with the arrows or Enter. */
  onGo: (m: Match) => void;
}) {
  const { matches, current, setAnchor } = find;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focusTick]);

  const go = (step: number) => {
    if (!matches.length) return;
    const m = matches[(current + step + matches.length) % matches.length];
    setAnchor(m.from);
    onGo(m);
  };
  const replaceOne = () => {
    const m = matches[current];
    if (!m) return;
    onReplace(replaceMatches(words, [m], find.replacement, find.lang));
    // Carry on after the inserted text, so a replacement holding the query is not found again.
    setAnchor(m.from + squash(find.replacement).length);
  };
  const replaceAll = () => {
    if (!matches.length) return;
    onReplace(replaceMatches(words, matches, find.replacement, find.lang));
    setAnchor(0);
  };
  const keys = (onEnter: (shift: boolean) => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      find.close();
    }
  };

  const hasQuery = !!squash(find.query);
  return (
    <div className="grid flex-none gap-1.5 border-b border-line-soft px-3.5 py-2" role="search">
      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          className={FIELD}
          value={find.query}
          placeholder="Bul"
          aria-label="Transkriptte bul"
          spellCheck={false}
          lang={find.lang}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={keys((shift) => go(shift ? -1 : 1))}
        />
        <span
          className={`w-11 flex-none text-right text-[11px] tabular-nums [font-feature-settings:'tnum'_1] ${
            hasQuery && !matches.length ? "text-mercan" : "text-fg-3"
          }`}
          aria-live="polite"
        >
          {hasQuery ? (matches.length ? `${current + 1}/${matches.length}` : "Yok") : ""}
        </span>
        <IconButton
          className={find.wholeWord ? "bg-line text-fg" : ""}
          onClick={() => find.setWholeWord(!find.wholeWord)}
          aria-pressed={find.wholeWord}
          title="Yalnızca tam kelime"
          aria-label="Yalnızca tam kelime"
        >
          <span className="text-[11px] font-semibold underline underline-offset-2">ab</span>
        </IconButton>
        <IconButton className="disabled:opacity-40" onClick={() => go(-1)} disabled={!matches.length} title="Önceki (⇧Enter)" aria-label="Önceki">
          <span className="grid rotate-180">
            <IconChevron size={14} />
          </span>
        </IconButton>
        <IconButton className="disabled:opacity-40" onClick={() => go(1)} disabled={!matches.length} title="Sonraki (Enter)" aria-label="Sonraki">
          <IconChevron size={14} />
        </IconButton>
        <IconButton onClick={find.close} title="Kapat (Esc)" aria-label="Bul ve değiştiri kapat">
          <IconClose size={14} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          className={FIELD}
          value={find.replacement}
          placeholder="Değiştir"
          aria-label="Yerine yazılacak"
          spellCheck
          lang={find.lang}
          onChange={(e) => find.setReplacement(e.target.value)}
          onKeyDown={keys(replaceOne)}
        />
        <Button className="h-[26px] flex-none px-2" onClick={replaceOne} disabled={!matches.length}>
          Değiştir
        </Button>
        <Button className="h-[26px] flex-none px-2" onClick={replaceAll} disabled={!matches.length}>
          Tümü
        </Button>
      </div>
    </div>
  );
}
