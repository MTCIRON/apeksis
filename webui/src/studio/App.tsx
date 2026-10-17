// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  presetById,
  type CaptionSettings,
} from "./captions/style";
import { useStoredValue } from "../shell/panels";
import {
  DEFAULT_SETTINGS_SECTION,
  settingsSection,
  type SettingsSectionId,
} from "./lib/settingsSections";
import { ExportMenu } from "./components/ExportMenu";
import { MenuTitle } from "./components/Menu";
import {
  Button,
  EmptyNote,
  IconButton,
  LinkButton,
  Pane,
  PaneBody,
  PaneHead,
  PaneMeta,
  PaneTitle,
  TbLabel,
  toolbarButton,
} from "./components/ui";
import { Dropzone } from "./components/Dropzone";
import { FindBar, useFind } from "./components/FindBar";
import {
  ProjectList,
  ProjectName,
  ProjectsMenu,
} from "./components/ProjectsMenu";
import {
  IconMic,
  IconMuted,
  IconOpen,
  IconPause,
  IconPlay,
  IconSettings,
  IconSound,
  IconSearch,
  IconUndo,
} from "./components/icons";
import { RecordButton } from "./components/RecordButton";
import { Inspector } from "./components/Inspector";
import { SessionBar } from "./components/SessionBar";
import { ModelMenu } from "./components/ModelMenu";
import { MoreMenu } from "./components/MoreMenu";
import { Settings } from "./components/Settings";
import { ProviderMenu } from "./components/ProviderMenu";
import { StatusBar } from "./components/StatusBar";
import { Timeline, TIMELINE } from "./components/Timeline";
import { Transcript } from "./components/Transcript";
import { Viewer } from "./components/Viewer";
import { Wordmark } from "../shell/wordmark";
import type { DecodeOptions, DecodingMethod, Word } from "./engine";
import { buildCues } from "./lib/cues";
import { replaceRange } from "./lib/edit";
import { writeNumbers, type NumberMode } from "./lib/numbers";
import { plainWord } from "./punct/turkish";
import { isSubtitle, parseSubtitles, readSubtitle, SUBTITLE_EXTS } from "./lib/subtitles";
import { download } from "./lib/exporters";
import { clock, duration as fmtDuration } from "./lib/format";
import { LEGACY_PROJECT_EXTS, PROJECT_EXT, isProjectFile, projectTitle, sameMedia } from "./lib/projectStore";
import { useBurner } from "./lib/useBurner";
import { useSourceInfo } from "./lib/useSourceInfo";
import {
  effectiveOutput,
  loadOutput,
  resolutionOf,
  saveOutput,
  undecodable,
  videoBitrate,
  type VideoOutput,
} from "./lib/videoOutput";
import { usePlayer } from "./lib/usePlayer";
import { useFollow } from "./lib/useFollow";
import { useDubber, useDubPlayback } from "./lib/useDubber";
import { loadChoice, sameChoice, type VoiceChoice } from "./lib/voices";
import { useProjects } from "./lib/useProjects";
import { useGateway } from "../lib/useGateway";
import { pushLog } from "../lib/debug";
import { canResume, modelIsCached, useTranscriber } from "./lib/useTranscriber";
import { useTranslator } from "./lib/useTranslator";
import { sourceKey } from "./lib/translation";
import { TRANSCRIPT_LANG } from "./lib/lang";
import { squash } from "./lib/find";
import { lastTurnText } from "./lib/turns";
import { useSession } from "./lib/useSession";
import { useServerSpeak, type SpeakVoice } from "./lib/useServerSpeak";
import { DEFAULT_MODEL, modelInfo } from "./models";

const EMPTY_BANDS = new Float32Array(0);
/** Play and mute in the transport bar. */
const TP_BTN =
  "grid size-8 flex-none place-items-center rounded-ui border-0 bg-transparent text-fg transition-all duration-150 ease-[ease] hover:not-disabled:bg-raised hover:not-disabled:text-white disabled:opacity-35 max-[860px]:size-10";
/** TR / EN in the transcript pane's head. */
const LANG_BTN =
  "h-5 rounded-[4px] border-0 bg-transparent px-1.5 text-[10.5px] font-semibold tracking-[0.02em] text-fg-3 hover:not-disabled:text-fg aria-pressed:bg-raised aria-pressed:text-white disabled:opacity-45";
/** Welcome-screen buttons: long file names are cut; full width on phones. */
const DROP_BTN =
  "min-w-0 max-w-full truncate max-[480px]:h-11 max-[480px]:w-full [&_svg]:mr-1.5";
const ACCEPT = `audio/*,video/*,.mkv,.mov,.m4a,.flac,.ogg,.opus,${SUBTITLE_EXTS},${[PROJECT_EXT, ...LEGACY_PROJECT_EXTS].join(",")}`;

type PickerWindow = Window & {
  showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>;
};
type HandleItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};
// Chromium's picker returns a handle, so a project can reopen the file later.
const PICKER_TYPES = [
  {
    description: "Video, ses, altyazı veya Apeksis projesi",
    accept: {
      "video/*": [".mp4", ".mov", ".mkv", ".webm", ".m4v"],
      "audio/*": [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac"],
      "application/x-subrip": [".srt"],
      "text/vtt": [".vtt"],
      "application/json": [PROJECT_EXT, ...LEGACY_PROJECT_EXTS],
    },
  },
];

const optionsFor = (method: DecodingMethod): DecodeOptions => ({
  method,
  maxActivePaths: 4,
  lmScale: 0.6,
  lodrScale: -0.5,
});

function loadSettings(): CaptionSettings {
  try {
    return noEmphasis({
      ...DEFAULT_SETTINGS,
      ...JSON.parse(localStorage.getItem("apeksis.captions") ?? "{}"),
    });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// A new project starts without "Sesle vurgula"; the rest of the look carries over.
const noEmphasis = (s: CaptionSettings) => (s.voiceEmphasis ? { ...s, voiceEmphasis: false } : s);

function baseName(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Seconds of transcription work after which cancelling asks first. */
const LONG_JOB_SEC = 60;

export function useStudioEngine() {
  const {
    engine,
    job,
    liveWaiting,
    provider,
    setProvider,
    model,
    setModel,
    prepare,
    start,
    load,
    attach,
    clear,
    startLive,
    stopLive,
    cancel,
    resume,
    setWords,
    setTranslation,
    liveLevels,
    liveMeter,
    punctuate,
    punct,
  } = useTranscriber();
  const [autoPunct, setAutoPunct] = useState(
    () => localStorage.getItem("apeksis.punct") !== "off",
  );
  useEffect(
    () => localStorage.setItem("apeksis.punct", autoPunct ? "on" : "off"),
    [autoPunct],
  );
  const [numberMode, setNumberMode] = useState<NumberMode>(() => {
    const saved = localStorage.getItem("apeksis.numbers");
    return saved === "all" || saved === "keep" ? saved : "rule";
  });
  useEffect(() => localStorage.setItem("apeksis.numbers", numberMode), [numberMode]);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which settings section is on screen: remembered, and deep-linkable (9b). */
  const [rememberedSection, setRememberedSection] = useStoredValue("settings.section", DEFAULT_SETTINGS_SECTION);
  const section = settingsSection(rememberedSection);
  /** Open the settings window, optionally straight into one section. */
  const showSettings = useCallback(
    (id: SettingsSectionId) => {
      setRememberedSection(id);
      setSettingsOpen(true);
    },
    [setRememberedSection],
  );
  const [method, setMethod] = useState<DecodingMethod>("beam-lm");
  const [settings, setSettings] = useState<CaptionSettings>(loadSettings);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const burner = useBurner();
  /** The gateway's own health, for the single status bar (Aşama 8). */
  const gateway = useGateway();
  /** The workspace's notices land in the single log too (Ayarlar → Günlük). */
  useEffect(() => {
    if (notice) pushLog({ kind: "ui", method: "BİLDİRİM", path: "çalışma alanı", detail: notice });
  }, [notice]);
  const [videoOutput, setVideoOutput] = useState<VideoOutput>(loadOutput);
  const player = usePlayer(job?.file ?? null);
  const following = useFollow(player, job);
  const dubber = useDubber();
  const translator = useTranslator();
  /** Show the English translation instead of the transcript, once there is one. */
  const [showEn, setShowEn] = useState(false);
  /** Play and export the dub instead of the original sound, once there is one. */
  const [dubOn, setDubOn] = useState(true);
  const dub = dubber.state.status === "done" ? dubber.state : null;
  const dubbing = dub && dubOn ? dub : null;
  useDubPlayback(player.el, dub?.url ?? null, !!dubbing);
  const [voice, setVoice] = useState<VoiceChoice>(() => loadChoice(localStorage.getItem("apeksis.voice")));
  useEffect(() => localStorage.setItem("apeksis.voice", JSON.stringify(voice)), [voice]);

  // Aşama 9 — the conversation: one gateway session, the turns sent to it and
  // the action each turn answers with. The reply is spoken over the streaming
  // TTS socket, and the workspace's own media element is paused first so two
  // sounds are never heard at once.
  const session = useSession();
  // Live mode is the workspace's conversation mode and is independent of the
  // agent session: the microphone and the live transcript work with no agent
  // backend configured. The agent session (n8n) is opened lazily by the first
  // turn that is sent — never by starting live mode.
  const [liveMode, setLiveMode] = useState(false);
  const speak = useServerSpeak(() => player.el?.pause());
  // The transcript selection, the same gesture the find bar already reads.
  const [selection, setSelection] = useState("");
  useEffect(() => {
    const read = () => setSelection(squash(window.getSelection()?.toString() ?? ""));
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);
  /** The voice a reply is spoken with: the user's server voice, else the gateway default. */
  const speakVoice: SpeakVoice = useMemo(
    () =>
      voice.provider === "sunucu"
        ? { model: voice.model, voice: voice.voice, speed: voice.speed }
        : { model: "ema-lightning", voice: "ema-tr" },
    [voice],
  );
  const {
    projects: saved,
    voxiImport,
    current,
    saveable,
    noteHandle,
    open: openSaved,
    fromHandle,
    bind,
    remove,
    rename,
    importFile,
    exportText,
  } = useProjects(job, settings);
  // The one-time Voxi import: say what moved, once.
  const imported = voxiImport?.imported ?? 0;
  const skipped = voxiImport?.skipped ?? 0;
  useEffect(() => {
    if (!voxiImport || voxiImport.alreadyDone) return;
    setNotice(
      imported
        ? `${imported} eski proje içe aktarıldı${skipped ? `, ${skipped} tanesi okunamadı` : ""}. Dalga biçimi medyadan yeniden hesaplandı.`
        : null,
    );
  }, [voxiImport, imported, skipped]);
  /** A saved project opened without its media (not stored, or not found). */
  const needsMedia =
    !!job && !job.file && !job.live && (!!current || !!job.imported);
  /** The project's stored file handle, waiting for the user's permission. */
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemFileHandle | null>(null);
  /** The last project file opened: picking its media starts in that folder. */
  const projectHandle = useRef<FileSystemFileHandle | null>(null);
  // Jobs already punctuated or given digits (or opened from a project): not done again.
  const punctuated = useRef(new Set<number>());

  useEffect(
    () => localStorage.setItem("apeksis.captions", JSON.stringify(settings)),
    [settings],
  );
  // Open the model right away when it is already in the cache.
  const initialModel = useRef(model);
  useEffect(() => {
    modelIsCached(initialModel.current).then((yes) => yes && prepare());
  }, [prepare]);

  const resetBurn = burner.reset;
  // A dub belongs to its job; an export made with or without it is out of date once that changes.
  const resetDub = dubber.reset;
  useEffect(() => resetDub(), [job?.id, resetDub]);
  useEffect(() => resetBurn(), [dubbing, resetBurn]);
  const openProject = useCallback(
    async (id: string) => {
      try {
        const r = await openSaved(id);
        if (!r) return;
        const { project: p, file, handle } = r;
        resetBurn();
        setPendingHandle(handle);
        setNotice(
          file && !sameMedia(p.media, file)
            ? "Medya dosyası proje kaydedildikten sonra değişmiş görünüyor, zamanlar kayabilir."
            : null,
        );
        setSettings(p.settings);
        setMethod(p.method);
        const jobId = load({
          file,
          model: p.model ?? DEFAULT_MODEL,
          options: optionsFor(p.method),
          duration: p.duration,
          elapsed: p.elapsed,
          stoppedAt: p.stoppedAt,
          imported: p.imported,
          words: p.words,
          peaks: p.peaks,
          bands: p.bands,
          loudness: p.loudness ?? EMPTY_BANDS,
          translation: p.translation,
        });
        punctuated.current.add(jobId);
        bind(jobId, p, file);
      } catch {
        setNotice("Proje açılamadı.");
      }
    },
    [openSaved, resetBurn, load, bind],
  );
  const importProject = useCallback(
    async (f: File) => {
      try {
        const p = await importFile(f);
        await openProject(p.id);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [importFile, openProject],
  );
  // A subtitle file becomes a new project, with the open media if there is one.
  // The transcript it replaces stays in its own project.
  const openSubtitle = useCallback(
    async (f: File) => {
      if (job?.recording) {
        setNotice("Kayıt sürerken altyazı açılamaz; önce kaydı durdur.");
        return;
      }
      let subs: Word[];
      try {
        subs = parseSubtitles(await readSubtitle(f));
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Altyazı dosyası okunamadı.");
        return;
      }
      const media = job?.file ? job : null;
      setNotice(null);
      setPendingHandle(null);
      setSettings(noEmphasis);
      resetBurn();
      const jobId = load({
        file: media?.file ?? null,
        model: job?.model ?? model,
        imported: f.name,
        options: optionsFor(method),
        duration: media?.duration ?? null,
        elapsed: null,
        words: subs,
        peaks: media?.peaks ?? new Float32Array(0),
        bands: media?.bands ?? EMPTY_BANDS,
        loudness: media?.loudness ?? EMPTY_BANDS,
      });
      punctuated.current.add(jobId);
    },
    [job, model, method, load, resetBurn],
  );
  const openFile = useCallback(
    (f: File, handle?: FileSystemFileHandle) => {
      if (isSubtitle(f.name)) {
        void openSubtitle(f);
        return;
      }
      if (isProjectFile(f.name)) {
        projectHandle.current = handle ?? null;
        void importProject(f);
        return;
      }
      if (handle) noteHandle(f, handle);
      // A project waiting for its media takes the file, if it is the one.
      if (
        needsMedia &&
        (sameMedia(current?.media ?? null, f) ||
          confirm(
            `“${f.name}”, bu projenin dosyasıyla (“${current?.media?.name}”) aynı görünmüyor. ` +
              "Yine de projeye bağlansın mı? İptal dersen yeni bir döküm başlar.",
          ))
      ) {
        setNotice(null);
        setPendingHandle(null);
        attach(f);
        return;
      }
      setPendingHandle(null);
      setSettings(noEmphasis);
      resetBurn();
      start(f, optionsFor(method));
    },
    [
      start,
      method,
      resetBurn,
      openSubtitle,
      importProject,
      noteHandle,
      needsMedia,
      current,
      attach,
    ],
  );
  const pickFile = useCallback(async () => {
    const w = window as PickerWindow;
    if (!w.showOpenFilePicker) return picker.current?.click();
    try {
      const startIn = needsMedia
        ? (pendingHandle ?? projectHandle.current)
        : null;
      const [h] = await w.showOpenFilePicker({
        id: "apeksis-media",
        types: PICKER_TYPES,
        ...(startIn && { startIn }),
      });
      openFile(await h.getFile(), h);
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") picker.current?.click();
    }
  }, [openFile, needsMedia, pendingHandle]);
  const allowHandle = async () => {
    if (!pendingHandle) return;
    const file = await fromHandle(pendingHandle);
    if (file) {
      setPendingHandle(null);
      attach(file);
    } else {
      setPendingHandle(null);
      setNotice(
        "Dosyaya ulaşılamadı, taşınmış ya da silinmiş olabilir. Yeniden seç.",
      );
    }
  };
  const newProject = () => {
    setNotice(null);
    setPendingHandle(null);
    setSettings(noEmphasis);
    resetBurn();
    clear();
  };

  // A wrong file: stop and drop it, nothing is saved. Asks first once a
  // minute of work would be thrown away.
  const discardJob = () => {
    if (!job) return;
    const worked = job.speed > 0 ? job.decoded / job.speed : 0;
    if (
      worked >= LONG_JOB_SEC &&
      !confirm(`Yazıya dökme iptal edilsin mi? Şimdiye kadar dökülen ${fmtDuration(job.decoded)} silinir, proje kaydedilmez.`)
    ) {
      return;
    }
    newProject();
  };

  // Go on with a stopped transcription; the whole transcript is punctuated
  // once it is done, as if it had never stopped.
  const resumeJob = canResume(job)
    ? () => {
        punctuated.current.delete(job.id);
        resume();
      }
    : undefined;

  // Deleting the open project moves on to the next most recent one.
  const deleteProject = async (id: string) => {
    const wasOpen = current?.id === id;
    await remove(id);
    if (!wasOpen) return;
    const next = saved.find((p) => p.id !== id);
    if (next) void openProject(next.id);
    else newProject();
  };

  // The whole window is a drop target.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer!.files[0];
      if (!f) return;
      // The handle has to be asked for while the drop event is running.
      const item = [...e.dataTransfer!.items].find((i) => i.kind === "file");
      const handle = (
        item as HandleItem | undefined
      )?.getAsFileSystemHandle?.();
      if (!handle) return openFile(f);
      handle.then(
        (h) =>
          openFile(
            f,
            h?.kind === "file" ? (h as FileSystemFileHandle) : undefined,
          ),
        () => openFile(f),
      );
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  /** The transcript as spoken; dubbing, punctuation and numbers always work on it. */
  const words = job?.words ?? [];
  const translation = job?.translation;
  const english = showEn && !!translation;
  const lang = english ? "en" : TRANSCRIPT_LANG;
  /** What the transcript pane, the player and the exports show: the transcript or its translation. */
  const shown = english ? translation.words : words;
  const liveWords = useMemo(
    () =>
      english
        ? translation.words
        : job?.tentative.length
          ? (job.words ?? []).concat(job.tentative)
          : (job?.words ?? []),
    [english, translation, job?.words, job?.tentative],
  );
  // Timeline blocks follow the grouping of the chosen caption style.
  const groups = useMemo(
    () => buildCues(liveWords, presetById(settings.preset).grouping),
    [liveWords, settings.preset],
  );
  const translationStale = useMemo(
    () => !!translation && translation.source !== sourceKey(words),
    [translation, words],
  );
  // A translation belongs to its job.
  const cancelTranslation = translator.cancel;
  useEffect(() => cancelTranslation(), [job?.id, cancelTranslation]);
  // A video made in the other language is out of date.
  useEffect(() => resetBurn(), [lang, resetBurn]);

  // Transcript edits, with undo (⌘Z / Ctrl+Z outside text fields). `en`: the edit was to the translation.
  const history = useRef<{ jobId: number; en: boolean; words: Word[] }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const editable = !!job && job.status !== "running" && shown.length > 0;
  const commitWords = useCallback(
    (next: Word[]) => {
      if (!job) return;
      history.current.push({ jobId: job.id, en: english, words: shown });
      setCanUndo(true);
      if (english) setTranslation(job.id, { ...translation, words: next });
      else setWords(next);
      if (burner.state.status === "done") resetBurn();
    },
    [job, english, shown, translation, setWords, setTranslation, burner.state.status, resetBurn],
  );
  const onEdit = useCallback(
    (first: number, count: number, text: string) => commitWords(replaceRange(shown, first, count, text)),
    [shown, commitWords],
  );
  const undo = useCallback(() => {
    const h = history.current;
    while (h.length && h[h.length - 1].jobId !== job?.id) h.pop();
    const prev = h.pop();
    if (prev?.en && job?.translation) {
      setTranslation(job.id, { ...job.translation, words: prev.words });
      setShowEn(true);
    } else if (prev && !prev.en) {
      setWords(prev.words);
      setShowEn(false);
    }
    setCanUndo(h.length > 0);
  }, [job?.id, job?.translation, setWords, setTranslation]);
  const translate = () => {
    if (!job) return;
    const id = job.id;
    const before = job.translation;
    translator.translate(words, (t) => {
      // A new translation replaces any edits to the old one; ⌘Z brings them back.
      if (before) {
        history.current.push({ jobId: id, en: true, words: before.words });
        setCanUndo(true);
      }
      setTranslation(id, t);
      setShowEn(true);
    });
  };
  const find = useFind(shown, lang);
  const { close: closeFind, show: showFind } = find;
  const found = useMemo(
    () => (find.open && editable ? { matches: find.matches, current: find.current } : undefined),
    [find.open, editable, find.matches, find.current],
  );
  useEffect(() => {
    history.current = [];
    setCanUndo(false);
    closeFind();
  }, [job?.id, closeFind]);

  const chosen = modelInfo(model);
  // Why GPU-only models cannot run here, if they cannot.
  const gpuReason =
    provider === "wasm"
      ? "İşlemci (WASM) seçili; bu model ekran kartı gerektirir."
      : !("gpu" in navigator)
        ? "Bu tarayıcı WebGPU desteklemiyor."
        : engine.phase === "ready" && engine.provider === "wasm" && !chosen.gpuOnly && !chosen.cpuOnly
          ? (engine.fallbackReason ?? "Ekran kartı kullanılamıyor.")
          : null;

  const withDigits = useCallback((list: Word[]) => writeNumbers(list, numberMode), [numberMode]);
  // Punctuation and capitals, then numbers in digits, once per finished
  // transcript (one undo restores the plain text).
  const applyPunct = useCallback(async () => {
    if (!job || job.status !== "done" || !job.words.length) return;
    punctuated.current.add(job.id);
    const source = job.words;
    try {
      const written = await punctuate(
        source.map((w) => plainWord(w.text) || w.text),
      );
      // Words already in digits ("1923'te") keep their writing; only the punctuation after them changes.
      const keep = (old: string, now: string) =>
        /\d/.test(old) ? old.replace(/[.,;:!?…]+$/, "") + (/[.,;:!?…]+$/.exec(now)?.[0] ?? "") : now;
      history.current.push({ jobId: job.id, en: false, words: source });
      setCanUndo(true);
      setWords(withDigits(source.map((w, i) => ({ ...w, text: keep(w.text, written[i]) }))));
    } catch {
      // Shown in the status bar; the transcript stays as it was.
    }
  }, [job, punctuate, setWords, withDigits]);
  // Numbers on their own: for Whisper, with punctuation off, or from the button.
  const applyNumbers = useCallback(() => {
    if (!job || job.status !== "done" || !job.words.length || numberMode === "keep") return;
    punctuated.current.add(job.id);
    const next = withDigits(job.words);
    if (next.every((w, i) => w === job.words[i])) return;
    history.current.push({ jobId: job.id, en: false, words: job.words });
    setCanUndo(true);
    setWords(next);
  }, [job, numberMode, setWords, withDigits]);
  // Whisper punctuates by itself; numbers are written the chosen way for every model.
  useEffect(() => {
    if (job?.status !== "done" || !job.words.length || punctuated.current.has(job.id)) return;
    // A server transcript is the server Whisper's own punctuation: leave it as it is.
    if (job.server) {
      if (numberMode !== "keep") applyNumbers();
      return;
    }
    if (autoPunct && !modelInfo(job.model).punctuates) void applyPunct();
    else if (numberMode !== "keep") applyNumbers();
  }, [autoPunct, numberMode, job?.status, job?.id, job?.model, job?.server, job?.words.length, applyPunct, applyNumbers]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not behind an open window (settings).
      if ((e.target as HTMLElement).closest("dialog")) return;
      const inField = !!(e.target as HTMLElement).closest(
        "input, textarea, select, [contenteditable]",
      );
      if (
        !inField &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        if (job?.recording || liveWaiting) void stopLive();
        else void goLiveRef.current();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f" &&
        editable
      ) {
        e.preventDefault();
        showFind();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        if (
          (e.target as HTMLElement).closest(
            "input, textarea, [contenteditable]",
          )
        )
          return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, job?.recording, liveWaiting, stopLive, editable, showFind]);

  const sourceInfo = useSourceInfo(job?.file ?? null);
  // A picture this browser cannot decode (AV1 in Safari without the hardware for it): said up front, not at export.
  const badCodec = undecodable(sourceInfo);
  const changeOutput = (o: VideoOutput) => {
    setVideoOutput(o);
    saveOutput(o);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };
  const burnVideo = () => {
    if (!job?.file) return;
    const out = effectiveOutput(videoOutput, sourceInfo);
    const resolution = sourceInfo && resolutionOf(out, sourceInfo);
    const encode = {
      codec: out.codec,
      bitrate: sourceInfo ? videoBitrate(out, sourceInfo) : null,
      encoder: resolution?.encoders[out.codec] ?? null,
      size: resolution && { width: resolution.width, height: resolution.height },
    };
    // Translated words are not timed by the voice, so "Sesle vurgula" has nothing to go by.
    const loudness = english ? EMPTY_BANDS : job.loudness;
    void burner.burn(job.file, shown, settings, job.bands, loudness, lang, encode, dubbing?.clips ?? null, `${exportName}.altyazili.mp4`);
  };

  const changeSettings = (s: CaptionSettings) => {
    setSettings(s);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };

  const title = current
    ? projectTitle(current)
    : (job?.file?.name ?? (job?.live ? "Canlı kayıt" : ""));
  const name = current
    ? projectTitle(current)
    : job?.file
      ? baseName(job.file.name)
      : "canli-kayit";
  /** Exports of the translation say so in their name. */
  const exportName = english ? `${name}.en` : name;
  const exportProject = () => {
    const text = exportText();
    if (text) download(`${name}${PROJECT_EXT}`, text, "application/json");
  };

  // A browser model must be one that streams (seda) to transcribe the
  // microphone. The server provider streams too — over
  // `WS /v1/realtime/transcriptions` — so it is never blocked.
  const micBlocked =
    provider === "sunucu" || chosen.live
      ? null
      : `Canlı kayıt ${chosen.name} ile yapılamaz; mikrofon için üst çubuktan ${modelInfo(DEFAULT_MODEL).name}'yı seç.`;
  // A finished transcript made somewhere other than the choice now: another
  // model, or the server instead of the browser (and the other way round).
  const otherModel = (() => {
    if (!job || job.status === "running" || !job.file || job.imported) return null;
    if (job.server) return provider === "sunucu" ? null : { name: "Sunucu (Apeksis)" };
    if (provider === "sunucu") return modelInfo(job.model);
    return job.model !== model ? modelInfo(job.model) : null;
  })();
  // A transcription in progress: switching model or provider would abort it.
  const engineBusy =
    job?.status === "running" ||
    punct.phase === "run" ||
    punct.phase === "download";
  const modelProps = {
    value: model,
    onChange: setModel,
    gpuReason,
    locked: engineBusy,
    server: provider === "sunucu",
  };
  const providerProps = {
    value: provider,
    engine,
    onChange: setProvider,
    cpuUnavailable: chosen.gpuOnly
      ? `${chosen.name} işlemcide çalışmaz; önce Seda'ya geç.`
      : null,
    gpuUnavailable: chosen.cpuOnly ? `${chosen.name} yalnızca işlemcide çalışır.` : null,
    locked: engineBusy,
  };
  const goLiveRef = useRef<() => Promise<void>>(async () => {});
  const goLive = async () => {
    setNotice(null);
    resetBurn();
    // Opening the microphone puts the workspace in live mode; the agent session
    // stays untouched until a turn is sent.
    setLiveMode(true);
    if (micBlocked) return;
    setSettings(noEmphasis);
    try {
      await startLive(optionsFor(method));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  goLiveRef.current = goLive;

  // The grid shell (shell/AppShell) owns the layout; this hook only builds the
  // content of each slot, so the same chrome can host the Voxi panels too.
  const header = (
    <>
      {/* On phones only the title may shrink; buttons keep their size. */}
        <h1 className="m-0 mr-2.5 flex items-center max-[480px]:mr-1">
          {/* The product wordmark: a webfont, not an image (see shell/wordmark.tsx). */}
          <Wordmark className="text-[17px] text-white" />
        </h1>
        <span
          className="-ml-1.5 mr-2 text-[11px] tabular-nums text-fg-3 max-[480px]:hidden"
          title="Bu sürüm"
        >
          v{__APP_VERSION__}
        </span>
        <button
          className={toolbarButton({ compact: true })}
          onClick={pickFile}
          title="Dosya aç"
        >
          <IconOpen /> <TbLabel>Dosya aç</TbLabel>
        </button>
        <ProjectsMenu
          projects={saved}
          currentId={current?.id}
          canExport={saveable}
          onOpen={openProject}
          onDelete={deleteProject}
          onNew={newProject}
          onExport={exportProject}
          onImport={pickFile}
        />
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = "";
          }}
        />
        <ProjectName
          key={current?.id}
          title={title}
          onRename={current ? (n) => rename(current.id, n) : undefined}
        />
        {job && (
          <ExportMenu
            words={shown}
            baseName={exportName}
            meta={{
              file: title,
              model: modelInfo(job.model).spec,
              ...(job.model === "seda" && { method: job.options.method }),
            }}
            complete={job.status === "done"}
            isVideo={player.isVideo}
            canBurn={!!job.file}
            burn={burner.state}
            output={videoOutput}
            onOutput={changeOutput}
            source={sourceInfo}
            onBurn={burnVideo}
            onCancelBurn={burner.cancel}
            onResetBurn={burner.reset}
          />
        )}
        {/* Phones fold the model, provider and settings into "⋯". */}
        <div className="max-[480px]:hidden">
          <ModelMenu {...modelProps} />
        </div>
        <div className="max-[480px]:hidden">
          <ProviderMenu {...providerProps} />
        </div>
        <button
          className={`${toolbarButton({ compact: true })} max-[480px]:hidden`}
          onClick={() => setSettingsOpen(true)}
          title="Ayarlar: sunucu, modeller, günlük"
        >
          <IconSettings /> <TbLabel>Ayarlar</TbLabel>
        </button>
        <div className="hidden max-[480px]:block">
          <MoreMenu model={modelProps} provider={providerProps} onSettings={() => setSettingsOpen(true)} />
        </div>
    </>
  );

  // The session bar sits above the transcript: one window, no second text box.
  // "Oturum başlat" turns on live mode — the microphone with whichever provider
  // the toolbar has selected. The agent session is a separate thing: it is opened
  // lazily by the first turn that is sent, so live transcription never waits on
  // (or fails because of) an agent backend such as n8n.
  const sessionBar = (
    <SessionBar
      live={liveMode}
      sessionOpen={!!session.session}
      turns={session.turns}
      busy={session.busy}
      error={session.error}
      selection={selection}
      lastTurn={lastTurnText(job?.words ?? [])}
      recording={!!job?.recording}
      speak={speak}
      voice={speakVoice}
      onStart={() => {
        void (async () => {
          setLiveMode(true);
          // An empty workspace has nothing to talk about yet, so live mode opens
          // the microphone. With a transcript already open live mode attaches to
          // it instead — recording would replace it.
          if (!job) await goLive();
        })();
      }}
      onEnd={() => {
        void (async () => {
          setLiveMode(false);
          if (job?.recording) void stopLive();
          await session.end();
        })();
      }}
      onSend={(text) => void session.send(text, { language: TRANSCRIPT_LANG })}
      onRecord={() => void (job?.recording ? stopLive() : goLive())}
      onDismissError={session.dismissError}
    />
  );

  const left = (
    <Pane side="left" label="Transkript">
          <PaneHead>
            <PaneTitle>Transkript</PaneTitle>
            {translation && (
              <span
                className="mr-auto -my-1 flex gap-0.5 rounded-md border border-line-soft bg-[#101316] p-0.5"
                role="group"
                aria-label="Gösterilen dil"
              >
                {[
                  { en: false, label: "TR", title: "Türkçe transkript" },
                  { en: true, label: "EN", title: "İngilizce çeviri" },
                ].map((o) => (
                  <button
                    key={o.label}
                    className={LANG_BTN}
                    aria-pressed={english === o.en}
                    title={o.title}
                    disabled={job?.status === "running"}
                    onClick={() => setShowEn(o.en)}
                  >
                    {o.label}
                  </button>
                ))}
              </span>
            )}
            {job && liveWords.length > 0 && (
              <PaneMeta>{liveWords.length} kelime</PaneMeta>
            )}
            {(canUndo || editable) && (
              <span className="-my-1 -mr-1 flex gap-0.5 self-center">
                {editable && (
                  <IconButton
                    className={found ? "bg-line text-fg" : ""}
                    onClick={found ? closeFind : showFind}
                    aria-pressed={!!found}
                    title="Bul ve değiştir (⌘F)"
                    aria-label="Bul ve değiştir"
                  >
                    <IconSearch />
                  </IconButton>
                )}
                {canUndo && (
                  <IconButton
                    onClick={undo}
                    title="Geri al (⌘Z)"
                    aria-label="Son düzenlemeyi geri al"
                  >
                    <IconUndo />
                  </IconButton>
                )}
              </span>
            )}
          </PaneHead>
          {sessionBar}
          {found && (
            <FindBar
              find={find}
              words={shown}
              onReplace={commitWords}
              onGo={(m) => player.seek(shown[m.first].start)}
            />
          )}
          {otherModel && (
            <div className="flex flex-none items-center gap-2.5 border-b border-line-soft bg-cini-wash px-3.5 py-2 text-[12px] text-fg-2">
              <span className="min-w-0 flex-1">
                Bu döküm {otherModel.name} ile yapıldı.
              </span>
              <Button
                variant="primary"
                className="flex-none"
                onClick={() => job?.file && openFile(job.file)}
              >
                {provider === "sunucu" ? "Sunucuda yeniden dök" : `${chosen.name} ile yeniden dök`}
              </Button>
            </div>
          )}
          <PaneBody>
            {job ? (
              <Transcript
                words={shown}
                tentative={english ? [] : job.tentative}
                lang={lang}
                running={job.status === "running"}
                waiting={
                  job.status === "running" &&
                  !job.live &&
                  engine.phase !== "ready" &&
                  engine.phase !== "error"
                }
                time={player.time}
                playing={player.playing}
                onSeek={player.seek}
                onEdit={editable ? onEdit : undefined}
                found={found}
              />
            ) : (
              <EmptyNote>
                Bir dosya açtığında konuşmalar burada, zaman kodlarıyla birlikte
                belirir.
              </EmptyNote>
            )}
          </PaneBody>
        </Pane>
  );

  const main = (
        <main className="flex min-h-0 min-w-0 bg-bg p-3.5 max-[860px]:order-1 max-[860px]:h-[56vw] max-[860px]:min-h-[220px] max-[860px]:has-data-dropzone:h-auto max-[480px]:p-2.5">
          <Settings
            open={settingsOpen}
            section={section}
            onSection={setRememberedSection}
            onClose={() => setSettingsOpen(false)}
            gateway={gateway}
          />
          <Viewer
            player={player}
            words={liveWords}
            settings={settings}
            liveTime={job?.live && !job.file ? job.decoded : null}
            following={following}
            bands={job?.bands ?? EMPTY_BANDS}
            loudness={(!english && job?.loudness) || EMPTY_BANDS}
            lang={lang}
            liveLevels={liveLevels}
            notice={
              badCodec &&
              `Bu video ${badCodec} ile kodlanmış ve bu tarayıcı onu oynatamıyor. Chrome'da açabilir ya da videoyu H.264 olarak kaydedip yükleyebilirsin. Yazıya döküm ve altyazı dosyaları bundan etkilenmez.`
            }
          >
            {needsMedia ? (
              <Dropzone
                title={
                  dragging
                    ? "Bırak, bağlayalım"
                    : pendingHandle
                      ? "Video hazır, bir tık kaldı"
                      : "Medya dosyasını seç"
                }
                text={
                  pendingHandle
                    ? "Transkript ve stil geri yüklendi. Tarayıcı, kayıtlı dosyayı yeniden açmak için senin onayını istiyor."
                    : current?.media
                      ? "Transkript ve stil geri yüklendi. Oynatmak ve altyazılı video oluşturmak için dosyayı yeniden seç; kelime zamanları korunur."
                      : "Altyazı yüklendi. Oynatmak ve altyazılı video oluşturmak için video ya da ses dosyasını seç."
                }
                actions={
                  pendingHandle ? (
                    <>
                      <Button
                        variant="primary"
                        size="lg"
                        className={DROP_BTN}
                        onClick={allowHandle}
                        title={pendingHandle.name}
                      >
                        “{pendingHandle.name}” dosyasını aç
                      </Button>
                      <Button size="lg" className={DROP_BTN} onClick={pickFile}>
                        Başka dosya seç
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      size="lg"
                      className={DROP_BTN}
                      onClick={pickFile}
                      title={current?.media?.name}
                    >
                      {current?.media
                        ? `“${current.media.name}” dosyasını seç`
                        : "Dosyayı seç"}
                    </Button>
                  )
                }
                fine="Dosyayı pencereye de sürükleyebilirsin."
              />
            ) : (
              <Dropzone
                title={
                  dragging ? "Bırak, başlayalım" : "Video ya da ses dosyası aç"
                }
                text="Türkçe konuşmayı yazıya döker, altyazıyı videonun içine yazar. Her şey bu bilgisayarda, ekran kartında çalışır; dosyan hiçbir yere gönderilmez."
                actions={
                  <>
                    <Button
                      variant="primary"
                      size="lg"
                      className={DROP_BTN}
                      onClick={pickFile}
                    >
                      Dosya aç
                    </Button>
                    {liveWaiting ? (
                      <Button
                        size="lg"
                        className={DROP_BTN}
                        onClick={stopLive}
                        title="Kayıt beklemesini iptal et"
                      >
                        Model hazırlanıyor, iptal et
                      </Button>
                    ) : (
                      <Button
                        size="lg"
                        className={DROP_BTN}
                        onClick={goLive}
                        disabled={!!micBlocked}
                        title={micBlocked ?? undefined}
                      >
                        <IconMic /> Mikrofonla başla
                      </Button>
                    )}
                  </>
                }
                fine={
                  <>
                    Dosyayı pencereye sürükleyebilirsin: MP4, MOV, MKV, WebM,
                    MP3, M4A, WAV, FLAC, OGG; altyazı için SRT ve VTT. İlk kullanımda yaklaşık{" "}
                    {chosen.size} model ({chosen.name}) indirilir ve
                    saklanır.
                    {engine.phase === "idle" && (
                      <>
                        {" "}
                        <LinkButton onClick={prepare}>Şimdi indir</LinkButton>
                      </>
                    )}
                  </>
                }
              >
                {!job && saved.length > 0 && (
                  <div className="mt-2.5 grid w-full gap-0.5 border-t border-line pt-3 text-left">
                    <MenuTitle>Son projeler</MenuTitle>
                    <ProjectList
                      projects={saved}
                      onOpen={openProject}
                      onDelete={deleteProject}
                      limit={3}
                    />
                  </div>
                )}
              </Dropzone>
            )}
          </Viewer>
        </main>
  );

  const right = (
        <Inspector
          settings={settings}
          onSettings={changeSettings}
          burning={burner.state.status === "running"}
          model={model}
          method={method}
          onMethod={setMethod}
          serverProvider={provider === "sunucu"}
          job={job}
          engine={engine}
          onRestart={() => job?.file && openFile(job.file)}
          onResume={resumeJob}
          autoPunct={autoPunct}
          onAutoPunct={setAutoPunct}
          onPunctuate={applyPunct}
          numberMode={numberMode}
          onNumberMode={setNumberMode}
          onNumbers={applyNumbers}
          punctBusy={punct.phase === "run" || punct.phase === "download"}
          onCancel={cancel}
          dub={dubber.state}
          dubStale={!!dub && (dub.words !== words || !sameChoice(dub.choice, voice))}
          canDub={editable && !!job?.file}
          onDub={() =>
            dubber.dub(words, player.duration || job?.duration || 0, voice)
          }
          onCancelDub={dubber.cancel}
          dubOn={dubOn}
          onDubOn={setDubOn}
          dubName={`${name}.seslendirme.wav`}
          voice={voice}
          onVoice={setVoice}
          preview={dubber.preview}
          onListen={() => dubber.listen(words, voice, player.el)}
          translate={translator.state}
          translation={!!translation}
          translationStale={translationStale}
          canTranslate={!!job && job.status !== "running" && words.length > 0}
          onTranslate={translate}
          onCancelTranslate={translator.cancel}
        />
  );

  const transport = (
      <div className="flex items-center gap-2 border-t border-line-soft bg-pane px-3.5 max-[860px]:order-2 max-[860px]:flex-wrap max-[860px]:gap-y-1 max-[860px]:px-2.5 max-[860px]:pt-2.5 max-[860px]:pb-1.5">
        <RecordButton
          recording={!!job?.recording}
          waiting={liveWaiting}
          onStart={goLive}
          disabledReason={micBlocked}
          onStop={stopLive}
        />
        <span className="mx-1 h-[22px] w-px flex-none bg-line" aria-hidden />
        <button
          className={TP_BTN}
          onClick={player.toggle}
          disabled={!job || job.recording}
          aria-label={player.playing ? "Duraklat" : "Oynat"}
        >
          {player.playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="min-w-24 flex-none text-[12px] text-fg-3 tabular-nums [font-feature-settings:'tnum'_1] max-[860px]:min-w-0 max-[860px]:flex-1 max-[860px]:text-[13px]">
          <strong className="font-semibold text-fg">
            {clock(player.time)}
          </strong>{" "}
          / {clock(player.duration || job?.duration || 0)}
        </span>
        <button
          className={TP_BTN}
          onClick={() => player.setMuted(!player.muted)}
          disabled={!job || job.recording}
          aria-label={player.muted ? "Sesi aç" : "Sesi kapat"}
        >
          {player.muted ? <IconMuted /> : <IconSound />}
        </button>
        {job ? (
          <Timeline
            peaks={job.peaks}
            duration={player.duration || job.duration || 0}
            decoded={job.decoded}
            time={player.time}
            media={player.el}
            cues={groups}
            live={job.recording ? liveMeter.current : null}
            onSeek={player.seek}
          />
        ) : (
          <div className={TIMELINE} />
        )}
      </div>
  );

  const status = (
      <StatusBar
        engine={engine}
        provider={provider}
        job={job}
        burn={burner.state}
        notice={notice}
        punct={punct}
        liveWaiting={liveWaiting}
        gateway={gateway}
        onOpenServer={() => showSettings("server")}
        onStop={cancel}
        onDiscard={discardJob}
        onResume={resumeJob}
      />
  );

  return {
    header,
    left,
    main,
    right,
    transport,
    status,
    dragging,
  };
}
