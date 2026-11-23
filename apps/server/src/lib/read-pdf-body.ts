import type { Request } from 'express';
import { AppError } from './errors.js';

/**
 * Reads a raw PDF body from an Express request, enforcing a byte limit at two
 * points: before reading (Content-Length header) and while reading (running
 * total). A client that lies about Content-Length or sends no header is still
 * stopped as soon as the running total passes maxBytes.
 *
 * Returns a Buffer containing the raw bytes. Throws AppError(413) when the
 * body is over the limit, or AppError(400) when the body is empty or does not
 * start with the %PDF- magic bytes.
 */
export async function readPdfBody(req: Request, maxBytes: number): Promise<Buffer> {
  // Early rejection when the declared Content-Length is above the limit.
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `PDF file too large. Maximum size is ${maxBytes / (1024 * 1024)} MB.`);
    }
  }

  // Read the stream, aborting as soon as the running total passes maxBytes.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `PDF file too large. Maximum size is ${maxBytes / (1024 * 1024)} MB.`);
    }
    chunks.push(buf);
  }

  const pdfBuffer = Buffer.concat(chunks);
  if (pdfBuffer.length === 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Empty PDF body.');
  }
  if (pdfBuffer.length < 5 || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new AppError(400, 'BAD_REQUEST', 'The uploaded file is not a valid PDF (missing %PDF- magic bytes).');
  }
  return pdfBuffer;
}