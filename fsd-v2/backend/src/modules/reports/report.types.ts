// Shared types for the reporting surface.
// Mirrors v1's domain/report/report.go ReportTable shape so the SPA
// payloads round-trip between the Go and Nest backends during cut-over.

export interface ReportTable {
  type: string;
  headers: string[];
  rows: string[][];
  // Hour totals are mirrored as a footer row by v1 — exposed as a
  // separate field so the SPA can render them differently if it wants.
  totalHours?: number;
  generatedAt: string;
  start: string;
  end: string;
}

// The fixed allow-list. Anything else is rejected before being
// interpolated into a Content-Disposition filename (same as v1).
export const REPORT_TYPES = [
  'summary', 'noshow', 'staff', 'usage', 'audit', 'medical', 'addl',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export function normalizeReportType(raw?: string): ReportType {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'summary';
  if ((REPORT_TYPES as readonly string[]).includes(v)) return v as ReportType;
  throw new Error(`unknown report type: ${raw}`);
}
