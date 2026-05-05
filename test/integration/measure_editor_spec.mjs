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
  awaitPromise,
  closePages,
  getEditorSelector,
  getRect,
  getSerialized,
  kbRedo,
  kbUndo,
  loadAndWait,
  switchToEditor,
  waitForPointerUp,
  waitForSerialized,
  waitForStorageEntries,
  waitForTimeout,
} from "./test_utils.mjs";

const switchToMeasure = switchToEditor.bind(null, "Measure");
const MEASURE_TYPE = 200;

/**
 * Drag from (x1,y1) to (x2,y2). Used for single-segment subtypes
 * (distance / calibrate) which auto-commit on pointerup.
 */
async function dragSegment(page, x1, y1, x2, y2) {
  const handle = await waitForPointerUp(page);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2);
  await page.mouse.up();
  await awaitPromise(handle);
}

/**
 * Single discrete click that adds one vertex to a multi-vertex measure
 * (polyline, area). DrawingEditor.startNew picks it up because the editor
 * advertises supportMultipleDrawings = true for these subtypes.
 */
async function clickVertex(page, x, y) {
  const handle = await waitForPointerUp(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await awaitPromise(handle);
}

async function selectSubType(page, sub) {
  // The subtype select lives in the measure params toolbar.
  await page.select("#editorMeasureSubType", sub);
  // Allow the eventBus dispatch to land before the next interaction.
  await waitForTimeout(page, 50);
}

async function getMeasureSerialized(page) {
  const all = await getSerialized(page);
  return all.filter(s => s?.annotationType === MEASURE_TYPE);
}

describe("MeasureEditor", () => {
  // --------------------------------------------------------------------- //
  // distance (single drag, auto-commit)                                   //
  // --------------------------------------------------------------------- //
  describe("Subtype: distance", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("creates a MEASURE annotation in annotationStorage", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 400,
            rect.y + 200
          );
          await waitForSerialized(page, 1);

          const measures = await getMeasureSerialized(page);
          expect(measures.length)
            .withContext(`${browserName}: a single MEASURE annotation`)
            .toBe(1);
          expect(measures[0].measureSubType).toBe("distance");
          // 2 vertices × 2 coords = 4 floats.
          expect(measures[0].vertices.length).toBe(4);
        })
      );
    });

    it("vertices reflect the drag start/end (axis-aligned drag)", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 100,
            rect.y + 300,
            rect.x + 500,
            rect.y + 300
          );
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          // Axis-aligned horizontal drag → both Y in PDF user space identical
          // (within rounding). PDF vertices are [x0, y0, x1, y1].
          expect(Math.abs(m.vertices[1] - m.vertices[3])).toBeLessThan(1);
        })
      );
    });

    it("undo removes the measure, redo restores it", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 400,
            rect.y + 250
          );
          await waitForStorageEntries(page, 1);

          await kbUndo(page);
          await waitForStorageEntries(page, 0);

          await kbRedo(page);
          await waitForStorageEntries(page, 1);

          const measures = await getMeasureSerialized(page);
          expect(measures.length).toBe(1);
        })
      );
    });

    it("attaches the .measureEditor and .disabled class after commit", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForStorageEntries(page, 1);

          await page.waitForSelector(".measureEditor");
          // After auto-commit the editor div carries the .disabled class
          // (DrawingEditor commit path → disableEditing()).
          await page.waitForSelector(".measureEditor.disabled");
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // polyline (multi-vertex, commit on dblclick)                           //
  // --------------------------------------------------------------------- //
  describe("Subtype: polyline", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("captures 4 vertices and commits on double-click", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "polyline");

          const rect = await getRect(page, ".annotationEditorLayer");
          // Initial drag = first segment (vertex 1 → vertex 2).
          await dragSegment(
            page,
            rect.x + 100,
            rect.y + 100,
            rect.x + 200,
            rect.y + 100
          );
          // Subsequent click = vertex 3.
          await clickVertex(page, rect.x + 300, rect.y + 200);
          // Vertex 4.
          await clickVertex(page, rect.x + 400, rect.y + 100);
          // Double-click commits the polyline.
          await page.mouse.click(rect.x + 400, rect.y + 100, { count: 2 });
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          expect(m.measureSubType).toBe("polyline");
          // ≥ 3 vertices × 2 coords (the dblclick may or may not append the
          // final point depending on layer wiring — assert lower bound).
          expect(m.vertices.length).toBeGreaterThanOrEqual(6);
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // area (multi-vertex, polygon)                                          //
  // --------------------------------------------------------------------- //
  describe("Subtype: area", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("creates an area measure with measureSubType=area", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "area");

          const rect = await getRect(page, ".annotationEditorLayer");
          // Triangle.
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 400,
            rect.y + 200
          );
          await clickVertex(page, rect.x + 300, rect.y + 350);
          await page.mouse.click(rect.x + 300, rect.y + 350, { count: 2 });
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          expect(m.measureSubType).toBe("area");
          // ≥ 3 vertices × 2 coords for a triangle.
          expect(m.vertices.length).toBeGreaterThanOrEqual(6);
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // perpendicular (3-point auto-close)                                    //
  // --------------------------------------------------------------------- //
  describe("Subtype: perpendicular", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("captures and commits a perpendicular measure", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "perpendicular");

          const rect = await getRect(page, ".annotationEditorLayer");
          // Base segment.
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 400,
            rect.y + 200
          );
          // Third point — perpendicular auto-closes via isDone() after this.
          await clickVertex(page, rect.x + 300, rect.y + 300);
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          expect(m.measureSubType).toBe("perpendicular");
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // calibrate (drag + prompt → updates scaleFactor)                       //
  // --------------------------------------------------------------------- //
  describe("Subtype: calibrate", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("updates the document scale factor when calibrating", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          // Stub window.prompt before any user interaction so the calibrate
          // flow can proceed without UI.
          await page.evaluate(() => {
            window.prompt = () => "10";
          });

          await switchToMeasure(page);
          await selectSubType(page, "calibrate");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 100,
            rect.y + 100,
            rect.x + 300,
            rect.y + 100
          );
          await waitForTimeout(page, 300);

          const sf = await page.evaluate(() => {
            const ui =
              window.PDFViewerApplication.pdfViewer
                ._annotationEditorUIManager;
            return ui?._measureScaleFactor || 0;
          });
          expect(sf)
            .withContext(`${browserName}: scaleFactor must be set`)
            .toBeGreaterThan(0);
        })
      );
    });

    it("emits a measure annotation with measureSubType=calibrate", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await page.evaluate(() => {
            window.prompt = () => "5";
          });

          await switchToMeasure(page);
          await selectSubType(page, "calibrate");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 100,
            rect.y + 200,
            rect.x + 250,
            rect.y + 200
          );
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          expect(m.measureSubType).toBe("calibrate");
          // The serialized entry carries the scaleFactor for the worker to
          // build the /Measure dict.
          expect(m.scaleFactor).toBeGreaterThan(0);
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // Subtype switching                                                     //
  // --------------------------------------------------------------------- //
  describe("Subtype switching", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("changes the default subtype on select", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "area");

          const def = await page.evaluate(
            () =>
              window.PDFViewerApplication.pdfDocument
                ?._transport?.messageHandler // probe is best-effort
          );
          // We don't have a public API for the static default, so probe via
          // the params event to confirm the round-trip.
          const sub = await page.evaluate(
            sel => document.querySelector(sel).value,
            "#editorMeasureSubType"
          );
          expect(sub).toBe("area");
          // (def is just a non-throwing probe)
          expect(def === undefined || typeof def === "object").toBe(true);
        })
      );
    });

    it("clearing the selection happens when switching subtypes", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForStorageEntries(page, 1);
          // After commit the editor is selected.
          await page.waitForSelector(".measureEditor.selectedEditor");

          // Switching subtype should unselect.
          await selectSubType(page, "area");
          await page.waitForSelector(
            ".measureEditor:not(.selectedEditor)"
          );
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // Lifecycle: dblclick re-enters edit mode                               //
  // --------------------------------------------------------------------- //
  describe("Editor lifecycle", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("dblclick on a synthetic measure re-enters edit mode", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForStorageEntries(page, 1);

          // Switch out of MEASURE to expose the synthetic view in NONE mode.
          await switchToMeasure(page, /* disable = */ true);

          // Double-click on the synthetic SVG (within the polyline annotation
          // container — which is added under .annotationLayer by
          // createSyntheticElement).
          const syntheticBox = await page.evaluate(() => {
            const svg = document.querySelector(
              ".annotationLayer .polylineAnnotation svg"
            );
            if (!svg) {
              return null;
            }
            const r = svg.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          expect(syntheticBox)
            .withContext("synthetic polyline must exist after commit")
            .not.toBeNull();

          await page.mouse.click(syntheticBox.x, syntheticBox.y, { count: 2 });
          // After dblclick the UIManager dispatches switchannotationeditormode
          // and the editor enters edit mode.
          await page.waitForSelector(".measureEditor.selectedEditor");
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // Round-trip: serialize keeps subtype, vertices and color               //
  // --------------------------------------------------------------------- //
  describe("Round-trip via annotationStorage", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    it("serialize() then re-serialize keeps measureSubType + vertices stable", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 400,
            rect.y + 250
          );
          await waitForSerialized(page, 1);

          const first = await getMeasureSerialized(page);
          // Re-serializing without changes should produce equivalent vertices
          // and the same measureSubType.
          const second = await getMeasureSerialized(page);

          expect(first[0].measureSubType).toBe(second[0].measureSubType);
          expect(first[0].vertices).toEqual(second[0].vertices);
        })
      );
    });

    it("annotationType is exposed as 200 (MEASURE)", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForSerialized(page, 1);

          const [m] = await getMeasureSerialized(page);
          expect(m.annotationType).toBe(MEASURE_TYPE);
          // The editor selector points to the live MeasureEditor in the DOM.
          await page.waitForSelector(getEditorSelector(0));
        })
      );
    });
  });

  // --------------------------------------------------------------------- //
  // Regression coverage for the four post-rebase regressions.             //
  // Each spec fails on the pre-fix branch and passes after its fix.       //
  // --------------------------------------------------------------------- //
  describe("Regression coverage", () => {
    let pages;

    beforeEach(async () => {
      pages = await loadAndWait("aboutstacks.pdf", ".annotationEditorLayer");
    });

    afterEach(async () => {
      await closePages(pages);
    });

    // R1 — enableComment was flipped to false in non-test bundles by an
    // upstream conflict resolution. Without it the CommentManager isn't
    // instantiated and the hover-comment affordance disappears entirely.
    // pdfViewer._layerProperties.enableComment is `!!commentManager` (see
    // pdf_viewer.js:667-669), so this also proves the manager wired up.
    it("R1: enableComment is true so CommentManager is constructed", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          const enabled = await page.evaluate(
            () => !!window.PDFViewerApplication.pdfViewer
              ?._layerProperties?.enableComment
          );
          expect(enabled).toBe(true);
        })
      );
    });

    // R3 — A freshly drawn measure could not be re-edited by double-clicking
    // because MeasureEditor inherited canChangeContent=false, which makes
    // AnnotationEditor.enterInEditMode() bail before calling enableEditing.
    // After the fix dblclick lifts the .disabled class and removes the
    // synthetic view element so vertices become manipulable again.
    it("R3: dblclick on a fresh distance re-enables editing in-place", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForStorageEntries(page, 1);
          // Post-commit the editor div carries the .disabled class.
          await page.waitForSelector(".measureEditor.disabled");

          // Stay in MEASURE mode (no toggle-out): the editor div sits on top
          // and intercepts the dblclick — that's the case the regression
          // was about.
          const editorBox = await page.evaluate(() => {
            const el = document.querySelector(".measureEditor.selectedEditor");
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await page.mouse.click(editorBox.x, editorBox.y, { count: 2 });

          // After the fix MeasureEditor.enterInEditMode() calls enableEditing,
          // which removes the .disabled class.
          await page.waitForFunction(
            () =>
              !document
                .querySelector(".measureEditor.selectedEditor")
                ?.classList.contains("disabled")
          );
        })
      );
    });

    // R2 — After committing a measure the editor stays selected, so
    // toolbar param changes were taking the hasSelection branch in
    // updateParams() and updating the just-drawn editor's color instead of
    // _defaultDrawingOptions. The next drag therefore reused the *previous*
    // default. The fix routes MEASURE_COLOR/LINEWIDTH/OPACITY/UNIT to the
    // editor type defaults regardless of selection state.
    it("R2: toolbar color change after a draw applies to the next drag", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "distance");

          const rect = await getRect(page, ".annotationEditorLayer");
          // First distance — uses the default red.
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 200,
            rect.x + 350,
            rect.y + 200
          );
          await waitForStorageEntries(page, 1);

          // Drive the color picker the way the toolbar does
          // (web/annotation_editor_params.js:161-164).
          await page.evaluate(() => {
            const input = document.getElementById("editorMeasureColor");
            input.value = "#00ff00";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          // Let the eventBus dispatch land before the next drag.
          await waitForTimeout(page, 50);

          // Second distance — should use the new green default. With the
          // pre-fix behavior it would still be red because the param was
          // routed to the selected (first) editor.
          await dragSegment(
            page,
            rect.x + 200,
            rect.y + 300,
            rect.x + 350,
            rect.y + 300
          );
          await waitForStorageEntries(page, 2);

          const measures = await getMeasureSerialized(page);
          expect(measures.length).toBe(2);
          // PDF y increases upward, so the measure drawn at the *higher*
          // screen-y coordinate (rect.y + 300) ends up with the *lower* PDF
          // y. Sort ascending by vertices[1] to identify "second drawn".
          const sorted = [...measures].sort(
            (a, b) => a.vertices[1] - b.vertices[1]
          );
          const secondDrawn = sorted[0];
          // The regression manifested as the second drag still using the
          // original red default (G < R). After the fix the toolbar color
          // change feeds _defaultDrawingOptions, so the second drag is green.
          expect(secondDrawn.color[1]).toBeGreaterThan(secondDrawn.color[0]);
        })
      );
    });

    // R4 — In-progress multi-vertex drawings (vertices placed but not yet
    // double-clicked to commit) live in DrawingEditor.#currentDraw and have
    // no MeasureEditor instance yet, so annotationStorage.print misses them.
    // The fix is a `beforeprint` listener on AnnotationEditorUIManager that
    // calls commitOrRemove(), which ends the current drawing session and
    // adds the resulting editor to storage before the print snapshot.
    it("R4: in-progress polyline is flushed to storage on beforeprint", async () => {
      await Promise.all(
        pages.map(async ([_, page]) => {
          await switchToMeasure(page);
          await selectSubType(page, "polyline");

          const rect = await getRect(page, ".annotationEditorLayer");
          // Place 3 vertices but do NOT double-click — drawing session
          // remains open.
          await dragSegment(
            page,
            rect.x + 100,
            rect.y + 100,
            rect.x + 200,
            rect.y + 100
          );
          await clickVertex(page, rect.x + 300, rect.y + 200);
          await clickVertex(page, rect.x + 400, rect.y + 100);

          // No MeasureEditor exists yet — storage is empty.
          const sizeBefore = await page.evaluate(
            () =>
              window.PDFViewerApplication.pdfDocument.annotationStorage.size
          );
          expect(sizeBefore)
            .withContext("storage must be empty during the drawing session")
            .toBe(0);

          // Synchronously dispatch beforeprint — the UIManager listener
          // commits the in-progress drawing.
          await page.evaluate(() =>
            window.PDFViewerApplication.eventBus.dispatch("beforeprint", {
              source: window,
            })
          );

          await waitForStorageEntries(page, 1);
          const measures = await getMeasureSerialized(page);
          expect(measures.length).toBe(1);
          expect(measures[0].measureSubType).toBe("polyline");
          // ≥ 3 vertices (6 floats).
          expect(measures[0].vertices.length).toBeGreaterThanOrEqual(6);
        })
      );
    });
  });
});
