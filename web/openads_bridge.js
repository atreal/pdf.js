/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AppOptions } from "./app_options.js";

/**
 * Bridge between the pdf.js viewer (with MeasureEditor) and the openADS
 * application embedding it in an iframe.
 *
 * Uses the standard pdf.js API:
 *   - app.pdfDocument.annotationStorage  → modification tracking
 *   - app.pdfDocument.saveDocument()     → produce the annotated PDF
 *
 * No PDF-Lib, no MeasureStore — every modification (mesures + native
 * editors) goes through annotationStorage and is written by the worker.
 *
 * Protocol (parent → iframe):
 *   { type: "openads-pdf-load",          data, documentId, userLogin }
 *   { type: "openads-pdf-save-request" }
 *   { type: "openads-pdf-check-unsaved" }
 *   { type: "openads-pdf-save-result",   success, message }
 *
 * Protocol (iframe → parent):
 *   { type: "openads-pdf-save",          pdfBase64, documentId }
 *   { type: "openads-pdf-has-unsaved",   hasUnsaved }
 *   { type: "openads-show-toast",        message, type }
 *   { type: "openads-pdf-signatures",    signatures, documentId }
 *
 * "openads-pdf-signatures" is dispatched once per document load when the
 * PDF carries one or more electronic signature fields. The payload is pure
 * metadata (signer / date / reason / location / SubFilter / ByteRange) —
 * no cryptographic verification is performed by the viewer. The receiving
 * side MUST NOT present these signatures as "valid" without performing
 * its own integrity check (e.g. server-side openssl_pkcs7_verify on the
 * range described by `byteRange`).
 */

/**
 * Applique les AppOptions selon le mode openADS lu dans la query string.
 * À appeler dans `webViewerLoad` AVANT `PDFViewerApplication.run(config)`.
 *
 * Modes :
 *   - "preview" (défaut) : annotationEditorMode=-1 (DISABLE), tous les
 *     enableXxxEditor désactivés (Measure, Comment, Highlight, Signature).
 *   - "annotate" : annotationEditorMode=0 (NONE, toolbar visible) + tous
 *     les enableXxxEditor activés.
 *
 * `disablePreferences` est forcé à `true` pour éviter qu'IndexedDB
 * n'écrase ces choix.
 */
function applyOpenadsAppOptions() {
  const params = new URLSearchParams(window.location.search);
  const inIframe = window !== window.parent;
  if (params.get("openads") !== "1" && !inIframe) {
    return;
  }
  AppOptions.set("disablePreferences", true);
  const mode = params.get("mode") === "annotate" ? "annotate" : "preview";
  if (mode === "preview") {
    AppOptions.set("annotationEditorMode", -1); // AnnotationEditorType.DISABLE
    AppOptions.set("enableMeasureEditor", false);
    AppOptions.set("enableComment", false);
    AppOptions.set("enableHighlightFloatingButton", false);
    AppOptions.set("enableSignatureEditor", false);
  } else {
    AppOptions.set("annotationEditorMode", 0); // AnnotationEditorType.NONE (toolbar visible, aucun éditeur actif par défaut)
    AppOptions.set("enableMeasureEditor", true);
    AppOptions.set("enableComment", true);
    AppOptions.set("enableHighlightFloatingButton", true);
    AppOptions.set("enableSignatureEditor", true);
    AppOptions.set("enableAltText", true);
    AppOptions.set("enableAutoLinking", true);
    AppOptions.set("enableGuessAltText", true);
  }
}

const isInIframe = window !== window.parent;
const urlParams = new URLSearchParams(window.location.search);
const openadsMode = urlParams.get("openads") === "1" || isInIframe;
const documentId = urlParams.get("docId") || "";

let _app = null;
// Number of annotationStorage entries at the last successful save.
// null = never saved yet.
let _savedSize = null;

/**
 * Initialize the bridge. Call once after PDFViewerApplication is initialized.
 * @param {PDFViewerApplication} app
 */
function initOpenadsBridge(app) {
  _app = app;

  if (!openadsMode) {
    // Stand-alone viewer — nothing to do.
    return;
  }

  // Make the user login available to MeasureEditor (used as the /T author).
  window._openadsUserLogin =
    urlParams.get("userLogin") ||
    urlParams.get("user") ||
    window._openadsUserLogin ||
    "";

  // Listen to messages from the parent window.
  window.addEventListener("message", _handleParentMessage);

  // Expose the unsaved-changes check synchronously to the (same-origin) parent
  // so it can implement a `beforeunload` guard (F5 / tab close / navigation).
  // postMessage is async and unusable in a beforeunload handler; a direct call
  // reuses the exact same dirty definition as the close button.
  window.openadsHasUnsavedModifications = _hasUnsavedModifications;

  // Publish electronic-signature metadata (if any) once the document is
  // ready. Signatures are *informational* — no crypto verification is
  // performed here.
  app.eventBus?.on("documentloaded", _publishSignatures);

  // Try to load the PDF straight from a parent-provided variable (legacy).
  _loadPdfFromParent();
}

async function _publishSignatures() {
  if (!_app?.pdfDocument) {
    return;
  }
  try {
    const signatures = await _app.pdfDocument.getSignatures();
    if (!signatures?.length) {
      return;
    }
    parent.postMessage(
      {
        type: "openads-pdf-signatures",
        signatures,
        documentId,
      },
      "*"
    );
  } catch {
    // Silently ignore — signatures are informational, not blocking.
  }
}

function _loadPdfFromParent() {
  // Strategy 1: parent.window.pdfjs_content_b64 (legacy openADS).
  try {
    if (parent.window.pdfjs_content_b64) {
      const binaryStr = parent.window.pdfjs_content_b64;
      const uint8 = _binaryStringToUint8Array(binaryStr);
      _waitForViewerReady().then(() => _app.open({ data: uint8 }));
    }
  } catch {
    // cross-origin — fall through to other strategies
  }

  // Strategy 2: ?file= — handled natively by the viewer.
  // Strategy 3: wait for an "openads-pdf-load" postMessage.
}

async function _saveToOpenads() {
  if (!_app?.pdfDocument) {
    return;
  }
  try {
    const storage = _app.pdfDocument.annotationStorage;
    // No edits — getData() returns raw bytes without re-serialising.
    const bytes =
      storage.size > 0
        ? await _app.pdfDocument.saveDocument()
        : await _app.pdfDocument.getData();

    const pdfBase64 = _uint8ArrayToBase64(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    );

    parent.postMessage(
      {
        type: "openads-pdf-save",
        pdfBase64,
        documentId,
      },
      "*"
    );
  } catch (err) {
    parent.postMessage(
      {
        type: "openads-show-toast",
        message: "Erreur lors de la sauvegarde : " + err.message,
        level: "error",
      },
      "*"
    );
  }
}

function _hasUnsavedModifications() {
  const size = _app?.pdfDocument?.annotationStorage?.size ?? 0;
  if (_savedSize === null) {
    return size > 0;
  }
  return size !== _savedSize;
}

function _markAsSaved() {
  _savedSize = _app?.pdfDocument?.annotationStorage?.size ?? 0;
  _app?.pdfDocument?.annotationStorage?.resetModified();
}

function _handleParentMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== "object") {
    return;
  }
  switch (msg.type) {
    case "openads-pdf-save-request":
      _saveToOpenads();
      break;
    case "openads-pdf-check-unsaved":
      parent.postMessage(
        {
          type: "openads-pdf-has-unsaved",
          hasUnsaved: _hasUnsavedModifications(),
        },
        "*"
      );
      break;
    case "openads-pdf-save-result":
      if (msg.success) {
        _markAsSaved();
      }
      break;
    case "openads-pdf-load":
      _savedSize = null;
      if (msg.userLogin) {
        window._openadsUserLogin = msg.userLogin;
      }
      if (msg.documentId) {
        window._openadsDocId = msg.documentId;
      }
      if (msg.data && _app) {
        const uint8 = _base64ToUint8Array(msg.data);
        _waitForViewerReady().then(() => _app.open({ data: uint8 }));
      }
      break;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _binaryStringToUint8Array(binaryStr) {
  const len = binaryStr.length;
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    u[i] = binaryStr.charCodeAt(i);
  }
  return u;
}

function _uint8ArrayToBase64(uint8) {
  const CHUNK = 0x8000;
  let result = "";
  for (let i = 0; i < uint8.length; i += CHUNK) {
    result += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
  }
  return btoa(result);
}

function _base64ToUint8Array(base64) {
  const binary = atob(base64);
  return _binaryStringToUint8Array(binary);
}

function _waitForViewerReady() {
  return new Promise(resolve => {
    if (_app.pdfViewer) {
      resolve();
      return;
    }
    const t = setInterval(() => {
      if (_app.pdfViewer) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
}

export { applyOpenadsAppOptions, initOpenadsBridge };
