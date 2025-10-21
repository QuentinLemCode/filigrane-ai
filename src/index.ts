import "dotenv/config";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { exiftool } from "exiftool-vendored";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

const INPUT_DIR = path.resolve(process.cwd(), "input");
const OUTPUT_DIR = path.resolve(process.cwd(), "output");
const MODEL_NAME = "gemini-2.5-flash-image";
const PROMPT_TEXT = "Peux tu enlever le filigrane sur cette image stp";

function isJpegFilename(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg";
}

async function ensureDirExists(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {}
}

function chooseMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function listJpegs(dir: string): Promise<string[]> {
  const entries: Array<fs.Dirent> = await fsp.readdir(dir, {
    withFileTypes: true,
  });
  return entries
    .filter((e: fs.Dirent) => e.isFile() && isJpegFilename(e.name))
    .map((e: fs.Dirent) => e.name);
}

async function sendImageAndGetReturnedImage(
  genAI: GoogleGenAI,
  filename: string,
  imageBuffer: Buffer
): Promise<Buffer | null> {
  const base64 = imageBuffer.toString("base64");
  const mimeType = chooseMimeTypeFromFilename(filename);

  const result = await genAI.models.generateContent({
    model: MODEL_NAME,
    contents: [
      { text: PROMPT_TEXT },
      { inlineData: { mimeType, data: base64 } },
    ],
  });

  const parts = result.candidates?.[0]?.content?.parts ?? [];

  // Look for inlineData image in the response.
  for (const part of parts ?? []) {
    const inline = part?.inlineData;
    if (inline && typeof inline.data === "string") {
      return Buffer.from(inline.data, "base64");
    }
  }

  return null;
}

async function copyAllExifFromTo(
  srcPath: string,
  destPath: string
): Promise<void> {
  // Use exiftool to copy all tags from source to destination.
  // -TagsFromFile SRC -All:All -overwrite_original DEST
  await exiftool.write(destPath, {}, [
    "-TagsFromFile",
    srcPath,
    "-All:All",
    "-overwrite_original",
  ]);
}

async function processOneFile(
  genAI: GoogleGenAI,
  filename: string
): Promise<void> {
  const inputPath = path.join(INPUT_DIR, filename);
  const outputPath = path.join(OUTPUT_DIR, filename);

  const inputBuffer = await fsp.readFile(inputPath);

  const returnedBuffer = await sendImageAndGetReturnedImage(
    genAI,
    filename,
    inputBuffer
  );
  if (!returnedBuffer) {
    console.warn(`No image returned by model for: ${filename}`);
    return;
  }

  // Convert the returned image (likely PNG) to JPEG before saving
  const jpegBuffer = await sharp(returnedBuffer)
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();

  await fsp.writeFile(outputPath, jpegBuffer);

  try {
    await copyAllExifFromTo(inputPath, outputPath);
  } catch (err) {
    console.warn(`Failed to copy EXIF for ${filename}:`, err);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  await ensureDirExists(INPUT_DIR);
  await ensureDirExists(OUTPUT_DIR);

  const files = await listJpegs(INPUT_DIR);
  if (files.length === 0) {
    console.log("No JPEG files found in input folder.");
    return;
  }

  const genAI = new GoogleGenAI({apiKey});

  for (const file of files) {
    try {
      await processOneFile(genAI, file);
      console.log(`Processed: ${file}`);
    } catch (err) {
      console.error(`Error processing ${file}:`, err);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
  })
  .finally(async () => {
    try {
      await exiftool.end();
    } catch {}
  });
