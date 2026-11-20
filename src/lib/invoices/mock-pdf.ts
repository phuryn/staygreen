import type { InvoiceDocument } from "./contract";

/** Minimal PDF 1.4, with byte offsets, page tree, Helvetica and a valid xref. */
export function samplePdf(document: InvoiceDocument): Uint8Array {
  if (!document.number || !document.issue_date || document.gross === null) throw new Error("Pending document has no PDF");
  const ascii = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L")
    .replace(/[^\x20-\x7e\u2014]/g, "?").replace(/[\\()]/g, "\\$&").replace(/\u2014/g, "\\227");
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: document.currency }).resolvedOptions().maximumFractionDigits!;
  const lines = ["SAMPLE — not a real invoice", document.number ?? "Being issued", `Date: ${document.issue_date}`,
    ...(document.description ? [document.description] : []),
    `Buyer: ${(document.buyer?.name ?? "Not supplied")}`, `Country: ${(document.buyer?.country ?? "Not supplied")}`, `VAT ID: ${document.buyer?.tax_id ?? "None"}`,
    `Total: ${(document.gross / 10 ** digits).toFixed(digits)} ${document.currency}`];
  const content = `BT /F1 12 Tf 50 790 Td 20 TL ${lines.map((line, i) => `${i ? "T* " : ""}(${ascii(line)}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

