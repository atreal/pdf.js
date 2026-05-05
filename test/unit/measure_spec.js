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
  AnnotationEditorParamsType,
  AnnotationEditorType,
  MeasureSubType,
} from "../../src/shared/util.js";

/**
 * Sentinel tests for the MeasureEditor public surface (enums + identifiers).
 *
 * Goal: catch any upstream rebase that drops or renumbers our extension
 * constants. The full behaviour of MeasureEditor is exercised by the
 * integration tests in `test/integration/measure_editor_spec.mjs`.
 */
describe("MeasureEditor enums", function () {
  describe("AnnotationEditorType.MEASURE", function () {
    it("is the dedicated 200 slot", function () {
      expect(AnnotationEditorType.MEASURE).toBe(200);
    });

    it("does not collide with any other editor type", function () {
      const values = Object.values(AnnotationEditorType);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it("comes after the SIGNATURE / COMMENT slots (101 / 102)", function () {
      expect(AnnotationEditorType.MEASURE).toBeGreaterThan(
        AnnotationEditorType.SIGNATURE
      );
      expect(AnnotationEditorType.MEASURE).toBeGreaterThan(
        AnnotationEditorType.COMMENT
      );
    });
  });

  describe("MeasureSubType", function () {
    it("exposes the five expected subtypes as string identifiers", function () {
      expect(MeasureSubType).toEqual({
        DISTANCE: "distance",
        POLYLINE: "polyline",
        AREA: "area",
        PERPENDICULAR: "perpendicular",
        CALIBRATE: "calibrate",
      });
    });

    it("uses string values (consumed by /Subj pdfjs-measure-{subtype})", function () {
      for (const v of Object.values(MeasureSubType)) {
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      }
    });
  });

  describe("AnnotationEditorParamsType — measure params", function () {
    it("reserves 51-56 for measure params", function () {
      expect(AnnotationEditorParamsType.MEASURE_SUBTYPE).toBe(51);
      expect(AnnotationEditorParamsType.MEASURE_COLOR).toBe(52);
      expect(AnnotationEditorParamsType.MEASURE_OPACITY).toBe(53);
      expect(AnnotationEditorParamsType.MEASURE_LINEWIDTH).toBe(54);
      expect(AnnotationEditorParamsType.MEASURE_DASH).toBe(55);
      expect(AnnotationEditorParamsType.MEASURE_UNIT).toBe(56);
    });

    it("does not collide with existing param ids", function () {
      const allParams = Object.entries(AnnotationEditorParamsType).filter(
        ([k]) => k !== "RESIZE" && k !== "CREATE"
      );
      const ids = allParams.map(([, v]) => v);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });
  });
});
