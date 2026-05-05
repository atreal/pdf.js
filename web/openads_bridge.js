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
 */

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

  // Try to load the PDF straight from a parent-provided variable (legacy).
  _loadPdfFromParent();
}

function _loadPdfFromParent() {
  // Strategy 1: parent.window.pdfjs_content_b64 (legacy openADS).
  try {
    if (parent.window.pdfjs_content_b64) {
      const binaryStr = parent.window.pdfjs_content_b64;
      const uint8 = _binaryStringToUint8Array(binaryStr);
      _waitForViewerReady().then(() => _app.open({ data: uint8 }));
      return;
    }
  } catch {
    // cross-origin — fall through to other strategies
  }

  // Strategy 2: ?file= parameter handled natively by the viewer.
  if (urlParams.get("file")) {
    return;
  }

  // Strategy 3: wait for an "openads-pdf-load" postMessage.
}

async function _saveToOpenads() {
  if (!_app?.pdfDocument) {
    return;
  }
  try {
    const storage = _app.pdfDocument.annotationStorage;
    let bytes;
    if (storage.size > 0) {
      bytes = await _app.pdfDocument.saveDocument();
    } else {
      // No edits — return the raw bytes (still send to parent so it can
      // confirm the round-trip without consuming PDF data).
      bytes = await _app.pdfDocument.getData();
    }

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
        type: "error",
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

export { initOpenadsBridge };
