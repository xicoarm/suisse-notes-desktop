/**
 * Desktop & Mobile API Contract — single source of truth.
 *
 * Every endpoint under `/api/desktop/*` that desktop, iOS or Android clients
 * are allowed to call MUST appear in `DESKTOP_API_CONTRACT` below.
 *
 * Three things consume this file:
 *   1. The route handlers under `src/app/api/desktop/*` — they import the
 *      request/response types so the wire format is type-checked.
 *   2. The contract smoke test (`tests/desktop-contract.test.ts`) — it
 *      iterates the manifest and fails CI if any documented endpoint
 *      responds with 404. This is the guard against the "mobile shipped
 *      a call we don't serve" incident.
 *   3. The hand-written OpenAPI spec at `public/api/desktop-openapi.json`.
 *
 * Rule: if you change a request or response shape, change it here first,
 * then update the route handlers, the OpenAPI spec, and the smoke test
 * fixture. The PR template references this file for a reason.
 */

/* eslint-disable @typescript-eslint/no-empty-object-type */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Client-facing recording lifecycle. Server maps to/from Prisma MeetingStatus.
 *
 *   RECORDING   — client is still capturing audio locally
 *   UPLOADING   — bytes are in flight to /api/desktop/upload
 *   PROCESSING  — server has the audio; transcription/AI running
 *   COMPLETED   — transcript + insights ready
 *   FAILED      — terminal failure (transcription or AI), includes errorMessage
 *   CANCELLED   — client explicitly cancelled before upload
 */
export type RecordingStatus =
  | "RECORDING"
  | "UPLOADING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** Client platform — sent in metadata.platform and the X-Client-Platform header. */
export type ClientPlatform = "ios" | "android" | "win32" | "darwin" | "linux" | "web";

/** Standard error envelope returned by every contract endpoint. */
export interface ApiError {
  /** Stable machine-readable code (e.g. "RECORDING_NOT_FOUND"). */
  code: string;
  /** Human-readable message safe to show users. */
  error: string;
  /** Optional extra fields specific to the error. */
  [extra: string]: unknown;
}

/**
 * Public Recording resource — what every recording-shaped endpoint returns.
 * `recordId` is the client-side UUID that the mobile/desktop app generates
 * the moment recording starts. The server stores it on
 * `Meeting.botSessionId = "desktop:${recordId}"` so the client can always
 * address its recording without knowing the server-side meeting id.
 */
export interface RecordingResource {
  recordId: string;
  meetingId: string | null;
  audioFileId: string | null;
  title: string;
  status: RecordingStatus;
  platform: ClientPlatform | null;
  durationSeconds: number | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  /** Populated only when status === "FAILED". */
  errorMessage?: string | null;
}

// ---------------------------------------------------------------------------
// Per-endpoint request/response shapes
// ---------------------------------------------------------------------------

// POST /api/desktop/recording — register a new local recording on the server.
// Idempotent on recordId: calling twice with the same recordId returns the
// existing resource instead of creating a duplicate.
export interface RegisterRecordingRequest {
  recordId: string;
  title?: string;
  platform?: ClientPlatform;
  /** Optional ISO timestamp of when recording started client-side. */
  startedAt?: string;
}
export interface RegisterRecordingResponse {
  recording: RecordingResource;
}

// PATCH /api/desktop/recording/[recordId] — update title or terminal status
// before upload (e.g. mark CANCELLED, rename).
export interface UpdateRecordingRequest {
  title?: string;
  status?: Extract<RecordingStatus, "RECORDING" | "UPLOADING" | "CANCELLED">;
  durationSeconds?: number;
}
export interface UpdateRecordingResponse {
  recording: RecordingResource;
}

// GET /api/desktop/recording/[recordId] — read latest server state.
// Used after client crash to reconcile local state.
export interface GetRecordingResponse {
  recording: RecordingResource;
}

// GET /api/desktop/history — paginated list of this user's recordings.
export interface HistoryQuery {
  /** Page size; default 30, max 100. */
  limit?: number;
  /** Opaque cursor from a previous response. */
  cursor?: string;
  /** Filter by status. */
  status?: RecordingStatus;
}
export interface HistoryResponse {
  recordings: RecordingResource[];
  nextCursor: string | null;
}

// POST /api/desktop/history — bulk sync: client posts its local history,
// server merges. Used by mobile to repair after extended offline use.
export interface SyncHistoryRequest {
  items: Array<{
    recordId: string;
    title?: string;
    platform?: ClientPlatform;
    durationSeconds?: number;
    startedAt?: string;
  }>;
}
export interface SyncHistoryResponse {
  recordings: RecordingResource[];
}

// POST /api/desktop/upload — existing, unchanged on the wire.
// Documented here so the smoke test verifies it never 404's.
// Request is multipart/form-data: { audio: File, metadata: JSON-string }.
export interface UploadMetadata {
  /** If present, server links upload to a pre-registered recording. */
  recordId?: string;
  title?: string;
  platform?: ClientPlatform;
  appVersion?: string;
  deviceId?: string;
  duration?: number;
  /** Legacy free-text STT context. Superseded by contextText (both accepted). */
  context?: string;
  /**
   * Pre-meeting context free text. Persisted on the meeting (MeetingPrep) and
   * used for BOTH transcription hints and document generation.
   */
  contextText?: string;
  /**
   * Pre-selected DocumentTemplate id (from GET /api/desktop/templates) for the
   * default document. Highest-priority selection — overrides the starred
   * default and the AI template matching.
   */
  templateId?: string;
  /**
   * Sections of the selected template the user filled in BEFORE the meeting.
   * Keys come from GET /api/desktop/templates/[templateId]/sections.
   */
  templatePrefill?: TemplatePrefill;
  /** Ids of context documents uploaded via POST /api/context-files. */
  contextFileIds?: string[];
}

export interface PrefillEntry {
  /** Section key from GET /api/desktop/templates/[templateId]/sections. */
  key: string;
  /** Optional display label (informational). */
  label?: string;
  /** The user's pre-filled content for this section. */
  content: string;
}
export interface TemplatePrefill {
  entries: PrefillEntry[];
}

// GET /api/desktop/templates — slim template list for the pre-meeting picker.
export interface DesktopTemplateResource {
  id: string;
  name: string;
  description: string | null;
  /** "blocks" | "docx" */
  templateType: string;
  isBuiltIn: boolean;
  /** True when this is the user's global default (block-library star). */
  isStarred: boolean;
}
export interface DesktopTemplatesResponse {
  templates: DesktopTemplateResource[];
  defaultTemplateId: string | null;
}

// GET /api/desktop/templates/[templateId]/sections — fillable sections for the
// pre-fill UI. Section keys are what TemplatePrefill entries must use.
export interface TemplateSectionResource {
  key: string;
  label: string;
  /** "text" | "table" (docx) or "block" (block templates). */
  kind: string;
}
export interface TemplateSectionsResponse {
  id: string;
  name: string;
  templateType: string;
  sections: TemplateSectionResource[];
}

// POST /api/context-files — multipart { file }: upload ONE pre-meeting context
// document (PDF/DOCX/TXT/MD/CSV/image, ≤20 MB). Text is extracted server-side
// (incl. OCR). Pass the returned id in UploadMetadata.contextFileIds.
// DELETE /api/context-files/[id] removes an own, still-unattached file.
export interface ContextFileResponse {
  id: string;
  fileName: string;
  sizeBytes: number;
  /** "done" | "failed" — failed files are kept but contribute no text. */
  extractionStatus: string;
  ocrUsed: boolean;
  textLength: number;
  textPreview: string | null;
}
export interface UploadResponse {
  success: boolean;
  audioFileId: string;
  meetingId: string;
  transcriptionId: string;
  fileName?: string;
  fileSize?: number;
  deduplicated?: boolean;
  gatewayFailed?: boolean;
  message?: string;
}

// GET /api/desktop/upload/[audioFileId]/status — poll transcription progress
// by audio id (the client knows audioFileId from the upload response).
export interface UploadStatusResponse {
  audioFileId: string;
  meetingId: string;
  status: RecordingStatus;
  errorMessage?: string | null;
}

// GET /api/desktop/meeting/[meetingId]/status — existing legacy alias of the
// above, indexed by meeting id. Kept for backward compatibility.
export interface MeetingStatusResponse {
  status: string;
}

// GET /api/desktop/minutes — existing, listed for completeness.
export interface MinutesResponse {
  remaining: number;
  unlimited: boolean;
  total: number;
  used: number;
}

// ---------------------------------------------------------------------------
// Endpoint manifest — drives the smoke test and OpenAPI generation
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * One row per (path, method) pair the clients are allowed to call.
 *
 *   path           : Next.js-style route with [param] placeholders.
 *   methods        : Methods that MUST return non-404 for an authenticated user.
 *   auth           : "required" | "none". The smoke test sends a valid bearer.
 *   smokeFixture   : Optional concrete path the smoke test should hit. If
 *                    omitted the test substitutes synthetic values for
 *                    [params] (any 4xx other than 404 is acceptable — we
 *                    only assert the route exists, not that the body is valid).
 */
export interface ContractEntry {
  path: string;
  methods: HttpMethod[];
  auth: "required" | "none";
  description: string;
  smokeFixture?: { path: string; method: HttpMethod };
}

export const DESKTOP_API_CONTRACT: ContractEntry[] = [
  {
    path: "/api/desktop/recording",
    methods: ["POST"],
    auth: "required",
    description: "Register a new client recording (idempotent on recordId).",
  },
  {
    path: "/api/desktop/recording/[recordId]",
    methods: ["GET", "PATCH"],
    auth: "required",
    description: "Read or update a client recording by recordId.",
  },
  {
    path: "/api/desktop/upload",
    methods: ["POST"],
    auth: "required",
    description: "Upload audio bytes; creates or links to a Meeting.",
  },
  {
    path: "/api/desktop/upload/[audioFileId]/status",
    methods: ["GET"],
    auth: "required",
    description: "Poll transcription status by audioFileId.",
  },
  {
    path: "/api/desktop/meeting/[meetingId]/status",
    methods: ["GET"],
    auth: "required",
    description: "Poll transcription status by meetingId (legacy).",
  },
  {
    path: "/api/desktop/history",
    methods: ["GET", "POST"],
    auth: "required",
    description: "List or bulk-sync the user's recent recordings.",
  },
  {
    path: "/api/desktop/minutes",
    methods: ["GET"],
    auth: "required",
    description: "User's remaining transcription minutes.",
  },
  {
    path: "/api/desktop/download",
    methods: ["GET"],
    auth: "none",
    description: "Public download links for the desktop installer.",
  },
  {
    path: "/api/desktop/templates",
    methods: ["GET"],
    auth: "required",
    description: "Slim document-template list for the pre-meeting picker.",
  },
  {
    path: "/api/desktop/templates/[templateId]/sections",
    methods: ["GET"],
    auth: "required",
    description: "Fillable sections of a template for the pre-fill UI.",
  },
  {
    path: "/api/context-files",
    methods: ["POST"],
    auth: "required",
    description:
      "Upload a pre-meeting context document (multipart file, ≤20 MB); returns the id for UploadMetadata.contextFileIds.",
  },
];

// ---------------------------------------------------------------------------
// Status mapping — keep server (Prisma) ↔ client (RecordingStatus) in lockstep
// ---------------------------------------------------------------------------

import type { MeetingStatus as PrismaMeetingStatus } from "@prisma/client";

export function toRecordingStatus(meetingStatus: PrismaMeetingStatus): RecordingStatus {
  switch (meetingStatus) {
    case "SCHEDULED":
    case "BOT_JOINING":
    case "IN_PROGRESS":
      return "RECORDING";
    case "PROCESSING":
      return "PROCESSING";
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
    case "TRANSCRIPTION_FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default: {
      // Exhaustiveness check — adding a new MeetingStatus will fail to compile here.
      const _exhaustive: never = meetingStatus;
      return "PROCESSING";
    }
  }
}

// ---------------------------------------------------------------------------
// Error code registry — every code returned by a /api/desktop/* route must
// appear here. Clients switch on these, never on the human message.
// ---------------------------------------------------------------------------

export const DESKTOP_ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RECORDING_NOT_FOUND: "RECORDING_NOT_FOUND",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  RECORDING_ALREADY_FINALIZED: "RECORDING_ALREADY_FINALIZED",
  INVALID_REQUEST: "INVALID_REQUEST",
  INSUFFICIENT_MINUTES: "INSUFFICIENT_MINUTES",
  DURATION_EXCEEDED: "DURATION_EXCEEDED",
  UPLOAD_FAILED: "UPLOAD_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[keyof typeof DESKTOP_ERROR_CODES];
