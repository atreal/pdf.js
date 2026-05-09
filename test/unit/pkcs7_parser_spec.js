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

import { extractPkcs7Metadata } from "../../src/core/pkcs7_parser.js";

// Self-signed test fixture generated with:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
//     -subj "/CN=Alice Architect/GN=Alice/SN=Architect/O=ATReal/\
//            emailAddress=alice@example.org/C=FR" \
//     -keyout key.pem -out cert.pem
//   echo "test data" > data.txt
//   openssl smime -sign -in data.txt -signer cert.pem -inkey key.pem \
//     -outform DER -out sig.der -nodetach
//
// The blob includes signed (authenticated) attributes — among them
// signingTime — which exercises the SignerInfo path of the parser.
const FIXTURE_BASE64 =
  "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";

function base64ToBytes(b64) {
  const bin = globalThis.atob
    ? globalThis.atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

describe("pkcs7_parser", function () {
  it("returns null for an empty buffer", function () {
    expect(extractPkcs7Metadata(new Uint8Array(0))).toBeNull();
  });

  it("returns null for non-PKCS#7 data", function () {
    expect(extractPkcs7Metadata(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
  });

  it("returns null when given a non-Uint8Array", function () {
    // eslint-disable-next-line unicorn/no-null
    expect(extractPkcs7Metadata(null)).toBeNull();
    expect(extractPkcs7Metadata("not bytes")).toBeNull();
  });

  it("extracts subject DN and signingTime from a real PKCS#7 blob", function () {
    const bytes = base64ToBytes(FIXTURE_BASE64);
    const meta = extractPkcs7Metadata(bytes);
    expect(meta).not.toBeNull();

    expect(meta.subject).toEqual(
      jasmine.objectContaining({
        commonName: "Alice Architect",
        givenName: "Alice",
        surname: "Architect",
        organization: "ATReal",
        emailAddress: "alice@example.org",
        country: "FR",
      })
    );

    // signingTime is "D:20260508233911Z" in the fixture; the parser
    // returns ISO 8601.
    expect(meta.signingTime).toEqual("2026-05-08T23:39:11Z");
  });
});
