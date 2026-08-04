import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';


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
  console.log("========== FILE ==========");
  console.log("Original:", file.originalname);
  console.log("Mime:", file.mimetype);
  console.log("Extension:", path.extname(file.originalname));

  cb(null, true);
}

const upload = multer({ storage, fileFilter });

export default upload;
