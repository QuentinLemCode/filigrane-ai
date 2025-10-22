## Filigrane AI

Interactive CLI to batch process JPEG images and attempt to remove visible watermarks using Google Gemini. For each photo in `input/`, the app asks Gemini to edit the image, converts the result to JPEG, preserves EXIF metadata, and guides you through an interactive review loop where you can accept, add comments to refine the result, retry from the original, or skip.

> Ethical note: Removing watermarks may violate terms of service or rights of content owners. Use only on images you have the legal right to modify.

### What it does
- **Scans** the `input/` folder for `.jpg`/`.jpeg` files.
- **Sends** each image to Gemini (`gemini-2.5-flash-image`) with a base prompt (default is in French) asking to remove the watermark.
- **Receives** an edited image and **converts** it to JPEG (`quality: 95`) via `sharp`.
- **Preserves EXIF** metadata by copying all tags from the original using `exiftool-vendored`.
- **Prompts you** per image with an interactive menu: `accept`, `comment`, `retry`, or `skip`.
  - **accept**: keep the generated JPEG in `output/` and continue to the next file.
  - **comment**: enter extra instructions; the tool resubmits using the last generated image as context so Gemini iterates toward your request.
  - **retry**: start over from the original input image (clears prior context), using the base prompt again.
  - **skip**: delete the just-generated output and also delete the original input file, then move on.

### Prerequisites
- Node.js 20+ (Node 22+ recommended; see Run options below)
- A Google Gemini API key

### Getting a Gemini API key
1. Create a key from Google AI Studio: [ai.google.dev](https://ai.google.dev/gemini-api/docs/api-key)
2. Keep it handy; you will put it in `.env` as `GEMINI_API_KEY`.

### Setup
```bash
git clone git@github.com:QuentinLemCode/filigrane-ai
cd filigrane-ai
npm install

# Configure environment
cp .env.example .env   # or create .env
```

Edit `.env` and set:
```bash
GEMINI_API_KEY=your_key_here
```

Folders used (created automatically if missing):
- `input/`: place your source JPEG files here
- `output/`: generated JPEGs are written here

### Run
```bash
npm start
```

When running, you will see an interactive menu for each file:
```
accept | comment | retry | skip
```

### Usage tips
- Only `.jpg`/`.jpeg` files in `input/` are processed. Others are ignored.
- The base prompt is in French by default. You can change it (see Configuration).
- On `skip`, the original input file is deleted. Keep backups if needed.

### Configuration
You can tweak a few constants in `src/index.ts`:
- `INPUT_DIR` / `OUTPUT_DIR`: change folder paths
- `MODEL_NAME`: Gemini model to use (default: `gemini-2.5-flash-image`)
- `PROMPT_TEXT`: base instruction sent to Gemini (default asks to remove the watermark)
- JPEG output options: adjust the `sharp(...).jpeg({ quality: 95, mozjpeg: true })` call

### Troubleshooting
- Error: `GEMINI_API_KEY is not set`
  - Ensure you created `.env` with `GEMINI_API_KEY=...` and restarted the process.
- `No JPEG files found in input folder.`
  - Put `.jpg`/`.jpeg` files into `input/` and run again.
- `sharp` install issues
  - Ensure you are on a supported platform. Prebuilt binaries are used in most cases.
- `exiftool` failures when copying metadata
  - The vendored binary is used automatically; warnings are printed but processing continues.

### Dependencies
- `@google/genai` for Gemini API
- `sharp` for image conversion
- `exiftool-vendored` to copy EXIF metadata
- `inquirer` for the interactive CLI
- `dotenv` for environment variables

### License
GNU AGPL 3


