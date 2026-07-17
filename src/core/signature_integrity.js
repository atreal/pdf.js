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
 * Structural (non-cryptographic) analysis of the bytes located *after* the
 * range covered by a signature's `/ByteRange`.
 *
 * A signed `/ByteRange` that stops short of EOF does NOT necessarily mean
 * the document content was altered: standard signing flows legitimately
 * append incremental updates after the CMS is computed — PAdES LTV
 * validation data (/DSS with certificates, CRLs, OCSP responses), document
 * timestamps, or additional signatures. Adobe classifies those as
 * "permitted changes" and still reports the document as unmodified.
 *
 * This module classifies the appended revisions by inspecting which objects
 * they (re)define, using the already-parsed cross-reference table:
 *
 * - signature infrastructure (DSS/VRI dictionaries and every stream they
 *   reference, new signature fields/values, document timestamps) plus the
 *   structural churn they inevitably cause (catalog/AcroForm rewrite, xref
 *   and object streams, metadata) → {@link PostSignatureUpdate.PERMITTED};
 * - anything else (page rewrites, annotations, content streams, …)
 *   → {@link PostSignatureUpdate.MODIFICATION}.
 *
 * This is a best-effort signal aimed at honest documents; it is NOT a
 * defense against a determined attacker (that requires cryptographic
 * verification plus full revision diffing, out of scope for the worker).
 */

import { Dict, isName, Ref, RefSet } from "./primitives.js";
import { BaseStream } from "./base_stream.js";

const PostSignatureUpdate = {
  /** No byte, or only whitespace, after the signed range. */
  NONE: "none",
  /** Only signature-infrastructure updates after the signed range. */
  PERMITTED: "permitted",
  /** Content-affecting bytes after the signed range. */
  MODIFICATION: "modification",
  /** The trailing bytes could not be analyzed. */
  INDETERMINATE: "indeterminate",
};

// PDF whitespace: NUL, HT, LF, FF, CR, SP (ISO 32000-1, 7.2.2).
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"

function isPdfWhitespaceOnly(bytes) {
  for (const byte of bytes) {
    if (!PDF_WHITESPACE.has(byte)) {
      return false;
    }
  }
  return true;
}

/**
 * A well-formed signature covers its file up to the end of a revision, so
 * the signed bytes must end with "%%EOF" (possibly followed by an EOL that
 * is part of the range). When they don't, the file was rewritten in place
 * after signing (non-incremental save): the digest is broken and the
 * trailing bytes cannot be attributed to a revision.
 *
 * @param {Uint8Array} windowBytes - The last bytes of the signed range.
 */
function endsAtRevisionBoundary(windowBytes) {
  let end = windowBytes.length;
  while (end > 0 && PDF_WHITESPACE.has(windowBytes[end - 1])) {
    end--;
  }
  if (end < EOF_MARKER.length) {
    return false;
  }
  for (let i = 0; i < EOF_MARKER.length; i++) {
    if (windowBytes[end - EOF_MARKER.length + i] !== EOF_MARKER[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Object numbers whose *latest* definition lives beyond `signedEnd`, i.e.
 * everything (re)defined by the post-signature revisions. Compressed
 * entries are attributed to the offset of their containing object stream.
 */
function collectChangedObjectRefs(xref, signedEnd) {
  const changed = [];
  const { entries } = xref;
  for (let num = 1; num < entries.length; num++) {
    const entry = entries[num];
    if (!entry || entry.free) {
      continue;
    }
    if (entry.uncompressed) {
      if (entry.offset >= signedEnd) {
        changed.push(Ref.get(num, entry.gen));
      }
      continue;
    }
    // Compressed entry: `offset` is the number of the object stream.
    const container = entries[entry.offset];
    if (container?.uncompressed && container.offset >= signedEnd) {
      changed.push(Ref.get(num, 0));
    }
  }
  return changed;
}

function isDssDict(dict) {
  return (
    isName(dict.get("Type"), "DSS") ||
    dict.has("VRI") ||
    dict.has("Certs") ||
    dict.has("OCSPs") ||
    dict.has("CRLs")
  );
}

/**
 * Whitelist every object reachable from a /DSS dictionary: the VRI
 * dictionaries and the certificate / CRL / OCSP / timestamp streams. Those
 * streams carry no self-describing /Type, so reference-tracking is the only
 * way to tell them apart from, say, a swapped page content stream.
 */
async function collectDssReferencedRefs(dssDict, allowedRefs) {
  const addRefs = array => {
    if (!Array.isArray(array)) {
      return;
    }
    for (const item of array) {
      if (item instanceof Ref) {
        allowedRefs.put(item);
      }
    }
  };

  for (const key of ["Certs", "OCSPs", "CRLs"]) {
    addRefs(await dssDict.getAsync(key));
  }

  const vriRaw = dssDict.getRaw("VRI");
  if (vriRaw instanceof Ref) {
    allowedRefs.put(vriRaw);
  }
  const vri = await dssDict.getAsync("VRI");
  if (!(vri instanceof Dict)) {
    return;
  }
  for (const name of vri.getKeys()) {
    const entryRaw = vri.getRaw(name);
    if (entryRaw instanceof Ref) {
      allowedRefs.put(entryRaw);
    }
    const entry = await vri.getAsync(name);
    if (!(entry instanceof Dict)) {
      continue;
    }
    for (const key of ["Cert", "CRL", "OCSP", "TS"]) {
      addRefs(await entry.getAsync(key));
    }
  }
}

/**
 * @returns {"positive" | "neutral" | "negative"} "positive" objects are the
 *   signature-infrastructure payload that justifies the revision; "neutral"
 *   objects are the structural churn such payloads inevitably cause; any
 *   "negative" object marks the revision as a real modification.
 */
function classifyChangedObject(obj, ref, { allowedRefs, rootRef }) {
  const dict = obj instanceof BaseStream ? obj.dict : obj;
  if (!(dict instanceof Dict)) {
    // A scalar or array rewritten after signing cannot be attributed to
    // any signing flow.
    return "negative";
  }
  if (allowedRefs.has(ref)) {
    return "positive";
  }
  if (isDssDict(dict)) {
    return "positive";
  }
  const type = dict.get("Type");
  if (isName(type, "Sig") || isName(type, "DocTimeStamp")) {
    return "positive";
  }
  // A signature (or document timestamp) value, with or without /Type.
  if (dict.has("ByteRange") && dict.has("Contents")) {
    return "positive";
  }
  // A (new) signature field.
  if (isName(dict.get("FT"), "Sig")) {
    return "positive";
  }
  if (
    isName(type, "XRef") ||
    isName(type, "ObjStm") ||
    isName(type, "Metadata") ||
    isName(type, "Catalog")
  ) {
    return "neutral";
  }
  // The catalog is rewritten to hook up /DSS or /AcroForm, and may lack an
  // explicit /Type; recognize it as the trailer's /Root target.
  if (
    rootRef instanceof Ref &&
    ref instanceof Ref &&
    rootRef.num === ref.num &&
    rootRef.gen === ref.gen
  ) {
    return "neutral";
  }
  // The widget annotation carrying a new signature's appearance.
  if (isName(dict.get("Subtype"), "Widget")) {
    return "neutral";
  }
  // The AcroForm dictionary, rewritten when a signature field is added.
  if (dict.has("Fields") && dict.has("SigFlags")) {
    return "neutral";
  }
  return "negative";
}

/**
 * Classify the bytes located after `signedEnd` in the document.
 *
 * @param {Object} params
 * @param {XRef} params.xref - The document's parsed cross-reference table.
 * @param {BaseStream} params.stream - The full document stream.
 * @param {number} params.signedEnd - End of the signed range
 *   (`byteRange[2] + byteRange[3]`).
 * @param {number} params.documentLength - Total length of the document.
 * @returns {Promise<string>} One of the {@link PostSignatureUpdate} values.
 */
async function analyzePostSignatureUpdate({
  xref,
  stream,
  signedEnd,
  documentLength,
}) {
  if (
    !Number.isInteger(signedEnd) ||
    !Number.isInteger(documentLength) ||
    signedEnd <= 0 ||
    documentLength <= 0
  ) {
    return PostSignatureUpdate.INDETERMINATE;
  }
  if (signedEnd > documentLength) {
    // The /ByteRange points beyond EOF: the file was truncated or the
    // signature dictionary is corrupt.
    return PostSignatureUpdate.MODIFICATION;
  }
  if (signedEnd === documentLength) {
    return PostSignatureUpdate.NONE;
  }

  let tailBytes, signedEndWindow;
  try {
    tailBytes = stream
      .makeSubStream(signedEnd, documentLength - signedEnd, null)
      .getBytes();
    const windowLength = Math.min(32, signedEnd);
    signedEndWindow = stream
      .makeSubStream(signedEnd - windowLength, windowLength, null)
      .getBytes();
  } catch {
    return PostSignatureUpdate.INDETERMINATE;
  }

  if (isPdfWhitespaceOnly(tailBytes)) {
    return PostSignatureUpdate.NONE;
  }
  if (!endsAtRevisionBoundary(signedEndWindow)) {
    return PostSignatureUpdate.MODIFICATION;
  }

  const changedRefs = collectChangedObjectRefs(xref, signedEnd);
  if (changedRefs.length === 0) {
    // Non-whitespace trailing bytes that the xref chain does not account
    // for; play it safe.
    return PostSignatureUpdate.MODIFICATION;
  }

  const changedObjects = [];
  let fetchFailed = false;
  for (const ref of changedRefs) {
    try {
      changedObjects.push({ ref, obj: await xref.fetchAsync(ref) });
    } catch {
      fetchFailed = true;
    }
  }

  const allowedRefs = new RefSet();
  for (const { obj } of changedObjects) {
    const dict = obj instanceof BaseStream ? obj.dict : obj;
    if (dict instanceof Dict && isDssDict(dict)) {
      try {
        await collectDssReferencedRefs(dict, allowedRefs);
      } catch {
        // Unresolvable DSS content: its payload streams will simply not be
        // whitelisted below.
      }
    }
  }

  const rootRef =
    xref.trailer instanceof Dict ? xref.trailer.getRaw("Root") : null;

  let positives = 0;
  for (const { ref, obj } of changedObjects) {
    const classification = classifyChangedObject(obj, ref, {
      allowedRefs,
      rootRef,
    });
    if (classification === "negative") {
      return PostSignatureUpdate.MODIFICATION;
    }
    if (classification === "positive") {
      positives++;
    }
  }
  if (fetchFailed) {
    return PostSignatureUpdate.INDETERMINATE;
  }
  if (positives > 0) {
    return PostSignatureUpdate.PERMITTED;
  }
  // Structural churn only (catalog/xref/metadata) with no signature payload
  // attached: nothing legitimizes the revision.
  return PostSignatureUpdate.MODIFICATION;
}

export {
  analyzePostSignatureUpdate,
  classifyChangedObject,
  collectChangedObjectRefs,
  endsAtRevisionBoundary,
  isPdfWhitespaceOnly,
  PostSignatureUpdate,
};
