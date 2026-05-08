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
  AnnotationType,
  MeasureSubType,
  shadow,
  Util,
} from "../../shared/util.js";
import { DrawingEditor, DrawingOptions } from "./draw.js";
import { InkDrawOutline } from "./drawers/inkdraw.js";
import { AnnotationEditor } from "./editor.js";
import { BasicColorPicker } from "./color_picker.js";
import { Outline } from "./drawers/outline.js";
import { PolylineAnnotationElement } from "../annotation_layer.js";

/**
 * Show a modal HTML dialog asking for the real-world distance during a
 * calibration. Returns the parsed positive number, or null if the user
 * cancelled / entered an invalid value.
 *
 * Uses a custom <dialog> instead of `window.prompt` because the latter is
 * synchronous and blocks the JS thread — combined with how some browsers
 * deliver post-validation pointer events, that causes ghost re-opens of
 * the prompt.
 */
function promptCalibrationDistance(measuredMm, currentValue = "1") {
  return new Promise(resolve => {
    let dialog = document.getElementById("pdfjsMeasureCalibrateDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "pdfjsMeasureCalibrateDialog";
      dialog.innerHTML = `
        <form method="dialog" style="display:flex;flex-direction:column;gap:12px;min-width:320px;font:13px system-ui,sans-serif;">
          <h2 style="margin:0;font-size:14px;font-weight:600;">Étalonnage de l'échelle</h2>
          <p data-hint style="margin:0;padding:6px 8px;background:#f0f4ff;border-radius:4px;font-size:12px;color:#333;"></p>
          <label style="display:flex;flex-direction:column;gap:6px;">
            Distance réelle de la cote tracée (en mètres) :
            <input type="number" min="0" step="any" required style="padding:6px 8px;border:1px solid #999;border-radius:4px;font:inherit;" />
          </label>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button type="button" data-action="cancel" style="padding:6px 12px;border:1px solid #999;background:#f5f5f5;border-radius:4px;cursor:pointer;">Annuler</button>
            <button type="submit" data-action="ok" style="padding:6px 12px;border:1px solid #0a558c;background:#0a558c;color:#fff;border-radius:4px;cursor:pointer;">Valider</button>
          </div>
        </form>
      `;
      document.body.append(dialog);
    }
    const hintEl = dialog.querySelector("[data-hint]");
    if (hintEl) {
      hintEl.textContent = `Longueur mesurée sur le plan : ${measuredMm.toFixed(2)} mm`;
    }
    const input = dialog.querySelector("input");
    const cancelBtn = dialog.querySelector('[data-action="cancel"]');
    const form = dialog.querySelector("form");

    input.value = currentValue;

    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
    };
    const finish = result => {
      cleanup();
      if (dialog.open) {
        dialog.close();
      }
      resolve(result);
    };
    const onSubmit = e => {
      e.preventDefault();
      const v = parseFloat(input.value);
      finish(isFinite(v) && v > 0 ? v : null);
    };
    const onCancel = () => finish(null);
    const onClose = () => finish(null);

    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);

    dialog.showModal();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

function buildInkLineFromVertices(vertices) {
  // Build an InkDrawOutline-compatible "line" array from a flat list of
  // vertices [x0,y0,x1,y1,...]. Each segment is encoded as a cubic Bézier
  // with control points placed exactly 1/3 and 2/3 along the chord — that
  // makes the curve mathematically identical to a straight segment, while
  // keeping the data structure InkDrawOutline expects (so bbox/resize/
  // serialize/deserialize all work unchanged).
  const n = vertices.length / 2;
  if (n < 1) {
    return new Float32Array(0);
  }
  if (n === 1) {
    return new Float32Array([NaN, NaN, NaN, NaN, vertices[0], vertices[1]]);
  }
  if (n === 2) {
    // Special length-12 form with NaN controls → toSVGPath emits L (line),
    // not C (curve). This is the path used for distance/perpendicular base.
    return new Float32Array([
      NaN, NaN, NaN, NaN, vertices[0], vertices[1],
      NaN, NaN, NaN, NaN, vertices[2], vertices[3],
    ]);
  }
  const line = new Float32Array(6 * n);
  line[0] = line[1] = line[2] = line[3] = NaN;
  line[4] = vertices[0];
  line[5] = vertices[1];
  for (let i = 1; i < n; i++) {
    const px = vertices[(i - 1) * 2];
    const py = vertices[(i - 1) * 2 + 1];
    const cx = vertices[i * 2];
    const cy = vertices[i * 2 + 1];
    const dx = cx - px;
    const dy = cy - py;
    const off = 6 * i;
    line[off] = px + dx / 3;
    line[off + 1] = py + dy / 3;
    line[off + 2] = px + (2 * dx) / 3;
    line[off + 3] = py + (2 * dy) / 3;
    line[off + 4] = cx;
    line[off + 5] = cy;
  }
  return line;
}

/**
 * Drawer for a single straight segment between two points (distance,
 * perpendicular, calibrate).
 */
class MeasureLineOutliner {
  #parentWidth;

  #parentHeight;

  #rotation;

  #thickness;

  #startX;

  #startY;

  #endX;

  #endY;

  constructor(x, y, parentWidth, parentHeight, rotation, thickness) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    this.#thickness = thickness;

    [x, y] = Outline._normalizePoint(
      x,
      y,
      parentWidth,
      parentHeight,
      rotation
    );
    this.#startX = this.#endX = x;
    this.#startY = this.#endY = y;
  }

  isEmpty() {
    return this.#startX === this.#endX && this.#startY === this.#endY;
  }

  isCancellable() {
    return this.isEmpty();
  }

  updateProperty(name, value) {
    if (name === "stroke-width") {
      this.#thickness = value;
    }
  }

  add(x, y) {
    [x, y] = Outline._normalizePoint(
      x,
      y,
      this.#parentWidth,
      this.#parentHeight,
      this.#rotation
    );
    this.#endX = x;
    this.#endY = y;
    return { path: { d: this.#toSVGPath() } };
  }

  end(x, y) {
    return this.add(x, y);
  }

  startNew(x, y, parentWidth, parentHeight, rotation) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    [x, y] = Outline._normalizePoint(
      x,
      y,
      parentWidth,
      parentHeight,
      rotation
    );
    this.#startX = this.#endX = x;
    this.#startY = this.#endY = y;
    return { path: { d: this.#toSVGPath() } };
  }

  getLastElement() {
    return null;
  }

  setLastElement() {
    return { path: { d: this.#toSVGPath() } };
  }

  removeLastElement() {
    this.#endX = this.#startX;
    this.#endY = this.#startY;
    return { path: { d: this.#toSVGPath() } };
  }

  #toSVGPath() {
    const sx = Outline.svgRound(this.#startX);
    const sy = Outline.svgRound(this.#startY);
    const ex = Outline.svgRound(this.#endX);
    const ey = Outline.svgRound(this.#endY);
    if (sx === ex && sy === ey) {
      return `M ${sx} ${sy} Z`;
    }
    return `M ${sx} ${sy} L ${ex} ${ey}`;
  }

  getOutlines(parentWidth, parentHeight, scale, innerMargin) {
    const points = new Float32Array([
      this.#startX,
      this.#startY,
      this.#endX,
      this.#endY,
    ]);
    const line = new Float32Array([
      NaN, NaN, NaN, NaN,
      this.#startX,
      this.#startY,
      NaN, NaN, NaN, NaN,
      this.#endX,
      this.#endY,
    ]);
    const outline = new InkDrawOutline();
    outline.build(
      [{ line, points }],
      parentWidth,
      parentHeight,
      scale,
      this.#rotation,
      this.#thickness,
      innerMargin
    );
    return outline;
  }

  get defaultSVGProperties() {
    return {
      root: { viewBox: "0 0 10000 10000" },
      rootClass: { draw: true },
      bbox: [0, 0, 1, 1],
    };
  }
}

/**
 * Drawer for multi-vertex polylines and polygons (polyline, area).
 *
 * Confirmed vertices accumulate in `#vertices`; the live preview endpoint
 * (`#endX, #endY`) tracks the cursor. A new pointerdown (via DrawingEditor's
 * `supportMultipleDrawings = true` mechanism that calls `startNew`) confirms
 * the live endpoint as a vertex and starts a new live segment from there.
 *
 * The double-click handler in `AnnotationEditorLayer` calls
 * `endDrawingSession` to commit.
 */
class MeasurePolylineOutliner {
  #parentWidth;

  #parentHeight;

  #rotation;

  #thickness;

  #vertices = []; // flat [x0,y0,x1,y1,...] in normalized coords

  #endX;

  #endY;

  #closed;

  constructor(
    x,
    y,
    parentWidth,
    parentHeight,
    rotation,
    thickness,
    closed = false
  ) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    this.#thickness = thickness;
    this.#closed = closed;

    [x, y] = Outline._normalizePoint(
      x,
      y,
      parentWidth,
      parentHeight,
      rotation
    );
    this.#vertices.push(x, y);
    this.#endX = x;
    this.#endY = y;
  }

  isEmpty() {
    if (this.#vertices.length < 2) {
      return true;
    }
    if (this.#vertices.length === 2) {
      return (
        this.#vertices[0] === this.#endX && this.#vertices[1] === this.#endY
      );
    }
    return false;
  }

  isCancellable() {
    return this.#vertices.length <= 2;
  }

  updateProperty(name, value) {
    if (name === "stroke-width") {
      this.#thickness = value;
    }
  }

  add(x, y) {
    [x, y] = Outline._normalizePoint(
      x,
      y,
      this.#parentWidth,
      this.#parentHeight,
      this.#rotation
    );
    this.#endX = x;
    this.#endY = y;
    return { path: { d: this.#toSVGPath() } };
  }

  end(x, y) {
    return this.add(x, y);
  }

  startNew(x, y, parentWidth, parentHeight, rotation) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    // Confirm the live preview endpoint as a vertex.
    this.#vertices.push(this.#endX, this.#endY);
    [x, y] = Outline._normalizePoint(
      x,
      y,
      parentWidth,
      parentHeight,
      rotation
    );
    this.#endX = x;
    this.#endY = y;
    return { path: { d: this.#toSVGPath() } };
  }

  getLastElement() {
    return {
      vertices: this.#vertices.slice(),
      endX: this.#endX,
      endY: this.#endY,
    };
  }

  setLastElement(element) {
    this.#vertices = element.vertices.slice();
    this.#endX = element.endX;
    this.#endY = element.endY;
    return { path: { d: this.#toSVGPath() } };
  }

  removeLastElement() {
    if (this.#vertices.length >= 4) {
      const last = this.#vertices.length - 2;
      this.#endX = this.#vertices[last];
      this.#endY = this.#vertices[last + 1];
      this.#vertices.length = last;
    }
    return { path: { d: this.#toSVGPath() } };
  }

  #toSVGPath() {
    const buf = [];
    for (let i = 0, ii = this.#vertices.length; i < ii; i += 2) {
      const cmd = i === 0 ? "M" : "L";
      buf.push(
        `${cmd} ${Outline.svgRound(this.#vertices[i])} ${Outline.svgRound(this.#vertices[i + 1])}`
      );
    }
    buf.push(
      `L ${Outline.svgRound(this.#endX)} ${Outline.svgRound(this.#endY)}`
    );
    if (this.#closed) {
      buf.push("Z");
    }
    return buf.join(" ");
  }

  getOutlines(parentWidth, parentHeight, scale, innerMargin) {
    // Confirm the live endpoint as the final vertex (deduplicate if it
    // already coincides with the last confirmed vertex).
    const lastIdx = this.#vertices.length;
    const sameAsLast =
      lastIdx >= 2 &&
      this.#vertices[lastIdx - 2] === this.#endX &&
      this.#vertices[lastIdx - 1] === this.#endY;
    const allVerts = sameAsLast
      ? this.#vertices.slice()
      : [...this.#vertices, this.#endX, this.#endY];

    if (this.#closed && allVerts.length >= 4) {
      // Close by appending the first vertex again so the appearance stream
      // has an explicit closing edge.
      const firstSame =
        allVerts[allVerts.length - 2] === allVerts[0] &&
        allVerts[allVerts.length - 1] === allVerts[1];
      if (!firstSame) {
        allVerts.push(allVerts[0], allVerts[1]);
      }
    }

    const points = new Float32Array(allVerts);
    const line = buildInkLineFromVertices(allVerts);
    const outline = new InkDrawOutline();
    outline.build(
      [{ line, points }],
      parentWidth,
      parentHeight,
      scale,
      this.#rotation,
      this.#thickness,
      innerMargin
    );
    return outline;
  }

  get defaultSVGProperties() {
    return {
      root: { viewBox: "0 0 10000 10000" },
      rootClass: { draw: true },
      bbox: [0, 0, 1, 1],
    };
  }
}

/**
 * Drawer for the perpendicular subtype: 3 clicks.
 *   click 1 → start of the base
 *   click 2 → end of the base (defines the reference axis)
 *   click 3 → projects onto the base, the perpendicular runs from the foot
 *             to the cursor
 *
 * Final stored vertices: [v0, v1, foot, P]. The two-segment polyline gives a
 * native PDF representation (PolyLine annotation) that any reader can render.
 * The label only measures the perpendicular leg (foot → P), since that's
 * what "right-angle measurement" means.
 */
class MeasurePerpendicularOutliner {
  #parentWidth;

  #parentHeight;

  #rotation;

  #thickness;

  // Phase 0: base in progress (click 1 → click 2 release).
  // Phase 1: base committed, perpendicular in preview (after click 2 release).
  // Phase 2: perpendicular committed (after click 3 release) → done.
  #phase = 0;

  #v0x = 0;

  #v0y = 0;

  #v1x = 0;

  #v1y = 0;

  // Live preview endpoint (updated on pointermove).
  #endX = 0;

  #endY = 0;

  // Computed projection foot when in phase 1+.
  #footX = 0;

  #footY = 0;

  constructor(x, y, parentWidth, parentHeight, rotation, thickness) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    this.#thickness = thickness;

    [x, y] = Outline._normalizePoint(x, y, parentWidth, parentHeight, rotation);
    this.#v0x = this.#v1x = this.#endX = x;
    this.#v0y = this.#v1y = this.#endY = y;
  }

  isEmpty() {
    if (this.#phase === 0) {
      return this.#v0x === this.#endX && this.#v0y === this.#endY;
    }
    return false;
  }

  isCancellable() {
    return this.#phase === 0;
  }

  isDone() {
    return this.#phase === 2;
  }

  updateProperty(name, value) {
    if (name === "stroke-width") {
      this.#thickness = value;
    }
  }

  #projectOnBase(x, y) {
    // Work in physical (pixel) space so the dot-product is Euclidean.
    // Normalized coords (0-1) are non-square on non-square pages, which
    // would make a geometrically perpendicular vector appear skewed.
    const pw = this.#parentWidth;
    const ph = this.#parentHeight;
    const ax = this.#v0x * pw;
    const ay = this.#v0y * ph;
    const bx = this.#v1x * pw;
    const by = this.#v1y * ph;
    const px = x * pw;
    const py = y * ph;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      return [this.#v0x, this.#v0y];
    }
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    return [(ax + t * dx) / pw, (ay + t * dy) / ph];
  }

  add(x, y) {
    [x, y] = Outline._normalizePoint(
      x,
      y,
      this.#parentWidth,
      this.#parentHeight,
      this.#rotation
    );
    this.#endX = x;
    this.#endY = y;
    if (this.#phase >= 1) {
      [this.#footX, this.#footY] = this.#projectOnBase(x, y);
    } else {
      this.#v1x = x;
      this.#v1y = y;
    }
    return { path: { d: this.#toSVGPath() } };
  }

  end(x, y) {
    if (this.#phase === 1) {
      // Click 3 release → close the session.
      this.#phase = 2;
    }
    return this.add(x, y);
  }

  startNew(x, y, parentWidth, parentHeight, rotation) {
    this.#parentWidth = parentWidth;
    this.#parentHeight = parentHeight;
    this.#rotation = rotation;
    [x, y] = Outline._normalizePoint(x, y, parentWidth, parentHeight, rotation);
    if (this.#phase === 0) {
      // Click 2 → confirm the base.
      this.#v1x = this.#endX;
      this.#v1y = this.#endY;
      this.#phase = 1;
      this.#endX = x;
      this.#endY = y;
      [this.#footX, this.#footY] = this.#projectOnBase(x, y);
    } else {
      // After phase 1, additional clicks just update the perpendicular target.
      this.#endX = x;
      this.#endY = y;
      [this.#footX, this.#footY] = this.#projectOnBase(x, y);
    }
    return { path: { d: this.#toSVGPath() } };
  }

  getLastElement() {
    return {
      phase: this.#phase,
      v0: [this.#v0x, this.#v0y],
      v1: [this.#v1x, this.#v1y],
      end: [this.#endX, this.#endY],
      foot: [this.#footX, this.#footY],
    };
  }

  setLastElement(element) {
    this.#phase = element.phase;
    [this.#v0x, this.#v0y] = element.v0;
    [this.#v1x, this.#v1y] = element.v1;
    [this.#endX, this.#endY] = element.end;
    [this.#footX, this.#footY] = element.foot;
    return { path: { d: this.#toSVGPath() } };
  }

  removeLastElement() {
    if (this.#phase >= 1) {
      this.#phase = 0;
      this.#endX = this.#v1x;
      this.#endY = this.#v1y;
    }
    return { path: { d: this.#toSVGPath() } };
  }

  #toSVGPath() {
    const r = Outline.svgRound;
    const v0 = `${r(this.#v0x)} ${r(this.#v0y)}`;
    const v1 = `${r(this.#v1x)} ${r(this.#v1y)}`;
    if (this.#phase === 0) {
      // Just the base segment.
      const ex = `${r(this.#endX)} ${r(this.#endY)}`;
      return `M ${v0} L ${ex}`;
    }
    const foot = `${r(this.#footX)} ${r(this.#footY)}`;
    const tip = `${r(this.#endX)} ${r(this.#endY)}`;
    // Base + perpendicular (drawn as a single 4-vertex polyline so it round-
    // trips through the worker's existing polyline appearance stream).
    return `M ${v0} L ${v1} M ${foot} L ${tip}`;
  }

  getOutlines(parentWidth, parentHeight, scale, innerMargin) {
    const verts = [
      this.#v0x,
      this.#v0y,
      this.#v1x,
      this.#v1y,
      this.#footX,
      this.#footY,
      this.#endX,
      this.#endY,
    ];
    const points = new Float32Array(verts);
    const line = buildInkLineFromVertices(verts);
    const outline = new InkDrawOutline();
    outline.build(
      [{ line, points }],
      parentWidth,
      parentHeight,
      scale,
      this.#rotation,
      this.#thickness,
      innerMargin
    );
    return outline;
  }

  get defaultSVGProperties() {
    return {
      root: { viewBox: "0 0 10000 10000" },
      rootClass: { draw: true },
      bbox: [0, 0, 1, 1],
    };
  }
}

class MeasureDrawingOptions extends DrawingOptions {
  constructor(viewerParameters) {
    super();
    this._viewParameters = viewerParameters;
    super.updateProperties({
      fill: "none",
      stroke: "#FF0000",
      "stroke-opacity": 1,
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-miterlimit": 10,
    });
  }

  updateSVGProperty(name, value) {
    if (name === "stroke-width") {
      value ??= this["stroke-width"];
      value *= this._viewParameters.realScale;
    }
    super.updateSVGProperty(name, value);
  }

  clone() {
    const clone = new MeasureDrawingOptions(this._viewParameters);
    clone.updateAll(this);
    return clone;
  }
}

/**
 * Editor for measurement annotations (distance, polyline, area, perpendicular,
 * calibrate).
 *
 * Extends DrawingEditor → inherits pointer pipeline, DrawLayer integration,
 * post-commit drag/resize/rotate, and round-trip through annotationStorage
 * (no manual commit() override needed).
 *
 * Subtype-specific behavior:
 * - distance, perpendicular, calibrate: single drag → straight L-segment.
 * - polyline, area: multi-segment via supportMultipleDrawings + dblclick to
 *   commit (handled in `AnnotationEditorLayer`).
 *
 * Persists as standard PDF PolyLine/Polygon with /IT *Dimension + /Measure
 * via `PolylineAnnotation.createNewMeasureAnnotation` on the worker side.
 */
class MeasureEditor extends DrawingEditor {
  static _type = "measure";

  static _editorType = AnnotationEditorType.MEASURE;

  static _defaultDrawingOptions = null;

  static _defaultMeasureSubType = MeasureSubType.DISTANCE;

  static _defaultScaleFactor = 1;

  static _defaultUnit = "m";

  // Off-DOM canvas reused across serialize() calls to measure the PDF
  // label width via real Helvetica/Arial metrics. Lazy-initialized.
  static #textMeasureCanvas = null;

  #measureSubType;

  #scaleFactor;

  #unit;

  constructor(params) {
    super({ ...params, name: "measureEditor" });
    this._willKeepAspectRatio = false;
    this.defaultL10nId = "pdfjs-editor-measure-editor";
    this.#measureSubType =
      params.measureSubType || MeasureEditor._defaultMeasureSubType;
    this.#scaleFactor =
      params.scaleFactor ?? MeasureEditor._defaultScaleFactor;
    this.#unit = params.unit || MeasureEditor._defaultUnit;
  }

  /**
   * Override the inherited `editorType` so the EditorUndoBar can pick a
   * subtype-specific message ("Mesure distance supprimée" vs the generic
   * "Mesure supprimée"). DrawingEditor's constructor calls `_addOutlines`
   * → `#createDrawOutlines` → reads `this.editorType` BEFORE our own
   * `super()` returns and our field initializers run. Reading the private
   * `#measureSubType` field on a partially-constructed instance throws a
   * TypeError, which would abort the whole DrawingEditor pipeline (the
   * symptom: "drawing no longer renders / commits"). Guard with try/catch
   * so the early call gets the parent's plain `"measure"` and the
   * subtype-aware label only kicks in after the constructor body has run.
   */
  get editorType() {
    try {
      const sub = this.#measureSubType;
      if (sub) {
        return `measure-${sub}`;
      }
    } catch {
      // Field not initialized yet (we're still inside super()); fall through.
    }
    return super.editorType;
  }

  /** @inheritdoc */
  static initialize(l10n, uiManager) {
    AnnotationEditor.initialize(l10n, uiManager);
    this._defaultDrawingOptions = new MeasureDrawingOptions(
      uiManager.viewParameters
    );
  }

  /** @inheritdoc */
  static getDefaultDrawingOptions(options) {
    const clone = this._defaultDrawingOptions.clone();
    clone.updateProperties(options);
    // Filled area preview: reuse the stroke color as fill with a softer
    // alpha. Worker mirrors this in the appearance stream so saved PDFs
    // render the same way.
    if (this._defaultMeasureSubType === MeasureSubType.AREA) {
      clone.updateProperties({
        fill: clone.stroke,
        "fill-opacity": 0.25,
      });
    }
    return clone;
  }

  /**
   * Reference to the most recently created drawer, kept so
   * `supportMultipleDrawings` can honour an outliner's `isDone()` flag (the
   * perpendicular subtype self-closes after its 3rd pointerup) WITHOUT
   * patching DrawingEditor in draw.js. The drawer transitions to "done" in
   * its `end(x,y)`, which DrawingEditor._endDraw calls before consulting
   * `supportMultipleDrawings`.
   */
  static #currentDrawerRef = null;

  /** @inheritdoc */
  static get supportMultipleDrawings() {
    const sub = this._defaultMeasureSubType;
    const baseSupport =
      sub === MeasureSubType.POLYLINE ||
      sub === MeasureSubType.AREA ||
      sub === MeasureSubType.PERPENDICULAR;
    if (!baseSupport) {
      return false;
    }
    // Perpendicular self-closes after its 3rd vertex via isDone().
    return MeasureEditor.#currentDrawerRef?.isDone?.() !== true;
  }

  /**
   * En mode sélection (aucun sous-type actif), on ne veut pas démarrer
   * un tracé — un pointerdown lance la sélection d'un éditeur existant.
   * @inheritdoc
   */
  static get isDrawer() {
    return !!MeasureEditor._defaultMeasureSubType;
  }

  /**
   * Custom flag consumed by AnnotationEditorLayer's dblclick listener to know
   * whether a double-click on the layer should commit the in-progress drawing
   * (true for polyline/area, false for single-segment subtypes — perpendicular
   * also closes via its own isDone() flag, not via dblclick).
   */
  static get endDrawingOnDoubleClick() {
    const sub = this._defaultMeasureSubType;
    return sub === MeasureSubType.POLYLINE || sub === MeasureSubType.AREA;
  }

  /** @inheritdoc */
  static get typesMap() {
    return shadow(
      this,
      "typesMap",
      new Map([
        [AnnotationEditorParamsType.MEASURE_LINEWIDTH, "stroke-width"],
        [AnnotationEditorParamsType.MEASURE_COLOR, "stroke"],
        [AnnotationEditorParamsType.MEASURE_OPACITY, "stroke-opacity"],
      ])
    );
  }

  /** @inheritdoc */
  static updateDefaultParams(type, value) {
    if (type === AnnotationEditorParamsType.MEASURE_SUBTYPE) {
      this._defaultMeasureSubType = value;
      return;
    }
    if (type === AnnotationEditorParamsType.MEASURE_UNIT) {
      this._defaultUnit = value;
      return;
    }
    super.updateDefaultParams(type, value);
  }

  /** @inheritdoc */
  static get defaultPropertiesToUpdate() {
    const props = super.defaultPropertiesToUpdate;
    props.push([
      AnnotationEditorParamsType.MEASURE_SUBTYPE,
      this._defaultMeasureSubType,
    ]);
    return props;
  }

  /**
   * Per-instance property bag dispatched on selection so the params
   * panel can reflect the editor's actual state. Inherits the
   * stroke/width/opacity entries from DrawingEditor and adds the
   * subtype so the toolbar's `MEASURE_SUBTYPE` listener can highlight
   * the matching button (Distance / Polyligne / Area / Perpendicular /
   * Calibrate) when the user double-clicks an existing measure.
   * @inheritdoc
   */
  get propertiesToUpdate() {
    const props = super.propertiesToUpdate;
    if (this.#measureSubType) {
      props.push([
        AnnotationEditorParamsType.MEASURE_SUBTYPE,
        this.#measureSubType,
      ]);
    }
    return props;
  }

  /** @inheritdoc */
  static createDrawerInstance(x, y, parentWidth, parentHeight, rotation) {
    const sub = this._defaultMeasureSubType;
    const thickness = this._defaultDrawingOptions["stroke-width"];
    let drawer;
    if (sub === MeasureSubType.POLYLINE) {
      drawer = new MeasurePolylineOutliner(
        x,
        y,
        parentWidth,
        parentHeight,
        rotation,
        thickness,
        /* closed = */ false
      );
    } else if (sub === MeasureSubType.AREA) {
      drawer = new MeasurePolylineOutliner(
        x,
        y,
        parentWidth,
        parentHeight,
        rotation,
        thickness,
        /* closed = */ true
      );
    } else if (sub === MeasureSubType.PERPENDICULAR) {
      drawer = new MeasurePerpendicularOutliner(
        x,
        y,
        parentWidth,
        parentHeight,
        rotation,
        thickness
      );
    } else {
      drawer = new MeasureLineOutliner(
        x,
        y,
        parentWidth,
        parentHeight,
        rotation,
        thickness
      );
    }
    MeasureEditor.#currentDrawerRef = drawer;
    return drawer;
  }

  /** @inheritdoc */
  static deserializeDraw(
    pageX,
    pageY,
    pageWidth,
    pageHeight,
    innerMargin,
    data
  ) {
    return InkDrawOutline.deserialize(
      pageX,
      pageY,
      pageWidth,
      pageHeight,
      innerMargin,
      data
    );
  }

  /** @inheritdoc */
  static async deserialize(data, parent, uiManager) {
    let initialData = null;
    if (data instanceof PolylineAnnotationElement) {
      const elementData = data.data || {};
      const {
        vertices,
        rect,
        rotation,
        id,
        color,
        opacity,
        borderStyle,
        measure,
        it: intent,
        popupRef,
        contentsObj,
        subj,
      } = elementData;
      const pageNumber = data.parent?.page?.pageNumber || 1;
      const thickness = borderStyle?.rawWidth || 1;

      if (!vertices || vertices.length < 4 || !rect) {
        return null;
      }

      const verticesArr =
        vertices instanceof Float32Array ? Array.from(vertices) : vertices;
      const verticesF32 = Float32Array.from(verticesArr);
      const points = [verticesF32];
      // We must provide a properly formatted `lines` — leaving it null makes
      // InkDrawOutline.deserialize rebuild it with cubic-Bézier smoothing
      // (Outline.createBezierPoints), which turns straight polyline measures
      // into wavy curves on reload.
      const lines = [buildInkLineFromVertices(verticesArr)];

      let measureSubType = MeasureSubType.DISTANCE;
      if (intent === "PolygonDimension") {
        measureSubType = MeasureSubType.AREA;
      } else if (intent === "PolyLineDimension") {
        measureSubType = MeasureSubType.POLYLINE;
      }
      // /Subj overrides intent for the special "calibrate" subtype, which
      // doesn't have a dedicated PDF /IT value (it's saved as LineDimension
      // for native viewer compatibility).
      if (typeof subj === "string" && subj.startsWith("pdfjs-measure-")) {
        const flagged = subj.slice("pdfjs-measure-".length);
        if (flagged === MeasureSubType.CALIBRATE) {
          measureSubType = MeasureSubType.CALIBRATE;
        } else if (flagged === MeasureSubType.PERPENDICULAR) {
          measureSubType = MeasureSubType.PERPENDICULAR;
        }
      }

      // /Contents may carry: just the measure label, just a user comment,
      // or both joined by "\n———\n". Strip the label so the editor only
      // remembers the actual user comment (the label is always recomputed
      // from vertices + scale).
      const rawContents = contentsObj?.str || null;
      let comment = null;
      if (rawContents) {
        const sep = "\n———\n";
        const idx = rawContents.indexOf(sep);
        if (idx !== -1) {
          comment = rawContents.slice(idx + sep.length);
        } else if (!/^[\d.,]+\s+[a-zA-Z]+²?$/.test(rawContents.trim())) {
          // No separator and not a bare label → assume the whole field is
          // the user comment.
          comment = rawContents;
        }
      }
      initialData = data = {
        annotationType: AnnotationEditorType.MEASURE,
        color: color ? Array.from(color) : [255, 0, 0],
        thickness,
        opacity: opacity ?? 1,
        paths: { points, lines },
        measureSubType,
        scaleFactor: measure?.scaleFactor || 1,
        unit: measure?.unit || "m",
        pageIndex: pageNumber - 1,
        rect: rect.slice(0),
        rotation: rotation || 0,
        annotationElementId: id,
        id,
        deleted: false,
        popupRef,
        comment,
        // Annotations saved before the always-/Popup fix lack a /Popup ref.
        // We flag them so they get re-serialized on the next save, which
        // restores the popup that Firefox's bundled pdf.js needs.
        needsPopupRewrite: !popupRef,
        // Persisted label offset in PDF points (X right, Y up — same
        // convention as PDF native coords). Defaults to [0, 0] when missing.
        labelOffsetPt: Array.isArray(elementData.labelOffset)
          ? [
              elementData.labelOffset[0] || 0,
              elementData.labelOffset[1] || 0,
            ]
          : [0, 0],
      };
    }

    const editor = await super.deserialize(data, parent, uiManager);
    editor._initialData = initialData;
    editor.#measureSubType = data.measureSubType || MeasureSubType.DISTANCE;
    editor.#scaleFactor = data.scaleFactor || 1;
    editor.#unit = data.unit || "m";
    if (data.needsPopupRewrite) {
      editor._needsPopupRewrite = true;
    }
    if (data.labelOffsetPt) {
      const [dxPt, dyPt] = data.labelOffsetPt;
      const [parentW] = editor.parentDimensions;
      const [pageW] = editor.pageDimensions;
      const scale = pageW > 0 ? parentW / pageW : 1;
      // PDF Y-up → CSS Y-down: flip dy.
      editor._setLabelOffsetPx({ x: dxPt * scale, y: -dyPt * scale });
    }
    if (data.comment) {
      // setCommentData destructures `{ comment, popupRef, richText }` and
      // bails when `popupRef` is missing — pass the full data object so
      // it picks up `popupRef` (set above from elementData), otherwise
      // the comment loads as text but isn't registered with the comment
      // manager and disappears from the comments sidebar on reload.
      editor.setCommentData(data);
    }
    // When loading a calibrate annotation, restore the document-wide scale so
    // freshly-traced measurements reuse it.
    if (
      editor.#measureSubType === MeasureSubType.CALIBRATE &&
      editor.#scaleFactor > 0 &&
      editor.#scaleFactor !== 1
    ) {
      MeasureEditor._defaultScaleFactor = editor.#scaleFactor;
      const ratioN = Math.round(editor.#scaleFactor / 0.000352777778);
      uiManager?._eventBus?.dispatch?.("measure-scale-calibrated", {
        source: editor,
        scaleFactor: editor.#scaleFactor,
        ratioN,
      });
    }
    return editor;
  }

  /** @inheritdoc */
  get toolbarButtons() {
    this._colorPicker ||= new BasicColorPicker(this);
    return [["colorPicker", this._colorPicker]];
  }

  get colorType() {
    return AnnotationEditorParamsType.MEASURE_COLOR;
  }

  get colorValue() {
    return this._drawingOptions.stroke;
  }

  /**
   * Area measures use the stroke color as a translucent fill (see
   * `getDefaultDrawingOptions`). When the user changes the color of an
   * existing area, the parent only repaints `stroke` so the inside
   * coloring stays on the previous hue. Re-apply the matching `fill` (with
   * the same softer alpha used at creation time) so the live SVG matches
   * the updated color — the worker already mirrors stroke→fill on save,
   * which is why print/save were already correct.
   */
  _updateProperty(type, name, value) {
    super._updateProperty(type, name, value);
    if (
      this.#measureSubType === MeasureSubType.AREA &&
      type === this.colorType
    ) {
      const opts = this._drawingOptions;
      opts.updateProperty("fill", value);
      opts.updateProperty("fill-opacity", 0.25);
      this.parent?.drawLayer.updateProperties(
        this._drawId,
        opts.toSVGProperties()
      );
    }
  }

  /** @inheritdoc */
  onScaleChanging() {
    if (!this.parent) {
      return;
    }
    super.onScaleChanging();
    const { _drawId, _drawingOptions, parent } = this;
    _drawingOptions.updateSVGProperty("stroke-width");
    parent.drawLayer.updateProperties(
      _drawId,
      _drawingOptions.toSVGProperties()
    );
  }

  static onScaleChangingWhenDrawing() {
    const parent = this._currentParent;
    if (!parent) {
      return;
    }
    super.onScaleChangingWhenDrawing();
    this._defaultDrawingOptions.updateSVGProperty("stroke-width");
    parent.drawLayer.updateProperties(
      this._currentDrawId,
      this._defaultDrawingOptions.toSVGProperties()
    );
  }

  /** @inheritdoc */
  createDrawingOptions({ color, thickness, opacity }) {
    this._drawingOptions = MeasureEditor.getDefaultDrawingOptions({
      stroke: Util.makeHexColor(...color),
      "stroke-width": thickness,
      "stroke-opacity": opacity,
    });
  }

  /** @inheritdoc */
  isEmpty() {
    return this._drawId === null;
  }

  #calibrationStarted = false;

  // Class-wide guard: prevents two calibrate prompts from racing if a stray
  // event creates a second editor while the first one is still asking the
  // user for a distance.
  static _calibratingNow = false;

  /** @inheritdoc */
  onceAdded(focus) {
    if (
      this.#measureSubType === MeasureSubType.CALIBRATE &&
      !this.#calibrationStarted &&
      // Only when the user actually traced a fresh calibration — never on
      // reload (where annotationElementId is set by deserialize).
      !this.annotationElementId
    ) {
      this.#calibrationStarted = true;
      // The prompt UI is async — defer to the next macrotask so the editor
      // is fully committed before showing the dialog.
      setTimeout(() => this.#deferredCalibrate(), 0);
    }
    super.onceAdded(focus);
  }

  async #deferredCalibrate() {
    const ok = await this.#runCalibrate();
    if (!ok) {
      // User cancelled or input invalid → discard. The editor was already
      // committed by super.onceAdded so we have to clean it up here.
      this._uiManager?.removeEditor(this);
      if (this._drawId !== null) {
        this.parent?.drawLayer.remove(this._drawId);
        this._drawId = null;
      }
      this.parent?.remove(this);
    }
  }

  async #runCalibrate() {
    if (MeasureEditor._calibratingNow) {
      return false;
    }
    let pdfDistance = 0;
    try {
      const { points } = this.serializeDraw(/* isForCopying = */ false);
      const stroke = points && points[0];
      if (stroke && stroke.length >= 4) {
        const dx = stroke[2] - stroke[0];
        const dy = stroke[3] - stroke[1];
        pdfDistance = Math.hypot(dx, dy);
      }
    } catch {
      pdfDistance = 0;
    }
    if (pdfDistance <= 0) {
      return false;
    }
    MeasureEditor._calibratingNow = true;
    // 1 PDF point = 0.352777778 mm
    const measuredMm = pdfDistance * 0.352777778;
    let realDistance;
    try {
      realDistance = await promptCalibrationDistance(measuredMm, "1");
    } finally {
      MeasureEditor._calibratingNow = false;
    }
    if (!isFinite(realDistance) || realDistance <= 0) {
      return false;
    }
    const scaleFactor = realDistance / pdfDistance;
    this.#scaleFactor = scaleFactor;
    this.#unit = "m";
    MeasureEditor._defaultScaleFactor = scaleFactor;
    // Notify the panel — annotation_editor_params.js listens for this and
    // updates the "Échelle : 1:N" label. With scaleFactor in m/pt and the
    // PDF point = 0.000352777m, the map ratio N = scaleFactor / 0.000352777.
    const ratioN = Math.round(scaleFactor / 0.000352777778);
    this._uiManager?._eventBus?.dispatch?.("measure-scale-calibrated", {
      source: this,
      scaleFactor,
      ratioN,
    });
    this._refreshLabel();
    this.div?.classList.add("measureCalibrate");
    return true;
  }

  /** @inheritdoc */
  render() {
    if (this.div) {
      return this.div;
    }
    const div = super.render();
    let label = div.querySelector(".measureLabel");
    if (!label) {
      label = document.createElement("span");
      label.className = "measureLabel";
      div.append(label);
    }
    if (this.#measureSubType === MeasureSubType.CALIBRATE) {
      div.classList.add("measureCalibrate");
    }
    // Saved measures (deserialized from a /Annots entry) have a native
    // PolylineAnnotationElement rendered just below us in the AnnotationLayer.
    // It owns the hover popup and the dblclick → re-edit handler. We mark
    // the editor div so the CSS can drop pointer-events in NONE/view mode
    // and let those events through. Fresh, in-memory measures keep their
    // own pointer-events so AnnotationEditor's own `dblclick` listener can
    // re-enter edit mode.
    if (this.annotationElementId) {
      div.classList.add("hasAnnotationLayerSibling");
    }
    this.#bindLabelDrag(label);
    this.#applyLabelOffset();
    this._refreshLabel();
    return div;
  }

  #labelOffset = { x: 0, y: 0 };

  // Allows MeasureEditor.deserialize to seed the offset before render() runs.
  _setLabelOffsetPx({ x, y }) {
    this.#labelOffset.x = x;
    this.#labelOffset.y = y;
    this.#applyLabelOffset();
  }

  #labelOffsetInPdfPoints() {
    const [parentW] = this.parentDimensions;
    const [pageW] = this.pageDimensions;
    const scale = parentW > 0 ? pageW / parentW : 1;
    // CSS Y-down → PDF Y-up: flip y.
    return [this.#labelOffset.x * scale, -this.#labelOffset.y * scale];
  }

  #applyLabelOffset() {
    const label = this.div?.querySelector(".measureLabel");
    if (!label) {
      return;
    }
    const { x, y } = this.#labelOffset;
    label.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  #bindLabelDrag(label) {
    if (label.dataset.measureDragBound === "1") {
      return;
    }
    label.dataset.measureDragBound = "1";
    let dragging = false;
    let startClientX = 0;
    let startClientY = 0;
    let baseX = 0;
    let baseY = 0;
    const onDown = e => {
      if (e.button !== 0) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      startClientX = e.clientX;
      startClientY = e.clientY;
      baseX = this.#labelOffset.x;
      baseY = this.#labelOffset.y;
      try {
        label.setPointerCapture(e.pointerId);
      } catch {}
    };
    const onMove = e => {
      if (!dragging) {
        return;
      }
      this.#labelOffset.x = baseX + (e.clientX - startClientX);
      this.#labelOffset.y = baseY + (e.clientY - startClientY);
      this.#applyLabelOffset();
    };
    const onUp = e => {
      if (!dragging) {
        return;
      }
      dragging = false;
      try {
        label.releasePointerCapture(e.pointerId);
      } catch {}
    };
    label.addEventListener("pointerdown", onDown);
    label.addEventListener("pointermove", onMove);
    label.addEventListener("pointerup", onUp);
    label.addEventListener("pointercancel", onUp);
  }

  #currentVertices() {
    if (this._drawId === null) {
      return null;
    }
    try {
      const { points } = this.serializeDraw(/* isForCopying = */ false);
      return points && points[0] ? Array.from(points[0]) : null;
    } catch {
      return null;
    }
  }

  #computeMeasureLabel(vertices) {
    if (!vertices || vertices.length < 4) {
      return "";
    }
    const calibrated = this.#scaleFactor && this.#scaleFactor !== 1;
    const scale = this.#scaleFactor || 1;
    const unit = calibrated ? this.#unit : "pt";
    if (this.#measureSubType === MeasureSubType.CALIBRATE) {
      // Total length in PDF points → real distance via local scaleFactor.
      let pdfLen = 0;
      for (let i = 0, ii = vertices.length - 2; i < ii; i += 2) {
        const dx = vertices[i + 2] - vertices[i];
        const dy = vertices[i + 3] - vertices[i + 1];
        pdfLen += Math.hypot(dx, dy);
      }
      const real = pdfLen * scale;
      const ratioN = Math.round(scale / 0.000352777778);
      return `Échelle 1:${ratioN} — ${real.toFixed(2)} ${unit}`;
    }
    if (this.#measureSubType === MeasureSubType.AREA) {
      let area = 0;
      for (let i = 0, ii = vertices.length; i < ii; i += 2) {
        const j = (i + 2) % ii;
        area += vertices[i] * vertices[j + 1];
        area -= vertices[j] * vertices[i + 1];
      }
      area = Math.abs(area) / 2;
      const real = area * scale * scale;
      return `${real.toFixed(2)} ${unit}²`;
    }
    if (
      this.#measureSubType === MeasureSubType.PERPENDICULAR &&
      vertices.length >= 8
    ) {
      // [v0, v1, foot, tip] → measure only the perpendicular leg foot→tip.
      const dx = vertices[6] - vertices[4];
      const dy = vertices[7] - vertices[5];
      const real = Math.hypot(dx, dy) * scale;
      return `${real.toFixed(2)} ${unit}`;
    }
    let total = 0;
    for (let i = 0, ii = vertices.length - 2; i < ii; i += 2) {
      const dx = vertices[i + 2] - vertices[i];
      const dy = vertices[i + 3] - vertices[i + 1];
      total += Math.hypot(dx, dy);
    }
    const real = total * scale;
    return `${real.toFixed(2)} ${unit}`;
  }

  // Public (non-#) so it stays callable from `_onResized` even when invoked
  // during `super(params)` — at that point the subclass's private slots
  // aren't installed on `this` yet.
  _refreshLabel() {
    if (!this.div) {
      return;
    }
    const labelEl = this.div.querySelector(".measureLabel");
    if (!labelEl) {
      return;
    }
    const verts = this.#currentVertices();
    labelEl.textContent = verts ? this.#computeMeasureLabel(verts) : "";
  }

  /** @inheritdoc */
  _onTranslated() {
    super._onTranslated();
    this._refreshLabel();
    this._refreshViewElement();
  }

  /** @inheritdoc */
  _onResized() {
    super._onResized();
    this._refreshLabel();
    this._refreshViewElement();
  }

  // Public (non-#) for the same reason as `_refreshLabel`: `_onResized` is
  // invoked from `#updateBbox` during `super(params)`, before the subclass's
  // private slots are installed on `this`. The `#viewElement in this` brand
  // check returns false in that window so we bail out without throwing.
  _refreshViewElement() {
    if (!(#viewElement in this)) {
      return;
    }
    if (!this.#viewElement) {
      return;
    }
    this.#removeViewElement();
    this.#showViewElement();
  }

  /** @inheritdoc */
  _onStartDragging() {
    super._onStartDragging();
    if (!(#viewElement in this)) {
      return;
    }
    this.#viewElement?.hide?.();
  }

  /** @inheritdoc */
  _onStopDragging() {
    super._onStopDragging();
    if (!(#viewElement in this)) {
      return;
    }
    if (!this.#viewElement) {
      return;
    }
    this.#removeViewElement();
    this.#showViewElement();
  }

  /** @inheritdoc */
  serialize(isForCopying = false) {
    if (this.deleted) {
      return this.serializeDeleted();
    }
    if (this.isEmpty()) {
      return null;
    }

    const { lines, points, rect } = this.serializeDraw(isForCopying);
    const {
      _drawingOptions: {
        stroke,
        "stroke-opacity": opacity,
        "stroke-width": thickness,
      },
    } = this;

    const stroke0 = points[0] || new Float32Array();
    const vertices = Array.from(stroke0);
    const colorRgb = AnnotationEditor._colorManager.convert(stroke);
    const measureLabel = this.#computeMeasureLabel(vertices);
    const labelOffset = this.#labelOffsetInPdfPoints();

    // serializeDraw returns the geometric bbox without any margin. For a
    // strictly horizontal or vertical stroke (typical for distance and
    // calibrate) the bbox collapses to height=0 or width=0, which in turn
    // makes the saved /Rect (and the appearance-stream BBox) degenerate —
    // PDF readers then clip the path entirely while the label, drawn at
    // the rect's edge, stays partially visible. Pad symmetrically so the
    // rect always has at least the line thickness on both axes; vertices
    // sit on the centerline so the path stays inside the padded rect.
    const minPad = Math.max(2, thickness || 1);
    if (rect[3] - rect[1] < minPad) {
      const cy = (rect[1] + rect[3]) / 2;
      rect[1] = cy - minPad / 2;
      rect[3] = cy + minPad / 2;
    }
    if (rect[2] - rect[0] < minPad) {
      const cx = (rect[0] + rect[2]) / 2;
      rect[0] = cx - minPad / 2;
      rect[2] = cx + minPad / 2;
    }

    // Worker bakes the label into the appearance stream (Helvetica 9pt). If
    // the rect doesn't cover the label's bbox, the PDF BBox clips the text
    // — the typical symptom on a horizontal calibrate is "only the few
    // characters that overlap the line are printed". Mirror the worker's
    // text metrics + label centering and grow the rect to include the
    // label, plus a small breathing pad.
    let measuredTextWPt = null;
    if (typeof measureLabel === "string" && measureLabel.length > 0) {
      const fontSize = 9;
      // Use the browser's actual Helvetica/Arial metrics to compute the
      // label width: the worker can then place the printed/saved label at
      // exactly the same horizontal position the user sees on screen
      // (otherwise a generic `length × 0.5em` estimate over-shoots and
      // shifts everything left by half the error). We do this once per
      // serialize and pass `textW` along to the worker.
      const measureCanvas = (MeasureEditor.#textMeasureCanvas ||=
        document.createElement("canvas"));
      const ctx = measureCanvas.getContext("2d");
      const isCalibrate =
        this.#measureSubType === MeasureSubType.CALIBRATE;
      // Canvas font sizes accept "pt" but the returned `width` is in CSS
      // pixels. Use px (12 = 9pt) to make the unit explicit, then convert
      // to PDF points (1pt = 4/3 px → multiply by 0.75).
      ctx.font = `${isCalibrate ? "bold " : ""}12px Helvetica, Arial, sans-serif`;
      // ASCII-fold the label exactly the way the worker does before
      // baking it, so we measure the same string the PDF will render.
      const asciiLabel = measureLabel
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/²/g, "2")
        .replace(/[—–]/g, "-")
        .replace(/[^\x20-\x7e]/g, "?");
      const widthCssPx = ctx.measureText(asciiLabel).width;
      const textW = (measuredTextWPt = widthCssPx * 0.75);
      const textH = fontSize * 1.2;
      const labelPad = 4;
      let cx = 0,
        cy = 0;
      if (vertices.length >= 2) {
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity;
        for (let i = 0, ii = vertices.length; i < ii; i += 2) {
          const x = vertices[i];
          const y = vertices[i + 1];
          if (x < minX) {
            minX = x;
          }
          if (x > maxX) {
            maxX = x;
          }
          if (y < minY) {
            minY = y;
          }
          if (y > maxY) {
            maxY = y;
          }
        }
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
      }
      const lx = cx + (Array.isArray(labelOffset) ? labelOffset[0] : 0);
      const ly = cy + (Array.isArray(labelOffset) ? labelOffset[1] : 0);
      const lblX0 = lx - textW / 2 - labelPad;
      const lblX1 = lx + textW / 2 + labelPad;
      const lblY0 = ly - textH / 2 - labelPad;
      const lblY1 = ly + textH / 2 + labelPad;
      if (lblX0 < rect[0]) {
        rect[0] = lblX0;
      }
      if (lblX1 > rect[2]) {
        rect[2] = lblX1;
      }
      if (lblY0 < rect[1]) {
        rect[1] = lblY0;
      }
      if (lblY1 > rect[3]) {
        rect[3] = lblY1;
      }
    }

    const serialized = {
      annotationType: AnnotationEditorType.MEASURE,
      measureSubType: this.#measureSubType,
      vertices,
      // Worker-side keys (createNewMeasureAnnotation reads these names).
      color: colorRgb,
      opacity,
      lineWidth: thickness,
      unit: this.#unit,
      scaleFactor: this.#scaleFactor,
      label: measureLabel,
      labelOffset,
      // Browser-measured label width in PDF points (matches actual
      // Helvetica/Arial rendering). Worker uses this when present
      // instead of its `length × 0.5em` fallback.
      labelTextW: measuredTextWPt,
      // Forward the popup ref so re-saves of an existing annotation reuse
      // the same /Popup object instead of leaking a fresh one each save —
      // every leaked ref ends up in the page's /Annots array and shows up as
      // an orphaned annotation on reload.
      popupRef: this._initialData?.popupRef || null,
      // DrawingEditor round-trip keys (so reload deserializes via this class).
      thickness,
      paths: { lines, points },
      pageIndex: this.pageIndex,
      rect,
      rotation: this.rotation,
      structTreeParentId: this._structTreeParentId,
    };
    this.addComment(serialized);
    // Preserve a comment that came from the PDF but wasn't edited in this
    // session — otherwise re-saving the (otherwise modified) annotation
    // would strip its /Contents and the popup would disappear.
    if (!serialized.popup && this._initialData?.comment) {
      serialized.popup = {
        contents: this._initialData.comment,
        deleted: false,
      };
    }

    if (isForCopying) {
      serialized.isCopy = true;
      return serialized;
    }

    if (this.annotationElementId && !this.#hasElementChanged(serialized)) {
      return null;
    }

    serialized.id = this.annotationElementId;
    return serialized;
  }

  #hasElementChanged(serialized) {
    if (!this._initialData) {
      return true;
    }
    if (this._needsPopupRewrite) {
      // Loaded from a PDF saved before /Popup was always emitted — force a
      // rewrite so Firefox's bundled pdf.js can show the tooltip.
      return true;
    }
    const { color, thickness, opacity, pageIndex, labelOffsetPt } =
      this._initialData;
    const initialOffset = labelOffsetPt || [0, 0];
    const newOffset = serialized.labelOffset || [0, 0];
    return (
      this.hasEditedComment ||
      this._hasBeenMoved ||
      this._hasBeenResized ||
      serialized.color.some((c, i) => c !== color[i]) ||
      serialized.thickness !== thickness ||
      serialized.opacity !== opacity ||
      serialized.pageIndex !== pageIndex ||
      Math.abs(newOffset[0] - initialOffset[0]) > 0.01 ||
      Math.abs(newOffset[1] - initialOffset[1]) > 0.01
    );
  }

  /** @inheritdoc */
  renderAnnotationElement(annotation) {
    annotation.updateEdited({
      rect: this.getRect(0, 0),
    });
    return null;
  }

  /* -------------------------------------------------------------------- *
   * Read-only view element
   *
   * Reloaded measures get their popup-on-hover for free via the
   * PolylineAnnotationElement / PolygonAnnotationElement that the
   * AnnotationLayer creates from the parsed PDF dict. A freshly-drawn
   * measure has no such counterpart yet (the editor only becomes a real
   * /Annot after save+reload), so we synthesize the same kind of element
   * directly from the editor's data and let the AnnotationLayer attach it
   * — the popup, scope CSS, hover trigger, calibrate dispatch, etc. all
   * come along for free.
   *
   * The synthesized element is destroyed when the user re-enters edit
   * mode (so the editor's interactive surface takes over) or when the
   * editor itself is removed.
   * -------------------------------------------------------------------- */

  #viewElement = null;

  #buildViewElementData() {
    const verts = this.#currentVertices();
    if (!verts || verts.length < 4) {
      return null;
    }
    const rect = this.getRect(0, 0);
    let label = "";
    try {
      label = this.#computeMeasureLabel(verts) || "";
    } catch {
      // ignore
    }
    let commentText = "";
    try {
      const c = this.comment;
      commentText = c && !c.deleted ? c.text || "" : "";
    } catch {
      commentText = this._initialData?.comment || "";
    }
    if (!commentText) {
      commentText = this._initialData?.comment || "";
    }
    let contents = "";
    if (label && commentText) {
      contents = `${label}\n———\n${commentText}`;
    } else if (commentText) {
      contents = commentText;
    } else if (label) {
      contents = label;
    }

    const subtypeTitle = {
      [MeasureSubType.DISTANCE]: "Mesure distance",
      [MeasureSubType.POLYLINE]: "Mesure polyligne",
      [MeasureSubType.AREA]: "Mesure surface",
      [MeasureSubType.PERPENDICULAR]: "Mesure perpendiculaire",
      [MeasureSubType.CALIBRATE]: "Étalonnage d'échelle",
    }[this.#measureSubType] || "Mesure";

    const isPolygon = this.#measureSubType === MeasureSubType.AREA;
    const intent =
      isPolygon
        ? "PolygonDimension"
        : this.#measureSubType === MeasureSubType.POLYLINE
          ? "PolyLineDimension"
          : "LineDimension";

    const {
      _drawingOptions: {
        stroke,
        "stroke-opacity": opacity,
        "stroke-width": thickness,
      },
    } = this;
    const colorRgb = AnnotationEditor._colorManager.convert(stroke);

    return {
      // Synthetic (non-PDF) id — getEditableAnnotation lookups won't find
      // it and the AnnotationEditorLayer.enable flow ignores ids it
      // doesn't recognise, so this stays out of the deserialize path.
      id: `${this.id}-view`,
      annotationType: isPolygon
        ? AnnotationType.POLYGON
        : AnnotationType.POLYLINE,
      subtype: isPolygon ? "Polygon" : "PolyLine",
      it: intent,
      rect,
      vertices: Float32Array.from(verts),
      color: Uint8ClampedArray.from(colorRgb),
      opacity: opacity ?? 1,
      borderStyle: {
        width: thickness,
        rawWidth: thickness,
        style: 1, // SOLID
        dashArray: [3],
        horizontalCornerRadius: 0,
        verticalCornerRadius: 0,
      },
      contentsObj: { str: contents, dir: "ltr" },
      titleObj: { str: subtypeTitle, dir: "ltr" },
      subj: `pdfjs-measure-${this.#measureSubType}`,
      measure:
        this.#scaleFactor && this.#scaleFactor !== 1
          ? { scaleFactor: this.#scaleFactor, unit: this.#unit }
          : null,
      rotation: 0,
      // Mark non-editable so AnnotationEditorLayer.enable doesn't try to
      // deserialize this back into an editor — we already have the editor.
      isEditable: false,
      noHTML: false,
      hasOwnCanvas: false,
      noRotate: true,
      popupRef: null,
      modificationDate: null,
    };
  }

  #showViewElement() {
    // Saved measures already have a real PolylineAnnotationElement in the
    // AnnotationLayer (created at PDF load) — that one handles popup-on-
    // hover. Adding a synthetic on top would render a duplicate.
    if (this.annotationElementId) {
      return;
    }
    if (this.#viewElement) {
      this.#viewElement.show();
      return;
    }
    const annotationLayer = this.parent?.annotationLayer;
    if (!annotationLayer ||
        typeof annotationLayer.createSyntheticElement !== "function") {
      return;
    }
    const data = this.#buildViewElementData();
    if (!data) {
      return;
    }
    this.#viewElement = annotationLayer.createSyntheticElement(data);
    if (this.#viewElement?.root) {
      // Reloaded measures get their dblclick handler from
      // PolylineAnnotationElement.render() (data.isMeasure → _editOnDoubleClick).
      // For synthesized measures we still hold the editor in memory, so
      // dispatch with editId = this.id to match `editor.id === editId` in
      // AnnotationEditorUIManager.updateMode().
      const editorId = this.id;
      this.#viewElement.root.addEventListener("dblclick", () => {
        this._uiManager?._eventBus?.dispatch?.(
          "switchannotationeditormode",
          {
            source: this,
            mode: AnnotationEditorType.MEASURE,
            editId: editorId,
            mustEnterInEditMode: true,
          }
        );
      });
    }
  }

  #hideViewElement() {
    if (this.#viewElement) {
      this.#viewElement.hide?.();
    }
  }

  #removeViewElement() {
    this.#viewElement?.remove?.();
    this.#viewElement = null;
  }

  /** @inheritdoc */
  disableEditing() {
    super.disableEditing();
    // Defer so the editor div is positioned before we measure / append the
    // synthetic annotation element.
    queueMicrotask(() => this.#showViewElement());
  }

  /** @inheritdoc */
  enableEditing() {
    super.enableEditing();
    this.#removeViewElement();
  }

  /**
   * Base AnnotationEditor.enterInEditMode() short-circuits when
   * `canChangeContent` is false (true only for FreeText). For measures the
   * relevant entry point is `enableEditing` — it strips the `.disabled`
   * class from the editor div and removes the synthetic view element so the
   * vertex outlines become manipulable again. Both dblclick paths land here:
   * the base editor's `dblclick` handler on the editor div (selected editors
   * intercept events first), and the synthetic SVG's manual listener routed
   * via `switchannotationeditormode` → `updateMode` → `enterInEditMode`.
   */
  enterInEditMode() {
    this.enableEditing();
  }

  /**
   * Double-clicking a fresh measure (no annotationElementId) in view mode
   * must switch the viewer back to MEASURE editing AND re-enter edit mode
   * for this specific editor. The base AnnotationEditor.dblclick fires
   * updateToolbar without `mustEnterInEditMode`, so it would only select
   * the measure without lifting the `.disabled` class. Reloaded measures
   * (with an annotationElementId) get this routing from the native
   * PolylineAnnotationElement, so they don't need this override.
   */
  dblclick(event) {
    if (event.target.nodeName === "BUTTON") {
      return;
    }
    // Already in MEASURE mode → dispatching switchannotationeditormode
    // would be a no-op (the viewer's setter early-returns when the mode
    // doesn't change), so call enterInEditMode directly. Only the cross-
    // mode case (e.g. dblclick from NONE view mode) needs the dispatch
    // so the viewer routes through updateMode → setSelected →
    // enterInEditMode.
    if (this._uiManager?.getMode() === AnnotationEditorType.MEASURE) {
      this.enterInEditMode();
      return;
    }
    this._uiManager?._eventBus?.dispatch?.("switchannotationeditormode", {
      source: this,
      mode: AnnotationEditorType.MEASURE,
      editId: this.uid,
      mustEnterInEditMode: true,
    });
  }

  /** @inheritdoc */
  pointerdown(event) {
    // In NONE / view mode the editor div has pointer-events back on (so
    // dblclick can re-enter edit mode), but a single click must stay a
    // no-op — view mode is read-only.
    if (this._uiManager?.getMode() === AnnotationEditorType.NONE) {
      return;
    }
    super.pointerdown(event);
  }

  /** @inheritdoc */
  remove() {
    this.#removeViewElement();
    super.remove();
  }
}

export { MeasureEditor };
