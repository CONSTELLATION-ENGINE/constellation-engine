// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module file-parser
 * @description Parses uploaded files (txt, md, json, csv, pdf, docx, xlsx, plus most plain-text code/config formats) into plain text.
 */

import { extname } from 'node:path';

const MAX_TEXT_LENGTH = 20000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const PLAIN_TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.log', '.text', '.rst',
  '.py', '.java', '.js', '.ts', '.jsx', '.tsx', '.cjs', '.mjs',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1',
  '.yml', '.yaml', '.toml', '.ini', '.conf',
  '.html', '.htm', '.css', '.scss', '.xml', '.svg',
  '.sql'
]);

const BINARY_EXTS = new Set(['.pdf', '.docx', '.xlsx']);

export class FileParser {
  /**
   * Parse a file buffer into text content.
   * @param {Buffer} buffer - File content
   * @param {string} filename - Original filename
   * @returns {Promise<{ text: string, truncated: boolean }>}
   */
  static async parse(buffer, filename) {
    const ext = extname(filename).toLowerCase();
    let text;

    if (!buffer || buffer.length === 0) {
      return { text: '', truncated: false };
    }

    if (PLAIN_TEXT_EXTS.has(ext)) {
      text = buffer.toString('utf-8');
    } else if (ext === '.pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        text = result.text || '';
        if (typeof parser.destroy === 'function') {
          await parser.destroy().catch(() => {});
        }
      } catch (err) {
        throw new Error(`Failed to parse PDF: ${err.message}`);
      }
    } else if (ext === '.docx') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      } catch (err) {
        throw new Error(`Failed to parse DOCX: ${err.message}`);
      }
    } else if (ext === '.xlsx') {
      try {
        const XLSX = (await import('xlsx')).default || await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheets = [];
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          sheets.push(`[Sheet: ${name}]\n${csv}`);
        }
        text = sheets.join('\n\n');
      } catch (err) {
        throw new Error(`Failed to parse XLSX: ${err.message}`);
      }
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    const truncated = text.length > MAX_TEXT_LENGTH;
    if (truncated) {
      text = text.slice(0, MAX_TEXT_LENGTH);
    }
    return { text, truncated };
  }

  /**
   * Check if a file extension is supported.
   * @param {string} filename
   * @returns {boolean}
   */
  static isSupported(filename) {
    const ext = extname(filename).toLowerCase();
    return PLAIN_TEXT_EXTS.has(ext) || BINARY_EXTS.has(ext);
  }

  /**
   * Get max file size for a given extension.
   * Uniform 20MB cap (user decision 2026-04-25).
   * @param {string} _filename
   * @returns {number} Max size in bytes
   */
  static maxSize(_filename) {
    return MAX_FILE_BYTES;
  }

  /** @returns {number} Max characters returned per file */
  static get maxTextLength() { return MAX_TEXT_LENGTH; }
}
