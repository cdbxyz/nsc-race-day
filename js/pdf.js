/* pdf.js — the calculator's NSCPDF writer, ported.
 *
 * Carried over as-is, including the awkward parts that exist for good reason:
 *
 *   - jsPDF is fetched on demand rather than bundled. It is 350KB that no OOD
 *     needs on the water, so it stays out of the offline shell; with no signal
 *     this falls back to the browser's own print dialogue, which is exactly
 *     what the calculator has always done.
 *   - iOS ignores the download attribute, so the file is handed to the share
 *     sheet (Save to Files keeps the filename) and only then to the PDF viewer.
 *   - When the library still has to load, the user gesture is gone by the time
 *     it lands, so a tab is claimed up front while that is still permitted.
 *
 * The header says NEFYN SAILING CLUB rather than the calculator's own name.
 */

const LIB = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
let loading = null;

const IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function load() {
  if (window.jspdf?.jsPDF) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = LIB;
    tag.onload = () =>
      window.jspdf?.jsPDF ? resolve() : reject(new Error("jsPDF missing"));
    tag.onerror = () => reject(new Error("offline"));
    document.head.appendChild(tag);
    setTimeout(() => reject(new Error("timeout")), 12_000);
  });
  return loading;
}

/**
 * @param {{title, subtitle, meta, columns:[{label,width,align}],
 *          rows:[[cell,...]], muted:number[], footer, filename}} cfg
 */
function draw(cfg) {
  /* Landscape. The sheet carries a column per lap plus helm, crew, class and
     the forward-looking PY, and portrait cannot hold them without squeezing
     every column to the point where everything needs truncating. */
  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = 0;

  const NAVY = [10, 27, 61];
  const SLATE = [95, 110, 140];
  const LINE = [210, 218, 232];
  const RED = [200, 16, 46];

  const total = cfg.columns.reduce((sum, c) => sum + c.width, 0);
  const scale = (W - M * 2) / total;

  function xOf(index) {
    let x = M;
    for (let j = 0; j < index; j += 1) x += cfg.columns[j].width * scale;
    return x;
  }

  const GUTTER = 6;

  /**
   * Draw one cell, INSIDE its own column.
   *
   * This is the whole of the overlap bug. It used to compute `width` and then
   * ignore it for left-aligned text: doc.text() draws from x and keeps going,
   * so "Jim Spencer + Chris D'Arcy Burt" ran straight over the class beside
   * it. Nothing was being drawn twice — the cell simply had no right-hand
   * edge. Every cell is now measured against ITS OWN column and shortened
   * until it fits, so no cell can reach into its neighbour at any width.
   */
  function place(index, text) {
    const column = cfg.columns[index];
    const width = column.width * scale;
    const x = xOf(index);
    const room = Math.max(0, width - GUTTER);
    const fitted = truncateTo(String(text ?? ""), room);
    if (column.align === "right") doc.text(fitted, x + width - GUTTER, y, { align: "right" });
    else doc.text(fitted, x, y);
  }

  /** Shorten with an ellipsis until it measures within `room` points. */
  function truncateTo(text, room) {
    if (!text) return "";
    if (doc.getTextWidth(text) <= room) return text;
    // Binary search the longest prefix that fits with the ellipsis.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (doc.getTextWidth(`${text.slice(0, mid).trimEnd()}…`) <= room) low = mid;
      else high = mid - 1;
    }
    return low > 0 ? `${text.slice(0, low).trimEnd()}…` : "";
  }

  function colHeads() {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...SLATE);
    cfg.columns.forEach((c, i) => place(i, c.label.toUpperCase()));
    y += 6;
    doc.setDrawColor(...NAVY);
    doc.setLineWidth(0.8);
    doc.line(M, y, W - M, y);
    y += 15;
  }

  function header() {
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, W, 74, "F");
    doc.setTextColor(159, 192, 240);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(`NEFYN SAILING CLUB · ${String(cfg.subtitle ?? "").toUpperCase()}`, M, 30);
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(19);
    doc.text(cfg.title || "Race", M, 55);
    y = 96;
    doc.setTextColor(...SLATE);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(cfg.meta || "", W - M * 2);
    doc.text(lines, M, y);
    y += lines.length * 11 + 10;
    colHeads();
  }

  header();
  doc.setFontSize(9.5);

  cfg.rows.forEach((row, n) => {
    if (y > H - 60) {
      doc.addPage();
      y = 60;
      colHeads();
      doc.setFontSize(9.5);
    }
    const muted = cfg.muted?.includes(n);
    const lead = !muted && n === 0;
    row.forEach((cell, i) => {
      doc.setFont("helvetica", i === 0 || lead ? "bold" : "normal");
      if (muted) doc.setTextColor(...SLATE);
      else if (lead && i === 0) doc.setTextColor(...RED);
      else doc.setTextColor(...NAVY);
      place(i, cell == null ? "—" : cell);
    });
    y += 9;
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.4);
    doc.line(M, y, W - M, y);
    y += 15;
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...SLATE);
  const pages = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.text(cfg.footer || "", M, H - 24);
    doc.text(`${page} / ${pages}`, W - M, H - 24, { align: "right" });
  }
  return doc;
}

function openBlob(blob, tab) {
  const url = URL.createObjectURL(blob);
  if (tab && !tab.closed) tab.location.href = url;
  else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function deliver(cfg, tab) {
  const doc = draw(cfg);
  if (!IOS) {
    if (tab && !tab.closed) tab.close();
    doc.save(cfg.filename);
    return;
  }

  // iOS ignores the download attribute, so hand the file to the share sheet
  // (Save to Files keeps the filename) and fall back to the PDF viewer.
  const blob = doc.output("blob");
  let file = null;
  try {
    file = new File([blob], cfg.filename, { type: "application/pdf" });
  } catch {
    file = null;
  }
  if (!tab && file && navigator.share && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: cfg.title || "Race results" }).catch(() => {
      openBlob(blob, null);
    });
    return;
  }
  openBlob(blob, tab);
}

/**
 * Build and hand over the PDF, updating the button as it goes.
 * Falls back to the print dialogue if the library cannot be reached.
 */
export function savePdf(cfg, button) {
  const label = button.textContent;
  const ready = Boolean(window.jspdf?.jsPDF);
  // Claim a tab now, while the gesture is still ours to spend.
  const tab = IOS && !ready ? window.open("", "_blank") : null;

  if (ready) {
    try {
      deliver(cfg, null);
      button.textContent = "Saved";
    } catch {
      window.print();
      button.textContent = label;
      return;
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1800);
    return;
  }

  button.textContent = "Building…";
  button.disabled = true;
  load()
    .then(() => {
      deliver(cfg, tab);
      button.textContent = "Saved";
      setTimeout(() => {
        button.textContent = label;
        button.disabled = false;
      }, 1800);
    })
    .catch(() => {
      if (tab && !tab.closed) tab.close();
      button.textContent = label;
      button.disabled = false;
      // No signal, so no library. Printing is the honest fallback.
      window.print();
    });
}
