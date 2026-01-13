// api/render.js
import { chromium } from "playwright";
import axios from "axios";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import util from "util";

const execFileAsync = util.promisify(execFile);

// Helper: download a file from url to local path
async function downloadToFile(url, destPath) {
  console.log("Downloading file from", url, "to", destPath);
  const writer = fs.createWriteStream(destPath);

  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    },
  });

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on("error", (err) => {
      error = err;
      writer.close();
      console.error("Error writing downloaded file:", err);
      reject(err);
    });
    writer.on("close", () => {
      if (!error) {
        console.log("Finished downloading to", destPath);
        resolve();
      }
    });
  });
}

// Helper: get audio duration using ffprobe
async function getAudioDurationSeconds(audioPath) {
  try {
    console.log("Running ffprobe on:", audioPath);
    const { stdout, stderr } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    if (stderr) console.log("ffprobe stderr:", stderr);
    const sec = Math.max(1, Number((stdout || "").trim() || "0"));
    console.log("Audio duration (seconds):", sec);
    return sec;
  } catch (err) {
    console.error("ffprobe error:", err);
    throw new Error("ffprobe failed: " + (err.stderr || err.message || String(err)));
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const screenshotPath = path.join(tmpDir, "screenshot.png");
  const audioPath = path.join(tmpDir, "audio.mp3");
  const outPath = path.join(tmpDir, "out.mp4");

  console.log("----- /api/render called -----");
  console.log("Temp dir:", tmpDir);

  try {
    const { website_url, audio_url } = req.body || {};
    console.log("Incoming /render", { website_url, audio_url });

    if (!website_url || !audio_url) {
      console.warn("Missing website_url or audio_url");
      return res
        .status(400)
        .json({ error: "website_url and audio_url are required" });
    }

    // 1) Download audio
    await downloadToFile(audio_url, audioPath);

    // 2) Capture screenshot with Playwright
    const normalizedUrl = /^https?:\/\//i.test(website_url)
      ? website_url
      : `https://${website_url}`;

    console.log("Launching Playwright Chromium...");
    const browser = await chromium.launch();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    page.setDefaultNavigationTimeout(30000);
    console.log("Going to website (FAST commit):", normalizedUrl);
    await page
      .goto(normalizedUrl, { waitUntil: "commit", timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(2000);

    await page.screenshot({ path: screenshotPath, fullPage: false });
    await browser.close();
    console.log("Screenshot saved to", screenshotPath);

    // 3) Get audio duration
    const durationSec = await getAudioDurationSeconds(audioPath);

    // 4) ffmpeg to create video
    const ffmpegArgs = [
      "-loop",
      "1",
      "-y",
      "-i",
      screenshotPath,
      "-i",
      audioPath,
      "-c:v",
      "libx264",
      "-t",
      String(durationSec),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      "-r",
      "30",
      outPath,
    ];

    console.log("Running ffmpeg with args:", ffmpegArgs.join(" "));
    try {
      const { stdout, stderr } = await execFileAsync("ffmpeg", ffmpegArgs);
      if (stdout) console.log("ffmpeg stdout:", stdout);
      if (stderr) console.log("ffmpeg stderr:", stderr);
    } catch (err) {
      console.error("ffmpeg error:", err);
      return res.status(500).json({
        error: "ffmpeg failed",
        details: err.stderr || err.message || String(err),
        args: ffmpegArgs,
      });
    }

    console.log("Reading output file:", outPath);
    const mp4 = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(mp4);
    console.log("Video sent to client");
  } catch (err) {
    console.error("Unexpected error in /api/render:", err);
    res.status(500).json({
      error: "internal error",
      details: err.message || String(err),
    });
  } finally {
    try {
      if (fs.existsSync(tmpDir)) {
        console.log("Cleaning up temp dir:", tmpDir);
        fs.readdirSync(tmpDir).forEach((file) => {
          try {
            fs.unlinkSync(path.join(tmpDir, file));
          } catch {}
        });
        fs.rmdirSync(tmpDir);
      }
    } catch (cleanupErr) {
      console.error("Error during cleanup:", cleanupErr);
    }
    console.log("----- /api/render finished -----");
  }
}

