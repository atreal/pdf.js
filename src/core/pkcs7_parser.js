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
 * Minimal ASN.1 / DER walker tailored for PDF signature blobs.
 *
 * Goal: from the raw PKCS#7 (CMS) DER bytes inside `/Contents`, extract
 * the *signer's* identity (subject DN of the leaf certificate, possibly
 * split into givenName / surname / commonName) and the `signingTime`
 * authenticated attribute. No cryptographic verification — pure parsing.
 *
 * What we do NOT do: validate the signature, the certificate chain, or
 * any timestamp authority. Those belong to a downstream service (phase B).
 */

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_PRINTABLE_STRING = 0x13;
const TAG_IA5_STRING = 0x16;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_BMP_STRING = 0x1e;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const TAG_CONTEXT_0 = 0xa0; // [0] (constructed)

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";

const SUBJECT_OIDS = {
  "2.5.4.3": "commonName",
  "2.5.4.4": "surname",
  "2.5.4.42": "givenName",
  "2.5.4.6": "country",
  "2.5.4.7": "locality",
  "2.5.4.8": "stateOrProvince",
  "2.5.4.10": "organization",
  "2.5.4.11": "organizationalUnit",
  "2.5.4.97": "organizationIdentifier",
  "1.2.840.113549.1.9.1": "emailAddress",
};

class DerError extends Error {}

/**
 * Read one TLV at `pos`. Returns { tag, contentStart, contentEnd, end }.
 * Throws DerError on malformed input.
 */
function readTLV(buf, pos) {
  if (pos >= buf.length) {
    throw new DerError("DER: unexpected end of buffer");
  }
  const tag = buf[pos];
  let p = pos + 1;
  if (p >= buf.length) {
    throw new DerError("DER: truncated length");
  }
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) {
      throw new DerError("DER: invalid long length");
    }
    len = 0;
    for (let i = 0; i < n; i++) {
      len = len * 256 + buf[p++];
    }
  }
  const contentEnd = p + len;
  if (contentEnd > buf.length) {
    throw new DerError("DER: content overruns buffer");
  }
  return { tag, contentStart: p, contentEnd, end: contentEnd };
}

function* iterChildren(buf, start, end) {
  let p = start;
  while (p < end) {
    const t = readTLV(buf, p);
    yield t;
    p = t.end;
  }
}

function decodeOID(buf, tlv) {
  if (tlv.tag !== TAG_OID) {
    throw new DerError(`DER: expected OID, got tag 0x${tlv.tag.toString(16)}`);
  }
  const b = buf.subarray(tlv.contentStart, tlv.contentEnd);
  if (b.length === 0) {
    return "";
  }
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      out.push(v);
      v = 0;
    }
  }
  return out.join(".");
}

function decodeString(buf, tlv) {
  const b = buf.subarray(tlv.contentStart, tlv.contentEnd);
  switch (tlv.tag) {
    case TAG_UTF8_STRING:
      return new TextDecoder("utf-8").decode(b);
    case TAG_PRINTABLE_STRING:
    case TAG_IA5_STRING:
      // Both are ASCII subsets; UTF-8 decoding is safe.
      return new TextDecoder("utf-8").decode(b);
    case TAG_BMP_STRING:
      return new TextDecoder("utf-16be").decode(b);
    case TAG_OCTET_STRING:
      return new TextDecoder("utf-8").decode(b);
    default:
      // Best-effort for any other string-ish tag (e.g. T61String).
      return new TextDecoder("utf-8", { fatal: false }).decode(b);
  }
}

/**
 * Parse an ASN.1 Time (UTCTime or GeneralizedTime) into an ISO string.
 * UTCTime: YYMMDDHHMMSSZ (or with timezone)
 * GeneralizedTime: YYYYMMDDHHMMSSZ
 */
function decodeTime(buf, tlv) {
  const raw = decodeString(buf, { ...tlv, tag: TAG_PRINTABLE_STRING });
  let y, mo, d, h, mi, s, tz;
  if (tlv.tag === TAG_UTC_TIME) {
    const m = raw.match(
      /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/
    );
    if (!m) {
      return null;
    }
    const yy = parseInt(m[1], 10);
    y = yy >= 50 ? 1900 + yy : 2000 + yy;
    [, , mo, d, h, mi] = m;
    s = m[6] || "00";
    tz = m[7] || "Z";
  } else if (tlv.tag === TAG_GENERALIZED_TIME) {
    const m = raw.match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/
    );
    if (!m) {
      return null;
    }
    [, y, mo, d, h, mi] = m;
    s = m[6] || "00";
    tz = m[7] || "Z";
  } else {
    return null;
  }
  const tzPart =
    tz === "Z" || !tz ? "Z" : `${tz.slice(0, 3)}:${tz.slice(3) || "00"}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${tzPart}`;
}

function parseDN(buf, start, end) {
  const dn = {};
  for (const rdn of iterChildren(buf, start, end)) {
    if (rdn.tag !== TAG_SET) {
      continue;
    }
    for (const atv of iterChildren(buf, rdn.contentStart, rdn.contentEnd)) {
      if (atv.tag !== TAG_SEQUENCE) {
        continue;
      }
      const inner = [...iterChildren(buf, atv.contentStart, atv.contentEnd)];
      if (inner.length < 2) {
        continue;
      }
      let oid;
      try {
        oid = decodeOID(buf, inner[0]);
      } catch {
        continue;
      }
      const key = SUBJECT_OIDS[oid];
      if (!key) {
        continue;
      }
      try {
        dn[key] = decodeString(buf, inner[1]);
      } catch {
        // skip on decoding failure
      }
    }
  }
  return dn;
}

/**
 * Walk a SignedData SEQUENCE's children and return an object describing
 * the parts we care about. Children of SignedData are:
 *   { version, digestAlgorithms, encapContentInfo, certificates? [0],
 *     crls? [1], signerInfos }.
 */
function indexSignedData(buf, signedDataStart, signedDataEnd) {
  const found = { certificates: null, signerInfos: null };
  for (const child of iterChildren(buf, signedDataStart, signedDataEnd)) {
    if (child.tag === TAG_CONTEXT_0) {
      // [0] IMPLICIT certificates
      found.certificates ??= child;
    } else if (child.tag === TAG_SET) {
      // The first SET after certificates/crls is signerInfos.
      found.signerInfos = child;
    }
  }
  return found;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Read the first SignerInfo and return its identifying fields plus the
 * signing-time authenticated attribute (if present). Multiple signers in
 * one PKCS#7 are rare in PDFs; the first is enough.
 *
 * @returns {{
 *   issuerBytes: Uint8Array | null,
 *   serialBytes: Uint8Array | null,
 *   signingTime: string | null,
 * } | null}
 */
function readFirstSignerInfo(buf, signerInfosTlv) {
  if (!signerInfosTlv) {
    return null;
  }
  const first = readTLV(buf, signerInfosTlv.contentStart);
  if (first.tag !== TAG_SEQUENCE) {
    return null;
  }
  // SignerInfo ::= SEQUENCE {
  //   version, sid, digestAlgorithm, [0] IMPLICIT signedAttrs OPTIONAL,
  //   signatureAlgorithm, signature, [1] IMPLICIT unsignedAttrs OPTIONAL }
  // sid ::= CHOICE {
  //   issuerAndSerialNumber: SEQUENCE { issuer Name, serialNumber INTEGER },
  //   [0] IMPLICIT subjectKeyIdentifier OCTET STRING (CMS v3) }
  const children = [...iterChildren(buf, first.contentStart, first.contentEnd)];
  let i = 0;
  if (children[i]?.tag === TAG_INTEGER) {
    i++; // version
  }
  let issuerBytes = null;
  let serialBytes = null;
  const sid = children[i++];
  if (sid?.tag === TAG_SEQUENCE) {
    // issuerAndSerialNumber
    const sidChildren = [
      ...iterChildren(buf, sid.contentStart, sid.contentEnd),
    ];
    const issuerTlv = sidChildren[0];
    const serialTlv = sidChildren[1];
    if (issuerTlv) {
      issuerBytes = buf.subarray(issuerTlv.contentStart, issuerTlv.contentEnd);
    }
    if (serialTlv) {
      serialBytes = buf.subarray(serialTlv.contentStart, serialTlv.contentEnd);
    }
  }
  // Skip digestAlgorithm
  if (children[i]?.tag === TAG_SEQUENCE) {
    i++;
  }
  // [0] IMPLICIT signedAttrs (optional) — search for signing-time attribute.
  let signingTime = null;
  if (children[i]?.tag === TAG_CONTEXT_0) {
    const signedAttrs = children[i];
    for (const attr of iterChildren(
      buf,
      signedAttrs.contentStart,
      signedAttrs.contentEnd
    )) {
      if (attr.tag !== TAG_SEQUENCE) {
        continue;
      }
      const parts = [...iterChildren(buf, attr.contentStart, attr.contentEnd)];
      if (parts.length < 2) {
        continue;
      }
      let oid;
      try {
        oid = decodeOID(buf, parts[0]);
      } catch {
        continue;
      }
      if (oid !== OID_SIGNING_TIME) {
        continue;
      }
      const valueSet = parts[1];
      if (valueSet.tag !== TAG_SET) {
        continue;
      }
      const timeTlv = readTLV(buf, valueSet.contentStart);
      try {
        signingTime = decodeTime(buf, timeTlv);
      } catch {
        signingTime = null;
      }
      break;
    }
  }
  return { issuerBytes, serialBytes, signingTime };
}

/**
 * Extract the *subject* of the cert that issued `signerInfo.sid`. PKCS#7
 * `certificates` is an unordered SET that typically holds the full chain
 * (leaf + intermediates + root), so picking the first cert gets the wrong
 * one — we need the cert whose `issuer + serial` matches the SignerInfo.
 */
function extractSignerSubjectDN(buf, certificatesTlv, signerInfo) {
  if (!certificatesTlv) {
    return null;
  }
  let fallbackSubject = null;
  let pos = certificatesTlv.contentStart;
  while (pos < certificatesTlv.contentEnd) {
    let cert;
    try {
      cert = readTLV(buf, pos);
    } catch {
      break;
    }
    pos = cert.end;
    if (cert.tag !== TAG_SEQUENCE) {
      continue;
    }
    let tbs;
    try {
      tbs = readTLV(buf, cert.contentStart);
    } catch {
      continue;
    }
    if (tbs.tag !== TAG_SEQUENCE) {
      continue;
    }
    const tbsChildren = [
      ...iterChildren(buf, tbs.contentStart, tbs.contentEnd),
    ];
    let i = 0;
    if (tbsChildren[i]?.tag === TAG_CONTEXT_0) {
      i++; // [0] EXPLICIT version
    }
    const serialTlv =
      tbsChildren[i]?.tag === TAG_INTEGER ? tbsChildren[i++] : null;
    if (tbsChildren[i]?.tag === TAG_SEQUENCE) {
      i++; // signatureAlgorithm
    }
    const issuerTlv =
      tbsChildren[i]?.tag === TAG_SEQUENCE ? tbsChildren[i++] : null;
    if (tbsChildren[i]?.tag === TAG_SEQUENCE) {
      i++; // validity
    }
    const subjectTlv =
      tbsChildren[i]?.tag === TAG_SEQUENCE ? tbsChildren[i] : null;
    if (!subjectTlv) {
      continue;
    }

    const isMatch =
      issuerTlv &&
      serialTlv &&
      signerInfo?.issuerBytes &&
      signerInfo?.serialBytes &&
      bytesEqual(
        buf.subarray(issuerTlv.contentStart, issuerTlv.contentEnd),
        signerInfo.issuerBytes
      ) &&
      bytesEqual(
        buf.subarray(serialTlv.contentStart, serialTlv.contentEnd),
        signerInfo.serialBytes
      );

    if (isMatch) {
      return parseDN(buf, subjectTlv.contentStart, subjectTlv.contentEnd);
    }
    // Remember the first parsable subject as a last-resort fallback.
    fallbackSubject ??= parseDN(
      buf,
      subjectTlv.contentStart,
      subjectTlv.contentEnd
    );
  }
  return fallbackSubject;
}

/**
 * Top-level entry point. Given the raw PKCS#7 (CMS) DER bytes from a PDF
 * signature's `/Contents`, return a metadata object containing what we
 * could extract. All fields are nullable.
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   subject: Object | null,
 *   signingTime: string | null,
 * } | null}
 */
function extractPkcs7Metadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return null;
  }
  try {
    const contentInfo = readTLV(bytes, 0);
    if (contentInfo.tag !== TAG_SEQUENCE) {
      return null;
    }
    const ciChildren = [
      ...iterChildren(bytes, contentInfo.contentStart, contentInfo.contentEnd),
    ];
    if (ciChildren.length < 2) {
      return null;
    }
    const oid = decodeOID(bytes, ciChildren[0]);
    if (oid !== OID_SIGNED_DATA) {
      return null;
    }
    const explicit = ciChildren[1];
    if (explicit.tag !== TAG_CONTEXT_0) {
      return null;
    }
    const signedData = readTLV(bytes, explicit.contentStart);
    if (signedData.tag !== TAG_SEQUENCE) {
      return null;
    }
    const { certificates, signerInfos } = indexSignedData(
      bytes,
      signedData.contentStart,
      signedData.contentEnd
    );
    const signerInfo = readFirstSignerInfo(bytes, signerInfos);
    return {
      subject: extractSignerSubjectDN(bytes, certificates, signerInfo),
      signingTime: signerInfo?.signingTime ?? null,
    };
  } catch {
    return null;
  }
}

export { extractPkcs7Metadata };
