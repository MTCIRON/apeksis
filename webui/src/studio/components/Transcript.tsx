// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Word } from "../engine";
import { buildCues, importedCues, READING_RULES, type Cue } from "../lib/cues";
import type { Match } from "../lib/find";
import { clock } from "../lib/format";
import { IconEdit, IconTrash } from "./icons";
import { EmptyNote, IconButton } from "./ui";

interface Props {
  words: Word[];
  tentative: Word[];
  running: boolean;
  /** Running, but the model is still loading. */
  waiting?: boolean;
  time: number;
  playing: boolean;
  onSeek: (t: number) => void;
  /** Present when the transcript can be edited (decoding finished). */
  onEdit?: (first: number, count: number, text: string) => void;
  /** Find hits to mark, and which one is current. */
  found?: { matches: Match[]; current: number };
  /** Language of the words, for the spelling check while editing. */
  lang: string;
}

/** Index of the word being spoken at time t, or -1. */
function activeIndex(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && t < words[ans].end + 0.25 ? ans : -1;
}

function CueEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  useLayoutEffect(() => {
    const t = ref.current!;
    t.style.height = "0";
    t.style.height = `${t.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    const t = ref.current!;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="-my-[3px] block w-full resize-none overflow-hidden rounded-ui-sm border border-cini bg-bg px-1.5 py-0.5 text-[15px] leading-[1.6] font-[560] text-fg outline-none [font-family:inherit]"
      value={value}
      spellCheck
      aria-label="Satırı düzenle"
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onDone(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}

const CueRow = memo(function CueRow({
  cue,
  active,
  tentativeFrom,
  marks,
  onSeek,
  onEdit,
}: {
  cue: Cue;
  /** Index of the active word within this cue, or -1. */
  active: number;
  /** Words from this index on are still being decoded. */
  tentativeFrom: number;
  /** Per word: "1" inside a find hit, "2" inside the current one, else "0". Empty if none. */
  marks: string;
  onSeek: (t: number) => void;
  onEdit?: (first: number, count: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const text = cue.words.map((w) => w.text).join(" ");
  const finish = (value: string | null) => {
    setEditing(false);
    if (value !== null && value.trim() !== text) onEdit?.(cue.first, cue.words.length, value);
  };
  return (
    <li
      className={`group/cue relative grid scroll-m-10 grid-cols-[52px_minmax(0,1fr)] items-baseline border-l-2 py-1.5 pr-3.5 pl-0 transition-[background,border-color] duration-150 ease-[ease] ${
        active >= 0 ? "border-cini bg-linear-to-r from-cini-wash to-transparent to-75%" : "border-transparent"
      }`}
      data-start={cue.start}
    >
      <button
        className={`justify-self-start border-0 bg-transparent py-0 pr-0 pl-3 text-[11px] font-medium tabular-nums transition-colors duration-150 ease-[ease] [font-feature-settings:'tnum'_1] hover:text-wave-played ${
          active >= 0 ? "text-wave-played" : "text-fg-3"
        }`}
        onClick={() => onSeek(cue.start)}
        aria-label={`${clock(cue.start)} konumuna git`}
      >
        {clock(cue.start)}
      </button>
      {editing ? (
        <CueEditor initial={text} onDone={finish} />
      ) : (
        <p
          className="m-0 font-[family-name:var(--read)] text-[14.5px] leading-[1.65] font-[480] tracking-[-0.008em]"
          onDoubleClick={() => onEdit && setEditing(true)}>
          {cue.words.map((w, i) => (
            <span key={i}>
              <span
                className={`-mx-px inline-block rounded-[4px] px-[3px] py-px transition-[background,color] duration-150 ease-[ease] hover:bg-raised motion-reduce:transition-none ${
                  i === active
                    ? "bg-cini font-[550] text-white shadow-[0_1px_4px_rgba(71,109,230,0.4)]"
                    : marks[i] === "2"
                      ? "bg-[#e8b54a] text-[#1a1408]"
                      : marks[i] === "1"
                        ? "bg-[rgba(232,181,74,0.22)]"
                        : i >= tentativeFrom
                      ? "text-firuze"
                      : ""
                }`}
                onClick={() => onSeek(w.start)}
              >
                {w.text}
              </span>{" "}
            </span>
          ))}
        </p>
      )}
      {onEdit && !editing && (
        <span className="absolute top-[3px] right-1.5 hidden gap-0.5 rounded-ui bg-raised p-0.5 group-hover/cue:flex focus-within:flex">
          <IconButton onClick={() => setEditing(true)} title="Düzenle (çift tıkla)" aria-label="Satırı düzenle">
            <IconEdit />
          </IconButton>
          <IconButton onClick={() => onEdit(cue.first, cue.words.length, "")} title="Satırı sil" aria-label="Satırı sil">
            <IconTrash />
          </IconButton>
        </span>
      )}
    </li>
  );
},
// Cues are rebuilt on every progress update; only re-render rows that changed.
(a, b) =>
  a.active === b.active &&
  a.tentativeFrom === b.tentativeFrom &&
  a.marks === b.marks &&
  a.onSeek === b.onSeek &&
  a.onEdit === b.onEdit &&
  a.cue.first === b.cue.first &&
  a.cue.words.length === b.cue.words.length &&
  a.cue.words.every((w, i) => w === b.cue.words[i]));

export function Transcript({ words, tentative, running, waiting, time, playing, onSeek, onEdit, found, lang }: Props) {
  const all = useMemo(() => (tentative.length ? words.concat(tentative) : words), [words, tentative]);
  const cues = useMemo(() => importedCues(all) ?? buildCues(all, READING_RULES), [all]);
  // Per cue, a string of find marks (see CueRow); "" where nothing is marked.
  const marks = useMemo(() => {
    if (!found?.matches.length) return null;
    const m = new Uint8Array(all.length);
    found.matches.forEach((h, k) => m.fill(k === found.current ? 2 : 1, h.first, h.last + 1));
    return cues.map((c) => {
      const part = m.subarray(c.first, c.first + c.words.length);
      return part.some(Boolean) ? part.join("") : "";
    });
  }, [all, cues, found]);
  const active = playing || time > 0 ? activeIndex(all, time) : -1;
  const list = useRef<HTMLOListElement>(null);
  const userScrolledAt = useRef(0);

  // Follow the playhead, unless the reader scrolled on their own recently.
  const activeCue = active < 0 ? -1 : cues.findIndex((c) => active < c.first + c.words.length);
  useEffect(() => {
    if (activeCue < 0 || !playing || Date.now() - userScrolledAt.current < 4000) return;
    list.current?.children[activeCue]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeCue, playing]);

  // Bring the current find hit into view.
  const hit = found?.matches[found.current]?.first ?? -1;
  const hitCue = hit < 0 ? -1 : cues.findIndex((c) => hit < c.first + c.words.length);
  useEffect(() => {
    if (hitCue >= 0) list.current?.children[hitCue]?.scrollIntoView({ block: "nearest" });
  }, [hitCue, hit]);

  // While decoding, keep the newest line in view if the reader is at the end.
  // The list scrolls inside its panel (the nearest scrollable ancestor).
  const nearEnd = useRef(true);
  useEffect(() => {
    const el = list.current?.closest("[data-scroll]");
    if (!el) return;
    const onScroll = () => {
      nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    const onUser = () => (userScrolledAt.current = Date.now());
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUser, { passive: true });
    el.addEventListener("touchmove", onUser, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUser);
      el.removeEventListener("touchmove", onUser);
    };
  }, [all.length > 0]);
  useEffect(() => {
    if (running && !playing && nearEnd.current) {
      list.current?.lastElementChild?.scrollIntoView({ block: "end" });
    }
  }, [cues.length, running, playing]);

  if (!all.length) {
    return (
      <EmptyNote aria-live="polite">
        {waiting
          ? "Model hazırlanıyor, bitince yazıya dökme başlayacak."
          : running
            ? "Konuşma bekleniyor…"
            : "Bu dosyada konuşma bulunamadı."}
      </EmptyNote>
    );
  }

  return (
    <ol className="m-0 list-none p-0 pb-6" ref={list} lang={lang}>
      {cues.map((c, i) => {
        const end = c.first + c.words.length;
        return (
          <CueRow
            key={c.first}
            cue={c}
            active={active >= c.first && active < end ? active - c.first : -1}
            tentativeFrom={Math.min(c.words.length, Math.max(0, words.length - c.first))}
            marks={marks?.[i] ?? ""}
            onSeek={onSeek}
            onEdit={onEdit}
          />
        );
      })}
    </ol>
  );
}
