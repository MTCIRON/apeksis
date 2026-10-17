// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type CaptionSettings } from "../captions/style";
import {
  askPersist,
  canCopy,
  COPY_LIMIT,
  deleteProject,
  fileFromHandle,
  getMedia,
  getProject,
  listProjects,
  mediaInfo,
  projectFromFile,
  projectToFile,
  saveMedia,
  saveProject,
  stripExt,
  type Project,
  type StoredMedia,
} from "./projectStore";
import type { Job } from "./useTranscriber";
import { importVoxiProjects, type VoxiImportReport } from "./importVoxiProjects";

const LIVE_NAME = "Canlı kayıt";

/** Something to save: a finished (or stopped) transcript. */
const saveable = (j: Job | null): j is Job =>
  !!j && (j.status === "done" || j.status === "cancelled") && (j.words.length > 0 || !!j.file);

/** Saves the current job as a project as it changes, and opens saved ones. */
export function useProjects(job: Job | null, settings: CaptionSettings) {
  const [projects, setProjects] = useState<Project[]>([]);
  /** What the one-time Voxi import moved, so the workspace can say so. */
  const [voxiImport, setVoxiImport] = useState<VoxiImportReport | null>(null);
  /** The project behind each job. */
  const byJob = useRef(new Map<number, Project>());
  /** The media already stored for a job's project. */
  const storedFile = useRef(new Map<number, File>());
  /** Jobs whose project was deleted: not saved again. */
  const dropped = useRef(new Set<number>());
  /** File handles from the picker or a drop (Chromium), so media need no copy. */
  const handles = useRef(new WeakMap<File, FileSystemFileHandle>());

  useEffect(() => {
    let alive = true;
    (async () => {
      // Aşama 7: the old Voxi projects move in once, BEFORE the list is read, so
      // they are simply there the first time the workspace opens.
      const report = await importVoxiProjects().catch(() => null);
      if (report && !report.alreadyDone) setVoxiImport(report);
      const list = await listProjects().catch(() => []);
      if (alive) setProjects(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const remember = useCallback((p: Project) => {
    setProjects((l) => [p, ...l.filter((x) => x.id !== p.id)]);
  }, []);

  const writeMedia = useCallback(async (p: Project, file: File) => {
    const handle = handles.current.get(file);
    let m: StoredMedia | null = null;
    if (handle) m = { kind: "handle", handle };
    else if ((p.live || file.size <= COPY_LIMIT) && (await canCopy(file.size))) m = { kind: "copy", file };
    p.media = mediaInfo(file);
    p.storage = m?.kind ?? "none";
    if (m) {
      try {
        await saveMedia({ ...p }, m);
        return;
      } catch {
        p.storage = "none"; // Over quota: the transcript is still saved.
      }
    }
    await saveProject({ ...p });
  }, []);

  // Autosave, shortly after the last change.
  useEffect(() => {
    if (!saveable(job) || dropped.current.has(job.id)) return;
    let p = byJob.current.get(job.id);
    if (!p) {
      const now = Date.now();
      p = {
        id: crypto.randomUUID(),
        name: stripExt(job.imported ?? job.file?.name ?? LIVE_NAME),
        createdAt: now,
        updatedAt: now,
        live: job.live,
        model: job.model,
        method: job.options.method,
        duration: null,
        elapsed: null,
        words: [],
        peaks: job.peaks,
        bands: job.bands,
        loudness: job.loudness,
        settings,
        media: null,
        storage: "none",
      };
      byJob.current.set(job.id, p);
    }
    // A recording gets its file (and its name) after it has stopped.
    if (p.name === LIVE_NAME && job.file) p.name = stripExt(job.file.name);
    Object.assign(p, {
      updatedAt: Date.now(),
      model: job.model,
      imported: job.imported,
      method: job.options.method,
      duration: job.duration ?? job.decoded,
      elapsed: job.elapsed,
      stoppedAt: job.status === "cancelled" && !job.live ? job.decoded : undefined,
      words: job.words,
      peaks: job.peaks,
      bands: job.bands,
      loudness: job.loudness,
      translation: job.translation,
      settings,
    });
    const project = p;
    const file = job.file;
    const id = job.id;
    const timer = setTimeout(() => {
      askPersist();
      const media = file && storedFile.current.get(id) !== file;
      if (media) storedFile.current.set(id, file);
      (media ? writeMedia(project, file) : saveProject({ ...project }))
        .then(() => remember({ ...project }))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [job, settings, writeMedia, remember]);

  /** A picked or dropped file came with a handle: keep it instead of a copy. */
  const noteHandle = useCallback((file: File, handle: FileSystemFileHandle) => {
    handles.current.set(file, handle);
  }, []);

  /**
   * Read a project and its media. Call from a click: a stored file handle
   * may need the user's permission again. `file` is null when the media
   * has to be picked again.
   */
  const open = useCallback(async (id: string) => {
    const project = await getProject(id);
    if (!project) return null;
    const m = project.storage === "none" ? undefined : await getMedia(id).catch(() => undefined);
    let file: File | null = null;
    if (m?.kind === "copy") file = m.file;
    else if (m?.kind === "handle") {
      file = await fileFromHandle(m.handle);
      if (file) handles.current.set(file, m.handle);
    }
    /** Without a click in progress, the handle may still need the user's permission. */
    const handle = !file && m?.kind === "handle" ? m.handle : null;
    return { project, file, handle };
  }, []);

  /** The file behind a stored handle, from a click (permission). */
  const fromHandle = useCallback(async (handle: FileSystemFileHandle) => {
    const file = await fileFromHandle(handle);
    if (file) handles.current.set(file, handle);
    return file;
  }, []);

  /** The job now shows this project. */
  const bind = useCallback((jobId: number, project: Project, file: File | null) => {
    byJob.current.set(jobId, project);
    if (file) storedFile.current.set(jobId, file);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      for (const [jobId, p] of byJob.current) {
        if (p.id !== id) continue;
        byJob.current.delete(jobId);
        dropped.current.add(jobId);
      }
      setProjects((l) => l.filter((x) => x.id !== id));
      await deleteProject(id).catch(() => {});
    },
    [],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      name = name.trim();
      if (!name) return;
      const p = [...byJob.current.values()].find((x) => x.id === id) ?? (await getProject(id).catch(() => undefined));
      if (!p || p.name === name) return;
      p.name = name;
      p.updatedAt = Date.now();
      remember({ ...p });
      await saveProject({ ...p }).catch(() => {});
    },
    [remember],
  );

  /** Store a project file; an existing copy of the same project keeps its media. */
  const importFile = useCallback(
    async (f: File) => {
      const p = projectFromFile(await f.text(), DEFAULT_SETTINGS);
      const existing = await getProject(p.id).catch(() => undefined);
      if (existing) {
        p.storage = existing.storage;
        p.media = existing.media ?? p.media;
      }
      await saveProject(p);
      remember(p);
      return p;
    },
    [remember],
  );

  /** The open project, once the job has been opened or saved. */
  const current = job ? (byJob.current.get(job.id) ?? null) : null;
  const exportText = useCallback(() => {
    const p = job && byJob.current.get(job.id);
    return p ? projectToFile(p) : null;
  }, [job]);

  return { projects, voxiImport, current, saveable: saveable(job), noteHandle, open, fromHandle, bind, remove, rename, importFile, exportText };
}
