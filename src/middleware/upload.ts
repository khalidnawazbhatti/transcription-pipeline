import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';

const ACCEPTED_MIMES = new Set([
  'audio/mpeg',       // mp3
  'audio/mp4',        // m4a / aac in mp4 container
  'audio/aac',        // aac
  'audio/ogg',        // ogg
  'audio/flac',       // flac
  'audio/wav',        // wav
  'audio/x-wav',      // wav (alternate MIME)
  'audio/webm',       // webm
  'audio/opus',       // opus
  'video/mp4',        // mp4 with audio track
  'video/webm',       // webm with audio track
  'application/octet-stream', // generic binary — let ffmpeg decide
]);

const storage = multer.diskStorage({
  destination: 'storage/audio',
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (ACCEPTED_MIMES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type "${file.mimetype}". Accepted: mp3, wav, m4a, aac, ogg, flac, mp4, webm, opus`));
  }
}

const upload = multer({ storage, fileFilter });

export default upload;
