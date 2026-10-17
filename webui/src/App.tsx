// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// -----------------------------------------------------------------------------
// Apeksis /ui/ — application root.
//
// ONE view, ONE shell (shell/AppShell), ONE design system. The studio
// workspace (transcript · viewer · inspector · timeline · status) IS the app, and
// every gateway surface lives inside it: file speech-to-text is the toolbar's
// "Sunucu" provider (Aşama 5), file dubbing is the Inspector's "Seslendirme" tab
// (Aşama 6), a conversation is the transcript's session bar (Aşama 9), and the
// gateway's own connection, status, endpoint catalog and log are Settings
// sections (Aşama 9b — the full-screen panel is gone). The old sidebar shell, the
// separate "Sunucu" console view, the embedded iframe and the separate
// "Oturumlar" pane are all gone.
//
// The studio engine is created here and handed to the shell as slot content, so
// the editor, the session bar and the settings window share one open job. Its
// projects are the only projects: the Voxi IndexedDB store and its
// `StudioProvider` were removed in Aşama 7, and its records moved into the
// studio store once (studio/lib/importVoxiProjects.ts).
// -----------------------------------------------------------------------------

import { AppShell } from "./shell";
import { useStudioEngine } from "./studio/App";

export default function App() {
  const studio = useStudioEngine();

  return (
    <AppShell
      dragging={studio.dragging}
      header={studio.header}
      left={{ label: "Çalışma alanı", content: studio.left }}
      main={studio.main}
      right={{ label: "Denetçi", content: studio.right }}
      transport={studio.transport}
      status={studio.status}
    />
  );
}
