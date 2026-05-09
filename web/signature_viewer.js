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
 * Read-only viewer for the electronic signatures present in a PDF.
 *
 * This is *purely* a presentation layer over `pdfDocument.getSignatures()` —
 * no cryptographic verification is performed. The dropdown lists each
 * signature's declared metadata (signer, date, reason, location) with an
 * explicit "non vérifiée" disclaimer so users do not confuse parsing with
 * trust.
 */

const BANNER_ID = "signaturesBanner";
const BANNER_TOGGLE_ID = "signaturesBannerToggle";
const BANNER_DETAILS_ID = "signaturesBannerDetails";
const BANNER_SUMMARY_ID = "signaturesBannerSummary";
const PANEL_LIST_ID = "signaturesPanelList";

function initSignatureViewer(app) {
  const banner = document.getElementById(BANNER_ID);
  const toggle = document.getElementById(BANNER_TOGGLE_ID);
  const details = document.getElementById(BANNER_DETAILS_ID);
  const summaryEl = document.getElementById(BANNER_SUMMARY_ID);
  const listEl = document.getElementById(PANEL_LIST_ID);

  if (!banner || !toggle || !details || !listEl) {
    return;
  }

  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    details.classList.add("hidden");
  };
  const open = () => {
    toggle.setAttribute("aria-expanded", "true");
    details.classList.remove("hidden");
  };

  toggle.addEventListener("click", () => {
    if (details.classList.contains("hidden")) {
      open();
    } else {
      close();
    }
  });

  const reset = () => {
    banner.setAttribute("hidden", "true");
    listEl.replaceChildren();
    if (summaryEl) {
      summaryEl.textContent = "";
    }
    close();
  };

  const refresh = async () => {
    reset();
    const pdfDocument = app?.pdfDocument;
    if (!pdfDocument) {
      return;
    }
    let signatures = null;
    try {
      signatures = await pdfDocument.getSignatures();
    } catch {
      return;
    }
    // Bail out if the document was swapped while we were waiting.
    if (app.pdfDocument !== pdfDocument) {
      return;
    }
    if (!signatures?.length) {
      return;
    }

    listEl.replaceChildren(...signatures.map(_buildSignatureItem));
    if (summaryEl) {
      const n = signatures.length;
      const docModified = signatures.some(
        sig => sig.coversWholeDocument === false
      );
      const head =
        n === 1
          ? "1 signature électronique détectée"
          : `${n} signatures électroniques détectées`;
      const tail = docModified
        ? "— document modifié après signature"
        : "— intégrité non vérifiée crypto.";
      summaryEl.textContent = `${head} ${tail}`;
    }
    // Surface modification with a different banner accent.
    const anyModified = signatures.some(s => s.coversWholeDocument === false);
    banner.classList.toggle("signaturesBannerWarn", anyModified);
    banner.removeAttribute("hidden");
  };

  app.eventBus?.on("documentloaded", refresh);
  app.eventBus?.on("documentempty", reset);
}

function _buildSignatureItem(sig) {
  const li = document.createElement("li");
  li.className = "signaturesPanelItem";

  const title = document.createElement("div");
  title.className = "signaturesPanelItemTitle";
  title.textContent = _resolveSignerLabel(sig);
  li.append(title);

  const subj = sig.certificateSubject;
  if (subj?.emailAddress) {
    const emailEl = document.createElement("div");
    emailEl.className = "signaturesPanelItemMeta";
    emailEl.textContent = subj.emailAddress;
    li.append(emailEl);
  }
  if (subj?.organization) {
    const orgEl = document.createElement("div");
    orgEl.className = "signaturesPanelItemMeta";
    orgEl.textContent = subj.organization;
    li.append(orgEl);
  }

  const date =
    _formatPdfDate(sig.signingDate) || _formatIsoDate(sig.signingTimeFromCert);
  if (date) {
    const dateEl = document.createElement("div");
    dateEl.className = "signaturesPanelItemMeta";
    dateEl.textContent = date;
    li.append(dateEl);
  }

  if (sig.coversWholeDocument === true) {
    const okEl = document.createElement("div");
    okEl.className = "signaturesPanelItemMeta signaturesPanelItemOk";
    okEl.textContent = "Document non modifié après cette signature";
    li.append(okEl);
  } else if (sig.coversWholeDocument === false) {
    const koEl = document.createElement("div");
    koEl.className = "signaturesPanelItemMeta signaturesPanelItemKo";
    koEl.textContent = "Document modifié après cette signature";
    li.append(koEl);
  }

  for (const [label, value] of [
    ["Motif", sig.reason],
    ["Lieu", sig.location],
    ["Format", sig.subFilter],
  ]) {
    if (!value) {
      continue;
    }
    const row = document.createElement("div");
    row.className = "signaturesPanelItemMeta";
    const k = document.createElement("span");
    k.className = "signaturesPanelItemMetaKey";
    k.textContent = `${label} : `;
    const v = document.createElement("span");
    v.textContent = value;
    row.append(k, v);
    li.append(row);
  }

  return li;
}

/**
 * Prefer, in order:
 *   1. /Name (declared in the signature dict, often empty)
 *   2. givenName + surname from the X.509 certificate's Subject
 *   3. commonName from the certificate
 *   4. fieldName (technical fallback)
 */
function _resolveSignerLabel(sig) {
  if (sig.signerName) {
    return sig.signerName;
  }
  const subj = sig.certificateSubject;
  if (subj) {
    const composed = [subj.givenName, subj.surname].filter(Boolean).join(" ");
    if (composed) {
      return composed;
    }
    if (subj.commonName) {
      return subj.commonName;
    }
  }
  return sig.fieldName || "Signataire inconnu";
}

function _formatIsoDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Convert a PDF date string ("D:YYYYMMDDHHmmss±HH'mm'") to a French
 * locale string. Returns null on parsing failure so the caller can fall
 * back to omitting the row.
 */
function _formatPdfDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const m = value.match(
    /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:([Z+-])(\d{2})'?(\d{2})?'?)?/
  );
  if (!m) {
    return null;
  }
  const [, y, mo, d, h = "00", mi = "00", s = "00", tz, tzH, tzM = "00"] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz === "Z") {
    iso += "Z";
  } else if (tz === "+" || tz === "-") {
    iso += `${tz}${tzH}:${tzM}`;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export { initSignatureViewer };
