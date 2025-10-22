import "dotenv/config";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { exiftool } from "exiftool-vendored";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import inquirer from "inquirer";

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

function detectMimeTypeFromBuffer(buf: Buffer): string {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG signature: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

async function sendImageAndGetReturnedImage(
  genAI: GoogleGenAI,
  promptText: string,
  imageBuffer: Buffer,
  mimeType: string
): Promise<Buffer | null> {
  const base64 = imageBuffer.toString("base64");

  const result = await genAI.models.generateContent({
    model: MODEL_NAME,
    contents: [
      { text: promptText },
      { inlineData: { mimeType, data: base64 } },
    ],
  });

  const parts = result.candidates?.[0]?.content?.parts ?? [];

  // Look for inlineData image in the response.
  for (const part of parts ?? []) {
    const inline = (part as any)?.inlineData as { data?: string } | undefined;
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

async function promptMenu(
  filename: string
): Promise<"accept" | "comment" | "retry" | "skip"> {
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: `Fichier: ${filename}\nChoisir une option:`,
      choices: [
        { name: "accept", value: "accept" },
        { name: "comment", value: "comment" },
        { name: "retry", value: "retry" },
        { name: "skip", value: "skip" },
      ],
    },
  ]);
  return answers.choice as "accept" | "comment" | "retry" | "skip";
}

async function promptComment(): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "comment",
      message: "Entrez votre commentaire:",
    },
  ]);
  return String(answers.comment ?? "").trim();
}

async function processOneFile(
  genAI: GoogleGenAI,
  filename: string
): Promise<void> {
  const inputPath = path.join(INPUT_DIR, filename);
  const outputPath = path.join(OUTPUT_DIR, filename);

  const inputBuffer = await fsp.readFile(inputPath);

  // Maintain "context" by iteratively feeding the last generated image back to the model
  // along with new instructions (comment or retry) until the user accepts.
  let workingBuffer: Buffer = inputBuffer;
  let workingMime: string = chooseMimeTypeFromFilename(filename);
  let currentPrompt: string = PROMPT_TEXT;

  // Interactive loop until accept
  // Each iteration generates an image, saves it (with EXIF), then asks the user.
  while (true) {
    const returnedBuffer = await sendImageAndGetReturnedImage(
      genAI,
      currentPrompt,
      workingBuffer,
      workingMime
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

    // Show menu and act based on choice
    const choice = await promptMenu(filename);
    if (choice === "accept") {
      // Context can be destroyed; move on to next photo
      break;
    }
    if (choice === "comment") {
      const comment = await promptComment();
      // Keep context by feeding the last generated image back into the model
      workingBuffer = returnedBuffer;
      workingMime = detectMimeTypeFromBuffer(returnedBuffer);
      currentPrompt = `${currentPrompt}\n${comment}`;
      continue;
    }
    if (choice === "retry") {
      // Retry with NEW context: re-upload the original input image with base prompt
      workingBuffer = inputBuffer;
      workingMime = chooseMimeTypeFromFilename(filename);
      currentPrompt = PROMPT_TEXT;
      continue;
    }
    if (choice === "skip") {
      // Delete the just-generated output and move to next
      try {
        await fsp.rm(outputPath, { force: true });
      } catch {}
      try {
        await fsp.rm(inputPath, { force: true });
      } catch {}
      break;
    }
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
