// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Public surface of the /ui/ shell: layout + design system.
//
// The gateway's own surfaces (the full-screen server panel and its pane) are NOT
// here any more: Aşama 9b folded them into Settings, which belongs to the
// workspace (studio/components/Settings.tsx).

export { AppShell, type SidePane } from "./app-shell";
export { usePanelOpen, usePanelWidth, useStoredValue } from "./panels";
export * from "./ui";
export * from "./menu";
