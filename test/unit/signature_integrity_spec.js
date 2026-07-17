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

import {
  analyzePostSignatureUpdate,
  classifyChangedObject,
  collectChangedObjectRefs,
  endsAtRevisionBoundary,
  isPdfWhitespaceOnly,
  PostSignatureUpdate,
} from "../../src/core/signature_integrity.js";
import { Dict, Name, Ref, RefSet } from "../../src/core/primitives.js";
import { Stream, StringStream } from "../../src/core/stream.js";

function bytesOf(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    bytes[i] = string.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Minimal stand-in for XRef: `entries` drives the changed-object
 * enumeration, `objects` (Map of "num R gen" → object) backs fetchAsync.
 */
class FakeXRef {
  constructor({ entries, objects = new Map(), trailer = null }) {
    this.entries = entries;
    this._objects = objects;
    this.trailer = trailer;
  }

  async fetchAsync(ref) {
    if (!this._objects.has(ref.toString())) {
      throw new Error(`missing object: ${ref}`);
    }
    return this._objects.get(ref.toString());
  }
}

describe("signature_integrity", function () {
  describe("isPdfWhitespaceOnly", function () {
    it("accepts the empty range and PDF whitespace", function () {
      expect(isPdfWhitespaceOnly(new Uint8Array(0))).toEqual(true);
      expect(isPdfWhitespaceOnly(bytesOf("\r\n \t\f\0"))).toEqual(true);
    });

    it("rejects any non-whitespace byte", function () {
      expect(isPdfWhitespaceOnly(bytesOf("\r\nx"))).toEqual(false);
    });
  });

  describe("endsAtRevisionBoundary", function () {
    it("accepts %%EOF, with or without trailing EOL", function () {
      expect(endsAtRevisionBoundary(bytesOf("startxref\n116\n%%EOF"))).toEqual(
        true
      );
      expect(
        endsAtRevisionBoundary(bytesOf("startxref\n116\n%%EOF\r\n"))
      ).toEqual(true);
    });

    it("rejects a signed range not ending a revision", function () {
      expect(endsAtRevisionBoundary(bytesOf("54 0 obj\n<< /Le"))).toEqual(
        false
      );
      expect(endsAtRevisionBoundary(bytesOf("%%EO"))).toEqual(false);
      expect(endsAtRevisionBoundary(new Uint8Array(0))).toEqual(false);
    });
  });

  describe("collectChangedObjectRefs", function () {
    it("collects uncompressed entries at or beyond signedEnd", function () {
      const entries = [];
      entries[1] = { offset: 10, gen: 0, uncompressed: true };
      entries[2] = { offset: 500, gen: 0, uncompressed: true };
      entries[3] = { free: true, offset: 0, gen: 65535 };
      const xref = new FakeXRef({ entries });
      const changed = collectChangedObjectRefs(xref, 400);
      expect(changed).toEqual([Ref.get(2, 0)]);
    });

    it("attributes compressed entries to their object stream", function () {
      const entries = [];
      // Object stream 4 lives beyond signedEnd; object 7 is inside it.
      entries[4] = { offset: 900, gen: 0, uncompressed: true };
      entries[7] = { offset: 4, gen: 0 };
      // Object stream 5 predates the signature; object 8 is inside it.
      entries[5] = { offset: 50, gen: 0, uncompressed: true };
      entries[8] = { offset: 5, gen: 1 };
      const xref = new FakeXRef({ entries });
      const changed = collectChangedObjectRefs(xref, 400);
      expect(changed).toEqual([Ref.get(4, 0), Ref.get(7, 0)]);
    });
  });

  describe("classifyChangedObject", function () {
    const emptyCtx = { allowedRefs: new RefSet(), rootRef: null };

    it("flags signature values and fields as positive", function () {
      const sigValue = new Dict(null);
      sigValue.set("ByteRange", [0, 100, 200, 50]);
      sigValue.set("Contents", "\x01\x02");
      expect(classifyChangedObject(sigValue, Ref.get(9, 0), emptyCtx)).toEqual(
        "positive"
      );

      const timestamp = new Dict(null);
      timestamp.set("Type", Name.get("DocTimeStamp"));
      expect(classifyChangedObject(timestamp, Ref.get(9, 0), emptyCtx)).toEqual(
        "positive"
      );

      const sigField = new Dict(null);
      sigField.set("FT", Name.get("Sig"));
      expect(classifyChangedObject(sigField, Ref.get(9, 0), emptyCtx)).toEqual(
        "positive"
      );
    });

    it("flags DSS dictionaries, even without /Type, as positive", function () {
      const dss = new Dict(null);
      dss.set("Certs", [Ref.get(57, 0)]);
      expect(classifyChangedObject(dss, Ref.get(55, 0), emptyCtx)).toEqual(
        "positive"
      );
    });

    it("flags DSS-referenced payload streams as positive", function () {
      const allowedRefs = new RefSet();
      allowedRefs.put(Ref.get(57, 0));
      const certStream = new StringStream("not really DER");
      certStream.dict = new Dict(null);
      certStream.dict.set("Length", 14);
      expect(
        classifyChangedObject(certStream, Ref.get(57, 0), {
          allowedRefs,
          rootRef: null,
        })
      ).toEqual("positive");
    });

    it("keeps the catalog rewrite neutral, via /Type or /Root", function () {
      const typedCatalog = new Dict(null);
      typedCatalog.set("Type", Name.get("Catalog"));
      expect(
        classifyChangedObject(typedCatalog, Ref.get(28, 0), emptyCtx)
      ).toEqual("neutral");

      const untypedCatalog = new Dict(null);
      untypedCatalog.set("Pages", Ref.get(4, 0));
      expect(
        classifyChangedObject(untypedCatalog, Ref.get(28, 0), {
          allowedRefs: new RefSet(),
          rootRef: Ref.get(28, 0),
        })
      ).toEqual("neutral");
    });

    it("flags page rewrites and annotations as negative", function () {
      const page = new Dict(null);
      page.set("Type", Name.get("Page"));
      expect(classifyChangedObject(page, Ref.get(1, 0), emptyCtx)).toEqual(
        "negative"
      );

      const highlight = new Dict(null);
      highlight.set("Type", Name.get("Annot"));
      highlight.set("Subtype", Name.get("Highlight"));
      expect(
        classifyChangedObject(highlight, Ref.get(38, 0), emptyCtx)
      ).toEqual("negative");
    });

    it("flags an unreferenced bare stream as negative", function () {
      // A content stream swapped in by an incremental update has no /Type
      // and is referenced by nothing signature-related.
      const bare = new StringStream("0 0 m 10 10 l S");
      bare.dict = new Dict(null);
      bare.dict.set("Length", 15);
      expect(classifyChangedObject(bare, Ref.get(2, 0), emptyCtx)).toEqual(
        "negative"
      );
    });
  });

  describe("analyzePostSignatureUpdate", function () {
    // A signed revision of 116 bytes ending exactly with %%EOF\n.
    const SIGNED_PART = "%PDF-1.7\n".padEnd(100, "x") + "\n116\n%%EOF\n";
    const SIGNED_END = SIGNED_PART.length;

    function buildStream(tail) {
      return new Stream(bytesOf(SIGNED_PART + tail));
    }

    it("returns NONE when the signature covers the whole file", async function () {
      const stream = buildStream("");
      const verdict = await analyzePostSignatureUpdate({
        xref: new FakeXRef({ entries: [] }),
        stream,
        signedEnd: SIGNED_END,
        documentLength: SIGNED_END,
      });
      expect(verdict).toEqual(PostSignatureUpdate.NONE);
    });

    it("returns NONE for a whitespace-only tail", async function () {
      const stream = buildStream("\r\n \n");
      const verdict = await analyzePostSignatureUpdate({
        xref: new FakeXRef({ entries: [] }),
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.NONE);
    });

    it("returns MODIFICATION when the signed range does not end a revision", async function () {
      // Rewritten (non-incremental) file: the byte range no longer ends on
      // %%EOF — the real-world "saved over a signed file" case.
      const bytes = bytesOf("x".repeat(400));
      bytes.set(bytesOf("%%EOF\n"), 394);
      const stream = new Stream(bytes);
      const verdict = await analyzePostSignatureUpdate({
        xref: new FakeXRef({ entries: [] }),
        stream,
        signedEnd: 200,
        documentLength: 400,
      });
      expect(verdict).toEqual(PostSignatureUpdate.MODIFICATION);
    });

    it("returns MODIFICATION when trailing bytes match no changed object", async function () {
      const stream = buildStream("appended garbage, no revision\n");
      const entries = [];
      entries[1] = { offset: 10, gen: 0, uncompressed: true };
      const verdict = await analyzePostSignatureUpdate({
        xref: new FakeXRef({ entries }),
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.MODIFICATION);
    });

    it("returns PERMITTED for an LTV (/DSS) revision", async function () {
      // Mirrors the Goodflag / agent-card layout: catalog rewrite + DSS
      // + VRI + untyped certificate/CRL/OCSP streams.
      const tail =
        "55 0 obj\n<<...>>\nendobj\nxref\n...\ntrailer\n<<...>>\n%%EOF\n";
      const stream = buildStream(tail);

      const dss = new Dict(null);
      dss.set("VRI", Ref.get(56, 0));
      dss.set("Certs", [Ref.get(57, 0)]);
      dss.set("CRLs", [Ref.get(58, 0)]);

      const vri = new Dict(null);
      const vriEntry = new Dict(null);
      vriEntry.set("Cert", [Ref.get(57, 0)]);
      vri.set("B35CB34C", vriEntry);

      const certStream = new StringStream("cert");
      certStream.dict = new Dict(null);
      const crlStream = new StringStream("crl");
      crlStream.dict = new Dict(null);

      const catalog = new Dict(null);
      catalog.set("Pages", Ref.get(4, 0));
      catalog.set("DSS", Ref.get(55, 0));

      const entries = [];
      entries[28] = { offset: SIGNED_END + 40, gen: 0, uncompressed: true };
      entries[55] = { offset: SIGNED_END + 2, gen: 0, uncompressed: true };
      entries[56] = { offset: SIGNED_END + 10, gen: 0, uncompressed: true };
      entries[57] = { offset: SIGNED_END + 20, gen: 0, uncompressed: true };
      entries[58] = { offset: SIGNED_END + 30, gen: 0, uncompressed: true };

      const trailer = new Dict(null);
      trailer.set("Root", Ref.get(28, 0));

      const xref = new FakeXRef({
        entries,
        trailer,
        objects: new Map([
          [Ref.get(28, 0).toString(), catalog],
          [Ref.get(55, 0).toString(), dss],
          [Ref.get(56, 0).toString(), vri],
          [Ref.get(57, 0).toString(), certStream],
          [Ref.get(58, 0).toString(), crlStream],
        ]),
      });

      const verdict = await analyzePostSignatureUpdate({
        xref,
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.PERMITTED);
    });

    it("returns PERMITTED for an additional-signature revision", async function () {
      const tail = "47 0 obj\n<<...>>\nendobj\n...\n%%EOF\n";
      const stream = buildStream(tail);

      const sigValue = new Dict(null);
      sigValue.set("ByteRange", [0, 300, 400, 50]);
      sigValue.set("Contents", "\x01");

      const sigField = new Dict(null);
      sigField.set("FT", Name.get("Sig"));
      sigField.set("Subtype", Name.get("Widget"));
      sigField.set("V", Ref.get(48, 0));

      const acroForm = new Dict(null);
      acroForm.set("Fields", [Ref.get(47, 0)]);
      acroForm.set("SigFlags", 3);

      const entries = [];
      entries[46] = { offset: SIGNED_END + 1, gen: 0, uncompressed: true };
      entries[47] = { offset: SIGNED_END + 5, gen: 0, uncompressed: true };
      entries[48] = { offset: SIGNED_END + 9, gen: 0, uncompressed: true };

      const xref = new FakeXRef({
        entries,
        objects: new Map([
          [Ref.get(46, 0).toString(), acroForm],
          [Ref.get(47, 0).toString(), sigField],
          [Ref.get(48, 0).toString(), sigValue],
        ]),
      });

      const verdict = await analyzePostSignatureUpdate({
        xref,
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.PERMITTED);
    });

    it("returns MODIFICATION for an annotation revision", async function () {
      // Mirrors the highlight-annotation case: page rewrite + annotation
      // + appearance form.
      const tail = "1 0 obj\n<<...>>\nendobj\n...\n%%EOF\n";
      const stream = buildStream(tail);

      const page = new Dict(null);
      page.set("Type", Name.get("Page"));
      const highlight = new Dict(null);
      highlight.set("Type", Name.get("Annot"));
      highlight.set("Subtype", Name.get("Highlight"));

      const entries = [];
      entries[1] = { offset: SIGNED_END + 1, gen: 0, uncompressed: true };
      entries[38] = { offset: SIGNED_END + 50, gen: 0, uncompressed: true };

      const xref = new FakeXRef({
        entries,
        objects: new Map([
          [Ref.get(1, 0).toString(), page],
          [Ref.get(38, 0).toString(), highlight],
        ]),
      });

      const verdict = await analyzePostSignatureUpdate({
        xref,
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.MODIFICATION);
    });

    it("returns MODIFICATION for structural churn without signature payload", async function () {
      const tail = "28 0 obj\n<<...>>\nendobj\n...\n%%EOF\n";
      const stream = buildStream(tail);

      const catalog = new Dict(null);
      catalog.set("Type", Name.get("Catalog"));

      const entries = [];
      entries[28] = { offset: SIGNED_END + 1, gen: 0, uncompressed: true };

      const xref = new FakeXRef({
        entries,
        objects: new Map([[Ref.get(28, 0).toString(), catalog]]),
      });

      const verdict = await analyzePostSignatureUpdate({
        xref,
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.MODIFICATION);
    });

    it("returns INDETERMINATE when a changed object cannot be fetched", async function () {
      const tail = "55 0 obj\n<<...>>\nendobj\n...\n%%EOF\n";
      const stream = buildStream(tail);

      const entries = [];
      entries[55] = { offset: SIGNED_END + 2, gen: 0, uncompressed: true };

      const xref = new FakeXRef({ entries, objects: new Map() });

      const verdict = await analyzePostSignatureUpdate({
        xref,
        stream,
        signedEnd: SIGNED_END,
        documentLength: stream.length,
      });
      expect(verdict).toEqual(PostSignatureUpdate.INDETERMINATE);
    });

    it("returns MODIFICATION when the byte range exceeds the file", async function () {
      const stream = buildStream("");
      const verdict = await analyzePostSignatureUpdate({
        xref: new FakeXRef({ entries: [] }),
        stream,
        signedEnd: SIGNED_END + 10,
        documentLength: SIGNED_END,
      });
      expect(verdict).toEqual(PostSignatureUpdate.MODIFICATION);
    });
  });
});
